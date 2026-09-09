import csv
import io
import os
from datetime import datetime

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse
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


def _asset_version(filename: str) -> str:
    """Cache-busting token from the file's mtime, so updates load without a hard refresh."""
    try:
        return str(int(os.path.getmtime(os.path.join(STATIC_DIR, filename))))
    except OSError:
        return "1"


@app.get("/")
def index():
    with open(os.path.join(STATIC_DIR, "index.html")) as f:
        html = f.read()
    html = html.replace('href="static/style.css"',
                        f'href="static/style.css?v={_asset_version("style.css")}"')
    html = html.replace('src="static/app.js"',
                        f'src="static/app.js?v={_asset_version("app.js")}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


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


class TransactionCreate(BaseModel):
    date: str
    description: str
    amount: float
    type: str = 'expense'
    category: str = 'Uncategorized'
    source: str = 'manual'
    notes: str = ''


@app.post("/api/transactions")
def create_transaction(body: TransactionCreate):
    month_year = body.date[:7]
    tx = {**body.model_dump(), 'month_year': month_year}
    tx_id = db.insert_transaction(tx)
    db.apply_bill_matching(month_year)
    db.apply_category_rules(month_year)
    return {"id": tx_id, "month_year": month_year}


class TransactionUpdate(BaseModel):
    date: str | None = None
    description: str | None = None
    amount: float | None = None
    type: str | None = None
    category: str | None = None
    source: str | None = None
    notes: str | None = None
    exclude_from_spending: int | None = None


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
async def upload_csv(file: UploadFile = File(...), replace: bool = False):
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
        parsed.append(tx)

    if not parsed:
        raise HTTPException(400, "No valid transactions found in CSV")

    if replace:
        months = list({tx["month_year"] for tx in parsed})
        db.delete_source_month_transactions(source, months)

    for tx in parsed:
        db.insert_transaction(tx)

    # Auto-apply bill keyword matching and category rules for every affected month
    affected_months = list({tx["month_year"] for tx in parsed})
    for month in affected_months:
        db.apply_bill_matching(month)
        db.apply_category_rules(month)

    month_year = max(tx["month_year"] for tx in parsed)
    return {"imported": len(parsed), "month_year": month_year, "source": source, "replaced": replace}


class TransactionBatch(BaseModel):
    transactions: list[TransactionCreate]


@app.post("/api/transactions/batch")
def create_transactions_batch(body: TransactionBatch):
    months = set()
    for t in body.transactions:
        month_year = t.date[:7]
        tx = {**t.model_dump(), 'month_year': month_year}
        db.insert_transaction(tx)
        months.add(month_year)
    for month in months:
        db.apply_bill_matching(month)
        db.apply_category_rules(month)
    return {"count": len(body.transactions), "months": sorted(months)}


@app.post("/api/transactions/{month_year}/apply-bill-matching")
def apply_bill_matching(month_year: str):
    count = db.apply_bill_matching(month_year)
    return {"count": count}


@app.post("/api/transactions/{month_year}/apply-category-rules")
def apply_category_rules(month_year: str):
    count = db.apply_category_rules(month_year)
    return {"count": count}


# --- Annual ---

@app.get("/api/annual/{year}")
def annual_summary(year: int):
    return db.get_annual_summary(year)


class MerchantRename(BaseModel):
    from_names: list[str]
    to_name: str


@app.get("/api/merchants/transactions")
def merchant_transactions(name: str = "", year: int = None, key: str = ""):
    """Transactions for a merchant group (`key`), or one exact description."""
    txs = db.get_merchant_transactions(name, year, group_key=key or None)
    return {"transactions": txs}


@app.post("/api/merchants/rename")
def rename_merchants(body: MerchantRename):
    """Legacy: rewrites the stored descriptions. Prefer /api/merchants/merge."""
    count = db.rename_merchants(body.from_names, body.to_name)
    return {"count": count}


class MerchantMerge(BaseModel):
    keys: list[str]
    name: str


@app.post("/api/merchants/merge")
def merge_merchants(body: MerchantMerge):
    """Group several merchants under one name without touching transactions."""
    count = db.merge_merchant_groups(body.keys, body.name)
    return {"count": count}


class MerchantKey(BaseModel):
    key: str


@app.post("/api/merchants/unmerge")
def unmerge_merchant(body: MerchantKey):
    count = db.unmerge_merchant_group(body.key)
    return {"count": count}


class SuggestionDismiss(BaseModel):
    keys: list[str]


@app.post("/api/merchants/dismiss-suggestion")
def dismiss_suggestion(body: SuggestionDismiss):
    if len(body.keys) != 2:
        raise HTTPException(400, "Expected exactly two merchant keys")
    db.dismiss_merchant_suggestion(body.keys[0], body.keys[1])
    return {"ok": True}


@app.get("/api/merchants/aliases")
def list_merchant_aliases():
    return {"aliases": db.get_merchant_aliases()}


def detect_format(headers: list[str]):
    h = {h.lower().strip() for h in headers}
    if "debit" in h and "credit" in h:
        return "capital_one", parse_capital_one
    if "amount" in h and "transaction date" in {x.lower() for x in headers}:
        return "chase", parse_chase
    return None, None


# Description fragments that identify a credit-side line as a card payment
# (paying down the balance) rather than a merchant refund/return.
_PAYMENT_KEYWORDS = (
    "payment thank you",
    "autopay",
    "auto pay",
    "online payment",
    "mobile pymt",
    "pymt",
    "capital one mobile",
    "capital one autopay",
    "web payment",
    "electronic payment",
)


def _looks_like_card_payment(description: str) -> bool:
    d = description.lower()
    return any(k in d for k in _PAYMENT_KEYWORDS)


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
        # Bucket by posted date so a statement export lands entirely in the
        # month the bank posted it (prevents cross-month Replace deletions).
        # Fall back to the transaction date if a row has no post date (pending).
        raw_date = row.get("Post Date", "").strip() or row.get("Transaction Date", "").strip()
        if not raw_date:
            return None
        date, month_year = parse_date(raw_date)
        description = row.get("Description", "").strip()
        amount_str = row.get("Amount", "0").strip().replace(",", "")
        amount = float(amount_str)
        category = row.get("Category", "Uncategorized").strip() or "Uncategorized"
        raw_type = row.get("Type", "").strip().lower()

        # Chase: negative = charge (expense), positive = credit.
        # A credit is either a card payment (excluded from spending) or a
        # refund/return, which must credit back against its category's spending.
        if amount < 0:
            tx_type = "expense"
            tx_amount = abs(amount)
        elif raw_type == "payment" or _looks_like_card_payment(description):
            tx_type = "payment"
            tx_amount = amount
        else:
            # Refund/return: store as a negative expense so it nets against
            # the category and the monthly spending total.
            tx_type = "expense"
            tx_amount = -amount

        return {
            "date": date,
            "description": description,
            "amount": tx_amount,
            "type": tx_type,
            "category": category,
            "source": "chase",
            "month_year": month_year,
        }
    except (ValueError, KeyError):
        return None


def parse_capital_one(row: dict) -> dict | None:
    # CapOne headers: Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit
    try:
        # Bucket by posted date so a statement export lands entirely in the
        # month the bank posted it (prevents cross-month Replace deletions).
        # Fall back to the transaction date if a row has no posted date (pending).
        raw_date = row.get("Posted Date", "").strip() or row.get("Transaction Date", "").strip()
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
            # A credit is either a card payment (excluded from spending) or a
            # refund/return, which must credit back against its category.
            if _looks_like_card_payment(description):
                tx_type = "payment"
                tx_amount = float(credit_str)
            else:
                # Refund/return: negative expense nets against the category.
                tx_type = "expense"
                tx_amount = -float(credit_str)
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
        }
    except (ValueError, KeyError):
        return None


