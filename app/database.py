import calendar
import sqlite3
import os
from contextlib import contextmanager
from datetime import date

DB_PATH = os.environ.get("DB_PATH", "/data/finance.db")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                description TEXT NOT NULL,
                amount REAL NOT NULL,
                type TEXT NOT NULL DEFAULT 'expense',
                category TEXT DEFAULT 'Uncategorized',
                source TEXT NOT NULL,
                month_year TEXT NOT NULL,
                notes TEXT DEFAULT '',
                is_split INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                amount REAL NOT NULL,
                due_day INTEGER,
                is_active INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS bill_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
                month_year TEXT NOT NULL,
                paid INTEGER DEFAULT 0,
                UNIQUE(bill_id, month_year)
            );

            CREATE TABLE IF NOT EXISTS monthly_income (
                month_year TEXT PRIMARY KEY,
                income REAL NOT NULL DEFAULT 0,
                savings_target REAL NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)

    # Migrations for existing databases
    with get_db() as conn:
        for stmt in [
            "ALTER TABLE monthly_income ADD COLUMN savings_target REAL NOT NULL DEFAULT 0",
            "ALTER TABLE transactions ADD COLUMN is_split INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(stmt)
            except Exception:
                pass  # column already exists


# --- Transactions ---

def get_transactions(month_year: str) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM transactions WHERE month_year = ? ORDER BY date DESC",
            (month_year,)
        ).fetchall()
        return [dict(r) for r in rows]


def insert_transaction(tx: dict) -> int:
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO transactions (date, description, amount, type, category, source, month_year, is_split)
               VALUES (:date, :description, :amount, :type, :category, :source, :month_year, :is_split)""",
            tx
        )
        return cur.lastrowid


def split_capital_one_transactions(month_year: str) -> int:
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, amount FROM transactions
               WHERE month_year = ? AND source = 'capital_one' AND type = 'expense' AND is_split = 0""",
            (month_year,)
        ).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE transactions SET amount = ?, is_split = 1 WHERE id = ?",
                (round(r["amount"] / 2, 2), r["id"])
            )
        return len(rows)


def update_transaction(tx_id: int, fields: dict):
    allowed = {"date", "description", "amount", "type", "category", "source", "notes"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    if "date" in updates:
        from datetime import datetime as _dt
        updates["month_year"] = _dt.strptime(updates["date"], "%Y-%m-%d").strftime("%Y-%m")
    sets = ", ".join(f"{k} = ?" for k in updates)
    with get_db() as conn:
        conn.execute(f"UPDATE transactions SET {sets} WHERE id = ?", (*updates.values(), tx_id))


def delete_transaction(tx_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))


def delete_transactions_bulk(ids: list[int]) -> int:
    with get_db() as conn:
        placeholders = ",".join("?" * len(ids))
        result = conn.execute(f"DELETE FROM transactions WHERE id IN ({placeholders})", ids)
        return result.rowcount


def get_months() -> list[str]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT month_year FROM transactions ORDER BY month_year DESC"
        ).fetchall()
        return [r[0] for r in rows]


# --- Dashboard ---

