import calendar
import sqlite3
import os

import merchants
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
                exclude_from_spending INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                amount REAL NOT NULL,
                due_day INTEGER,
                match_keyword TEXT,
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

            CREATE TABLE IF NOT EXISTS income_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month_year TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                amount REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS income_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL DEFAULT '',
                amount REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS merchant_aliases (
                norm_key TEXT PRIMARY KEY,
                display_name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS merchant_dismissals (
                key_a TEXT NOT NULL,
                key_b TEXT NOT NULL,
                PRIMARY KEY (key_a, key_b)
            );

            CREATE TABLE IF NOT EXISTS category_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL
            );
        """)

    # Migrations for existing databases
    with get_db() as conn:
        for stmt in [
            "ALTER TABLE monthly_income ADD COLUMN savings_target REAL NOT NULL DEFAULT 0",
            "ALTER TABLE transactions ADD COLUMN exclude_from_spending INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE bills ADD COLUMN match_keyword TEXT",
        ]:
            try:
                conn.execute(stmt)
            except Exception:
                pass  # column already exists

    # Seed the recurring income template from the most recent month that has
    # entries, so existing setups get a template to prepopulate future months.
    with get_db() as conn:
        has_template = conn.execute("SELECT COUNT(*) FROM income_templates").fetchone()[0]
        if not has_template:
            latest = conn.execute(
                "SELECT month_year FROM income_entries ORDER BY month_year DESC LIMIT 1"
            ).fetchone()
            if latest:
                conn.execute(
                    "INSERT INTO income_templates (label, amount) "
                    "SELECT label, amount FROM income_entries WHERE month_year = ?",
                    (latest["month_year"],)
                )

    # Seed default category rules
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO category_rules (keyword, category) VALUES (?, ?)",
            ("kroger", "Groceries")
        )


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
            """INSERT INTO transactions (date, description, amount, type, category, source, month_year, notes)
               VALUES (:date, :description, :amount, :type, :category, :source, :month_year, :notes)""",
            {**tx, 'notes': tx.get('notes', '')}
        )
        return cur.lastrowid


def update_transaction(tx_id: int, fields: dict):
    allowed = {"date", "description", "amount", "type", "category", "source", "notes", "exclude_from_spending"}
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

        # Total spending (expenses only, excluding bill-matched transactions)
        spending_row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE month_year = ? AND type = 'expense' AND exclude_from_spending = 0",
            (month_year,)
        ).fetchone()
        total_spending = spending_row[0]

        # Spending by category (expenses only, excluding bill-matched)
        cat_rows = conn.execute(
            """SELECT category, SUM(amount) as total FROM transactions
               WHERE month_year = ? AND type = 'expense' AND exclude_from_spending = 0
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

        # Precedence: this month's line-item entries > recurring template > single-value/default
        entries_total, entries_count = _income_entries_total(conn, month_year)
        if entries_count:
            income = entries_total
        else:
            template_total, template_count = _income_template_total(conn)
            if template_count:
                income = template_total

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

        # Money actually saved this month = income - spending - bills (before the savings goal)
        saved_this_month = income - total_spending - bills_total
        # Left over = income - spending - bills - savings
        net_after_savings = income - total_spending - bills_total - savings_target
        # Total spendable budget (income minus fixed obligations)
        total_spendable = max(0.0, income - bills_total - savings_target)

        # Weekly breakdown
        tx_rows = conn.execute(
            "SELECT date, amount FROM transactions WHERE month_year = ? AND type = 'expense' AND exclude_from_spending = 0",
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
            "saved_this_month": round(saved_this_month, 2),
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
            "INSERT INTO bills (name, amount, due_day, match_keyword) VALUES (:name, :amount, :due_day, :match_keyword)",
            bill
        )
        return cur.lastrowid


def apply_bill_matching(month_year: str) -> int:
    with get_db() as conn:
        bill_rows = conn.execute(
            "SELECT match_keyword FROM bills WHERE is_active = 1 AND match_keyword IS NOT NULL AND TRIM(match_keyword) != ''"
        ).fetchall()
        if not bill_rows:
            return 0
        # Each bill can have comma-separated keywords e.g. "NETFLIX, NETFLIX.COM"
        keywords = [
            kw.strip().lower()
            for r in bill_rows
            for kw in r["match_keyword"].split(",")
            if kw.strip()
        ]

        tx_rows = conn.execute(
            "SELECT id, description FROM transactions WHERE month_year = ? AND type = 'expense'",
            (month_year,)
        ).fetchall()

        count = 0
        for tx in tx_rows:
            desc_lower = tx["description"].lower()
            # Check both directions: keyword in description OR description in keyword (handles bank truncation)
            matched = any(kw in desc_lower or desc_lower in kw for kw in keywords)
            new_val = 1 if matched else 0
            conn.execute(
                "UPDATE transactions SET exclude_from_spending = ? WHERE id = ?",
                (new_val, tx["id"])
            )
            if matched:
                count += 1
        return count