# --- Category Rules ---

@app.get("/api/category-rules")
def list_category_rules():
    return {"rules": db.get_category_rules()}


class CategoryRuleCreate(BaseModel):
    keyword: str
    category: str


@app.post("/api/category-rules")
def create_category_rule(body: CategoryRuleCreate):
    rule_id = db.insert_category_rule(body.keyword, body.category)
    return {"id": rule_id}


@app.delete("/api/category-rules/{rule_id}")
def remove_category_rule(rule_id: int):
    db.delete_category_rule(rule_id)
    return {"ok": True}


# --- Bills ---

class BillCreate(BaseModel):
    name: str
    amount: float
    due_day: int | None = None
    match_keyword: str | None = None


@app.get("/api/bills")
def list_bills():
    return {"bills": db.get_bills()}


@app.post("/api/bills")
def create_bill(body: BillCreate):
    bill_id = db.insert_bill(body.model_dump())
    return {"id": bill_id}


class BillUpdate(BaseModel):
    name: str | None = None
    amount: float | None = None
    due_day: int | None = None
    match_keyword: str | None = None


@app.put("/api/bills/{bill_id}")
def update_bill(bill_id: int, body: BillUpdate):
    db.update_bill(bill_id, body.model_dump(exclude_none=True))
    return {"ok": True}


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


class IncomeEntryAdd(BaseModel):
    amount: float
    label: str = ""


@app.get("/api/income/{month_year}/entries")
def get_income_entries(month_year: str):
    entries = db.get_income_entries(month_year)
    total = round(sum(e["amount"] for e in entries), 2)
    return {"entries": entries, "total": total}


@app.post("/api/income/{month_year}/entries")
def add_income_entry(month_year: str, body: IncomeEntryAdd):
    entry_id = db.add_income_entry(month_year, body.label.strip(), body.amount)
    return {"ok": True, "id": entry_id}


@app.put("/api/income/entries/{entry_id}")
def update_income_entry(entry_id: int, body: IncomeEntryAdd):
    db.update_income_entry(entry_id, body.label.strip(), body.amount)
    return {"ok": True}


@app.delete("/api/income/entries/{entry_id}")
def delete_income_entry(entry_id: int):
    db.delete_income_entry(entry_id)
    return {"ok": True}


@app.post("/api/income/{month_year}/save-template")
def save_income_template(month_year: str):
    count = db.set_income_template_from_month(month_year)
    return {"ok": True, "count": count}


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