def get_dashboard(month_year: str) -> dict:
    with get_db() as conn:
        year, month = map(int, month_year.split('-'))
        days_in_month = calendar.monthrange(year, month)[1]
        month_abbr = date(year, month, 1).strftime('%b')
        today = date.today()

        # Total spending (expenses only)
        spending_row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE month_year = ? AND type = 'expense'",
            (month_year,)
        ).fetchone()
        total_spending = spending_row[0]

        # Spending by category (expenses only)
        cat_rows = conn.execute(
            """SELECT category, SUM(amount) as total FROM transactions
               WHERE month_year = ? AND type = 'expense'
               GROUP BY category ORDER BY total DESC""",
            (month_year,)
        ).fetchall()
        categories = [{"category": r["category"], "amount": r["total"]} for r in cat_rows]

        # Income + savings_target for month (fall back to defaults from settings)
        mi_row = conn.execute(
            "SELECT income, savings_target FROM monthly_income WHERE month_year = ?", (month_year,)
        ).fetchone()

        default_income_row = conn.execute(
            "SELECT value FROM settings WHERE key = 'default_income'"
        ).fetchone()
        default_savings_row = conn.execute(
            "SELECT value FROM settings WHERE key = 'default_savings'"
        ).fetchone()

        if mi_row:
            income = mi_row["income"] if mi_row["income"] else (
                float(default_income_row["value"]) if default_income_row else 0.0
            )
            savings_target = mi_row["savings_target"] if mi_row["savings_target"] else (
                float(default_savings_row["value"]) if default_savings_row else 0.0
            )
        else:
            income = float(default_income_row["value"]) if default_income_row else 0.0
            savings_target = float(default_savings_row["value"]) if default_savings_row else 0.0

        # Bills with payment status
        bill_rows = conn.execute("SELECT * FROM bills WHERE is_active = 1").fetchall()
        bills = []
        bills_total = 0.0
        bills_paid = 0
        for b in bill_rows:
            payment = conn.execute(
                "SELECT paid FROM bill_payments WHERE bill_id = ? AND month_year = ?",
                (b["id"], month_year)
            ).fetchone()
            paid = bool(payment and payment["paid"])
            bills.append({
                "bill_id": b["id"],
                "name": b["name"],
                "amount": b["amount"],
                "due_day": b["due_day"],
                "paid": paid,
            })
            bills_total += b["amount"]
            if paid:
                bills_paid += 1

        # Left over = income - spending - bills - savings
        net_after_savings = income - total_spending - bills_total - savings_target
        # Total spendable budget (income minus fixed obligations)
        total_spendable = max(0.0, income - bills_total - savings_target)

        # Weekly breakdown
        tx_rows = conn.execute(
            "SELECT date, amount FROM transactions WHERE month_year = ? AND type = 'expense'",
            (month_year,)
        ).fetchall()
        tx_by_date: dict[str, float] = {}
        for r in tx_rows:
            tx_by_date[r["date"]] = tx_by_date.get(r["date"], 0.0) + r["amount"]

        weeks = []
        day = 1
        while day <= days_in_month:
            week_start_day = day
            week_end_day = min(day + 6, days_in_month)
            days_in_week = week_end_day - week_start_day + 1

            week_budget = round(total_spendable * days_in_week / days_in_month, 2) if days_in_month else 0.0

            week_start_date = date(year, month, week_start_day)
            week_end_date = date(year, month, week_end_day)

            week_spent = 0.0
            for d_str, amt in tx_by_date.items():
                d = date.fromisoformat(d_str)
                if week_start_date <= d <= week_end_date:
                    week_spent += amt
            week_spent = round(week_spent, 2)

            if week_end_date < today:
                status = "past"
            elif week_start_date <= today <= week_end_date:
                status = "current"
            else:
                status = "future"

            if week_start_day == week_end_day:
                label = f"{month_abbr} {week_start_day}"
            else:
                label = f"{month_abbr} {week_start_day}–{week_end_day}"

            weeks.append({
                "label": label,
                "budget": week_budget,
                "spent": week_spent,
                "remaining": round(week_budget - week_spent, 2),
                "status": status,
            })

            day = week_end_day + 1

        return {
            "income": income,
            "total_spending": round(total_spending, 2),
            "bills_total": round(bills_total, 2),
            "bills_paid": bills_paid,
            "bills_count": len(bills),
            "savings_target": round(savings_target, 2),
            "net_after_savings": round(net_after_savings, 2),
            "total_spendable": round(total_spendable, 2),
            "categories": categories,
            "bill_payments": bills,
            "weeks": weeks,
        }


# --- Bills ---

def get_bills() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM bills WHERE is_active = 1 ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def insert_bill(bill: dict) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO bills (name, amount, due_day) VALUES (:name, :amount, :due_day)",
            bill
        )
        return cur.lastrowid