def update_bill(bill_id: int, fields: dict):
    allowed = {"name", "amount", "due_day", "match_keyword"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    sets = ", ".join(f"{k} = ?" for k in updates)
    with get_db() as conn:
        conn.execute(f"UPDATE bills SET {sets} WHERE id = ?", (*updates.values(), bill_id))


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

def _income_entries_total(conn, month_year: str) -> tuple[float, int]:
    """Return (sum_of_amounts, count) of income entries for the month."""
    row = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM income_entries WHERE month_year = ?",
        (month_year,)
    ).fetchone()
    return (round(row["total"], 2), row["n"])


def _income_template_total(conn) -> tuple[float, int]:
    """Return (sum_of_amounts, count) of the recurring income template."""
    row = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM income_templates"
    ).fetchone()
    return (round(row["total"], 2), row["n"])


def _seed_month_from_template(conn, month_year: str):
    """Copy the recurring template into a month that has no entries yet."""
    has = conn.execute(
        "SELECT 1 FROM income_entries WHERE month_year = ? LIMIT 1", (month_year,)
    ).fetchone()
    if not has:
        conn.execute(
            "INSERT INTO income_entries (month_year, label, amount) "
            "SELECT ?, label, amount FROM income_templates ORDER BY id",
            (month_year,)
        )


