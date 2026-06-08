import csv
import io
import os
from datetime import datetime

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db

app = FastAPI()

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@app.on_event("startup")
def startup():
    os.makedirs("/data", exist_ok=True)
    db.init_db()


# --- Static files ---

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# --- Months ---

@app.get("/api/months")
def list_months():
    return {"months": db.get_months()}


# --- Dashboard ---

@app.get("/api/dashboard/{month_year}")
def dashboard(month_year: str):
    return db.get_dashboard(month_year)


# --- Transactions ---

@app.get("/api/transactions/{month_year}")
def list_transactions(month_year: str):
    return {"transactions": db.get_transactions(month_year)}


class TransactionUpdate(BaseModel):
    date: str | None = None
    description: str | None = None
    amount: float | None = None
    type: str | None = None
    category: str | None = None
    source: str | None = None
    notes: str | None = None


@app.put("/api/transactions/{tx_id}")
def update_transaction(tx_id: int, body: TransactionUpdate):
    db.update_transaction(tx_id, body.model_dump(exclude_none=True))
    return {"ok": True}


class BulkDelete(BaseModel):
    ids: list[int]


@app.delete("/api/transactions/bulk")
def delete_transactions_bulk(body: BulkDelete):
    count = db.delete_transactions_bulk(body.ids)
    return {"count": count}


@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    db.delete_transaction(tx_id)
    return {"ok": True}


@app.post("/api/transactions/upload")
async def upload_csv(file: UploadFile = File(...), split: bool = False, replace: bool = False):
    content = await file.read()
    text = content.decode("utf-8-sig")  # handle BOM from Excel exports

    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip() for h in (reader.fieldnames or [])]

    source, parser = detect_format(headers)
    if not parser:
        raise HTTPException(400, f"Unrecognized CSV format. Headers: {headers}")

    # Parse all rows first so we know the months before deleting anything
    parsed = []
    for row in reader:
        tx = parser(row)
        if tx is None:
            continue
        tx["is_split"] = 0
        if split and source == "capital_one" and tx["type"] == "expense":
            tx["amount"] = round(tx["amount"] / 2, 2)
            tx["is_split"] = 1
        parsed.append(tx)

    if not parsed:
        raise HTTPException(400, "No valid transactions found in CSV")

    if replace:
        months = list({tx["month_year"] for tx in parsed})
        db.delete_source_month_transactions(source, months)

    for tx in parsed:
        db.insert_transaction(tx)

    month_year = max(tx["month_year"] for tx in parsed)
    return {"imported": len(parsed), "month_year": month_year, "source": source, "replaced": replace}


@app.post("/api/transactions/{month_year}/split-capital-one")
def split_capital_one(month_year: str):
    count = db.split_capital_one_transactions(month_year)
    return {"count": count}


# --- Annual ---

@app.get("/api/annual/{year}")
def annual_summary(year: int):
    return db.get_annual_summary(year)


class MerchantRename(BaseModel):
    from_names: list[str]
    to_name: str


@app.get("/api/merchants/transactions")
def merchant_transactions(name: str, year: int = None):
    return {"transactions": db.get_merchant_transactions(name, year)}


@app.post("/api/merchants/rename")
def rename_merchants(body: MerchantRename):
    count = db.rename_merchants(body.from_names, body.to_name)
    return {"count": count}


def detect_format(headers: list[str]):
    h = {h.lower().strip() for h in headers}
    if "debit" in h and "credit" in h:
        return "capital_one", parse_capital_one
    if "amount" in h and "transaction date" in {x.lower() for x in headers}:
        return "chase", parse_chase
    return None, None


def parse_date(date_str: str) -> tuple[str, str]:
    date_str = date_str.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            d = datetime.strptime(date_str, fmt)
            return d.strftime("%Y-%m-%d"), d.strftime("%Y-%m")
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date: {date_str}")


def parse_chase(row: dict) -> dict | None:
    # Chase headers: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
    try:
        raw_date = row.get("Transaction Date", "").strip()
        if not raw_date:
            return None
        date, month_year = parse_date(raw_date)
        description = row.get("Description", "").strip()
        amount_str = row.get("Amount", "0").strip().replace(",", "")
        amount = float(amount_str)
        category = row.get("Category", "Uncategorized").strip() or "Uncategorized"

        # Chase: negative = expense, positive = payment/credit
        if amount < 0:
            tx_type = "expense"
            tx_amount = abs(amount)
        else:
            tx_type = "payment"
            tx_amount = amount

        return {
            "date": date,
            "description": description,
            "amount": tx_amount,
            "type": tx_type,
            "category": category,
            "source": "chase",
            "month_year": month_year,
            "is_split": 0,
        }
    except (ValueError, KeyError):
        return None


def parse_capital_one(row: dict) -> dict | None:
    # CapOne headers: Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit
    try:
        raw_date = row.get("Transaction Date", "").strip()
        if not raw_date:
            return None
        date, month_year = parse_date(raw_date)
        description = row.get("Description", "").strip()
        category = row.get("Category", "Uncategorized").strip() or "Uncategorized"

        debit_str = row.get("Debit", "").strip().replace(",", "")
        credit_str = row.get("Credit", "").strip().replace(",", "")

        if debit_str:
            tx_type = "expense"
            tx_amount = float(debit_str)
        elif credit_str:
            tx_type = "payment"
            tx_amount = float(credit_str)
        else:
            return None

        return {
            "date": date,
            "description": description,
            "amount": tx_amount,
            "type": tx_type,
            "category": category,
            "source": "capital_one",
            "month_year": month_year,
            "is_split": 0,
        }
    except (ValueError, KeyError):
        return None


# --- Bills ---

class BillCreate(BaseModel):
    name: str
    amount: float
    due_day: int | None = None


@app.get("/api/bills")
def list_bills():
    return {"bills": db.get_bills()}


@app.post("/api/bills")
def create_bill(body: BillCreate):
    bill_id = db.insert_bill(body.model_dump())
    return {"id": bill_id}


@app.delete("/api/bills/{bill_id}")
def remove_bill(bill_id: int):
    db.delete_bill(bill_id)
    return {"ok": True}


# --- Bill payments ---

@app.post("/api/bill-payments/{month_year}/{bill_id}/toggle")
def toggle_payment(month_year: str, bill_id: int):
    paid = db.toggle_bill_payment(bill_id, month_year)
    return {"paid": paid}


# --- Income ---

class IncomeSet(BaseModel):
    income: float


@app.post("/api/income/{month_year}")
def set_income(month_year: str, body: IncomeSet):
    db.set_income(month_year, body.income)
    return {"ok": True}


class SavingsSet(BaseModel):
    savings_target: float


@app.post("/api/savings/{month_year}")
def set_savings(month_year: str, body: SavingsSet):
    db.set_savings_target(month_year, body.savings_target)
    return {"ok": True}


# --- Settings ---

class SettingSet(BaseModel):
    value: float


@app.get("/api/settings/{key}")
def get_setting(key: str):
    val = db.get_setting(key)
    return {"value": float(val) if val is not None else None}


@app.post("/api/settings/{key}")
def set_setting(key: str, body: SettingSet):
    db.set_setting(key, str(body.value))
    return {"ok": True}