def delete_bill(bill_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM bills WHERE id = ?", (bill_id,))


# --- Bill Payments ---

def toggle_bill_payment(bill_id: int, month_year: str) -> bool:
    with get_db() as conn:
        existing = conn.execute(
            "SELECT paid FROM bill_payments WHERE bill_id = ? AND month_year = ?",
            (bill_id, month_year)
        ).fetchone()
        if existing:
            new_paid = 0 if existing["paid"] else 1
            conn.execute(
                "UPDATE bill_payments SET paid = ? WHERE bill_id = ? AND month_year = ?",
                (new_paid, bill_id, month_year)
            )
        else:
            new_paid = 1
            conn.execute(
                "INSERT INTO bill_payments (bill_id, month_year, paid) VALUES (?, ?, 1)",
                (bill_id, month_year)
            )
        return bool(new_paid)


# --- Income & Savings ---

def set_income(month_year: str, income: float):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO monthly_income (month_year, income, savings_target) VALUES (?, ?, 0)
               ON CONFLICT(month_year) DO UPDATE SET income = excluded.income""",
            (month_year, income)
        )


def set_savings_target(month_year: str, savings_target: float):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO monthly_income (month_year, income, savings_target) VALUES (?, 0, ?)
               ON CONFLICT(month_year) DO UPDATE SET savings_target = excluded.savings_target""",
            (month_year, savings_target)
        )


# --- Annual Summary ---

def get_annual_summary(year: int) -> dict:
    with get_db() as conn:
        year_prefix = f"{year}-%"

        def _setting(key):
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return float(row["value"]) if row else 0.0

        default_income = _setting("default_income")
        default_savings = _setting("default_savings")

        # Spending per month
        spending_rows = conn.execute(
            """SELECT month_year, ROUND(SUM(amount), 2) as spending
               FROM transactions WHERE month_year LIKE ? AND type='expense'
               GROUP BY month_year""",
            (year_prefix,)
        ).fetchall()
        spending_by_month = {r["month_year"]: r["spending"] for r in spending_rows}

        # Income + savings overrides per month
        mi_rows = conn.execute(
            "SELECT month_year, income, savings_target FROM monthly_income WHERE month_year LIKE ?",
            (year_prefix,)
        ).fetchall()
        mi_by_month = {r["month_year"]: r for r in mi_rows}

        # Bills (global, same every month)
        bills_total = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM bills WHERE is_active=1"
        ).fetchone()[0]

        # Build all 12 months
        months = []
        totals = {"income": 0.0, "spending": 0.0, "bills": 0.0, "savings": 0.0, "net": 0.0}

        for m in range(1, 13):
            my = f"{year}-{m:02d}"
            has_data = my in spending_by_month
            spending = spending_by_month.get(my, 0.0)
            mi = mi_by_month.get(my)
            income = (mi["income"] or default_income) if mi else default_income
            savings = (mi["savings_target"] or default_savings) if mi else default_savings
            net = round(income - spending - bills_total - savings, 2)

            months.append({
                "month_year": my,
                "has_data": has_data,
                "income": income,
                "spending": round(spending, 2),
                "bills": round(bills_total, 2),
                "savings": savings,
                "net": net,
            })

            if has_data:
                totals["income"] += income
                totals["spending"] += spending
                totals["bills"] += bills_total
                totals["savings"] += savings
                totals["net"] += net

        # Merchants (all expense transactions for the year)
        merchant_rows = conn.execute(
            """SELECT description, COUNT(*) as count, ROUND(SUM(amount), 2) as total
               FROM transactions WHERE month_year LIKE ? AND type='expense'
               GROUP BY description ORDER BY total DESC""",
            (year_prefix,)
        ).fetchall()

        return {
            "year": year,
            "months": months,
            "total_income": round(totals["income"], 2),
            "total_spending": round(totals["spending"], 2),
            "total_bills": round(totals["bills"], 2),
            "total_savings": round(totals["savings"], 2),
            "total_net": round(totals["net"], 2),
            "merchants": [dict(r) for r in merchant_rows],
        }


def rename_merchants(from_names: list[str], to_name: str) -> int:
    with get_db() as conn:
        placeholders = ",".join("?" * len(from_names))
        result = conn.execute(
            f"UPDATE transactions SET description = ? WHERE description IN ({placeholders})",
            [to_name, *from_names]
        )
        return result.rowcount


def delete_source_month_transactions(source: str, months: list[str]):
    with get_db() as conn:
        placeholders = ",".join("?" * len(months))
        conn.execute(
            f"DELETE FROM transactions WHERE source = ? AND month_year IN ({placeholders})",
            [source, *months]
        )


# --- Settings ---

def get_setting(key: str) -> str | None:
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value)
        )