def get_income_entries(month_year: str) -> list[dict]:
    """Return a month's income entries, seeding from the recurring template if empty."""
    with get_db() as conn:
        _seed_month_from_template(conn, month_year)
        rows = conn.execute(
            "SELECT id, month_year, label, amount FROM income_entries WHERE month_year = ? ORDER BY id",
            (month_year,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_income_template() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, label, amount FROM income_templates ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


def set_income_template_from_month(month_year: str) -> int:
    """Replace the recurring template with the given month's current entries."""
    with get_db() as conn:
        conn.execute("DELETE FROM income_templates")
        conn.execute(
            "INSERT INTO income_templates (label, amount) "
            "SELECT label, amount FROM income_entries WHERE month_year = ? ORDER BY id",
            (month_year,)
        )
        return conn.execute("SELECT COUNT(*) FROM income_templates").fetchone()[0]


def add_income_entry(month_year: str, label: str, amount: float) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO income_entries (month_year, label, amount) VALUES (?, ?, ?)",
            (month_year, label, amount)
        )
        return cur.lastrowid


def update_income_entry(entry_id: int, label: str, amount: float):
    with get_db() as conn:
        conn.execute(
            "UPDATE income_entries SET label = ?, amount = ? WHERE id = ?",
            (label, amount, entry_id)
        )


def delete_income_entry(entry_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM income_entries WHERE id = ?", (entry_id,))


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

        # Spending per month (excluding bill-matched)
        spending_rows = conn.execute(
            """SELECT month_year, ROUND(SUM(amount), 2) as spending
               FROM transactions WHERE month_year LIKE ? AND type='expense' AND exclude_from_spending = 0
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

        # Income entries summed per month (take precedence over single-value/default income)
        entry_rows = conn.execute(
            "SELECT month_year, ROUND(SUM(amount), 2) AS total FROM income_entries WHERE month_year LIKE ? GROUP BY month_year",
            (year_prefix,)
        ).fetchall()
        entries_by_month = {r["month_year"]: r["total"] for r in entry_rows}

        # Recurring template income (projected onto months without their own entries)
        template_total, template_count = _income_template_total(conn)

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
            if template_count:
                income = template_total
            if my in entries_by_month:
                income = entries_by_month[my]
            savings = (mi["savings_target"] or default_savings) if mi else default_savings
            # Net = actual amount saved (or overspent) at month end, before the savings goal
            net = round(income - spending - bills_total, 2)

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

        # Merchants (expense transactions for the year, excluding bill-matched).
        # Raw descriptions are collapsed into vendor groups so "Kroger",
        # "KROGER #445" and "kroger" read as one merchant.
        merchant_rows = conn.execute(
            """SELECT description, COUNT(*) as count, ROUND(SUM(amount), 2) as total
               FROM transactions WHERE month_year LIKE ? AND type='expense' AND exclude_from_spending = 0
               GROUP BY description ORDER BY total DESC""",
            (year_prefix,)
        ).fetchall()
        merchant_groups = merchants.group_merchants(
            [dict(r) for r in merchant_rows], _alias_map(conn)
        )
        suggestions = merchants.suggest_merges(merchant_groups, _dismissed_pairs(conn))

        return {
            "year": year,
            "months": months,
            "total_income": round(totals["income"], 2),
            "total_spending": round(totals["spending"], 2),
            "total_bills": round(totals["bills"], 2),
            "total_savings": round(totals["savings"], 2),
            "total_net": round(totals["net"], 2),
            "merchants": merchant_groups,
            "merchant_suggestions": suggestions,
        }


def _alias_map(conn) -> dict[str, str]:
    """norm_key -> user-chosen group name."""
    rows = conn.execute("SELECT norm_key, display_name FROM merchant_aliases").fetchall()
    return {r["norm_key"]: r["display_name"] for r in rows}


def _dismissed_pairs(conn) -> set:
    rows = conn.execute("SELECT key_a, key_b FROM merchant_dismissals").fetchall()
    return {frozenset((r["key_a"], r["key_b"])) for r in rows}


def _group_members(conn, group_keys: list[str]) -> tuple[list[str], list[str]]:
    """Resolve group keys to the (descriptions, norm_keys) they cover."""
    alias_map = _alias_map(conn)
    wanted = set(group_keys)
    rows = conn.execute("SELECT DISTINCT description FROM transactions").fetchall()
    descriptions, keys = [], set()
    for r in rows:
        desc = r["description"]
        if merchants.group_key(desc, alias_map) in wanted:
            descriptions.append(desc)
            keys.add(merchants.norm_key(desc))
    return descriptions, sorted(keys)


def get_merchant_transactions(name: str, year: int | None = None,
                              group_key: str | None = None) -> list[dict]:
    """Transactions for a merchant - a whole group when `group_key` is given,
    otherwise the single exact description."""
    with get_db() as conn:
        if group_key:
            names, _ = _group_members(conn, [group_key])
        else:
            names = [name]
        if not names:
            return []
        placeholders = ",".join("?" * len(names))
        params = [*names]
        sql = f"SELECT * FROM transactions WHERE description IN ({placeholders}) AND type = 'expense'"
        if year:
            sql += " AND month_year LIKE ?"
            params.append(f"{year}-%")
        rows = conn.execute(sql + " ORDER BY date DESC", params).fetchall()
        return [dict(r) for r in rows]


def merge_merchant_groups(group_keys: list[str], to_name: str) -> int:
    """Point every norm_key in these groups at one display name.

    Non-destructive: transaction descriptions are untouched, so a merge can be
    undone and the original bank text is never lost.
    """
    to_name = to_name.strip()
    if not to_name or not group_keys:
        return 0
    with get_db() as conn:
        _, keys = _group_members(conn, group_keys)
        for key in keys:
            conn.execute(
                """INSERT INTO merchant_aliases (norm_key, display_name) VALUES (?, ?)
                   ON CONFLICT(norm_key) DO UPDATE SET display_name = excluded.display_name""",
                (key, to_name)
            )
        return len(keys)


def unmerge_merchant_group(group_key: str) -> int:
    """Drop the user alias for a group, restoring automatic grouping."""
    with get_db() as conn:
        _, keys = _group_members(conn, [group_key])
        if not keys:
            return 0
        placeholders = ",".join("?" * len(keys))
        result = conn.execute(
            f"DELETE FROM merchant_aliases WHERE norm_key IN ({placeholders})", keys
        )
        return result.rowcount


def dismiss_merchant_suggestion(key_a: str, key_b: str):
    a, b = sorted([key_a, key_b])
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO merchant_dismissals (key_a, key_b) VALUES (?, ?)", (a, b)
        )


def get_merchant_aliases() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT norm_key, display_name FROM merchant_aliases ORDER BY display_name, norm_key"
        ).fetchall()
        return [dict(r) for r in rows]


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


# --- Category Rules ---

def get_category_rules() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM category_rules ORDER BY keyword").fetchall()
        return [dict(r) for r in rows]


def insert_category_rule(keyword: str, category: str) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO category_rules (keyword, category) VALUES (?, ?)",
            (keyword.lower().strip(), category)
        )
        return cur.lastrowid


def delete_category_rule(rule_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM category_rules WHERE id = ?", (rule_id,))


def apply_category_rules(month_year: str) -> int:
    with get_db() as conn:
        rules = conn.execute("SELECT keyword, category FROM category_rules").fetchall()
        if not rules:
            return 0
        tx_rows = conn.execute(
            "SELECT id, description FROM transactions WHERE month_year = ?",
            (month_year,)
        ).fetchall()
        count = 0
        for tx in tx_rows:
            desc_lower = tx["description"].lower()
            for rule in rules:
                if rule["keyword"] in desc_lower:
                    conn.execute(
                        "UPDATE transactions SET category = ? WHERE id = ?",
                        (rule["category"], tx["id"])
                    )
                    count += 1
                    break
        return count


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
