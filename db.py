# db.py  — Postgres version using asyncpg (for Supabase / Render)
import os
import random
import string
from decimal import Decimal, InvalidOperation
import asyncpg
import asyncio
import ssl

DATABASE_URL = os.getenv("DATABASE_URL")  # e.g. from Supabase (pooler or direct)
POOL: asyncpg.Pool | None = None

# ---------- helpers ----------
def _to_decimal(amount) -> Decimal:
    try:
        return Decimal(str(amount))
    except (InvalidOperation, TypeError):
        return Decimal("0")

def _acc(prefix: str, digits: int) -> str:
    return f"{prefix}{''.join(random.choices(string.digits, k=digits))}"

async def _ensure_pool():
    global POOL
    if POOL is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not set. Provide your Supabase Postgres connection string.")
        
        # تنظیمات SSL برای اتصال امن
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        try:
            POOL = await asyncpg.create_pool(
                DATABASE_URL,
                min_size=1,
                max_size=5,
                ssl=ssl_context,
                command_timeout=60
            )
        except Exception as e:
            print(f"Error creating pool: {e}")
            # تلاش مجدد بدون SSL
            try:
                POOL = await asyncpg.create_pool(
                    DATABASE_URL,
                    min_size=1,
                    max_size=5,
                    command_timeout=60
                )
            except Exception as e2:
                print(f"Error creating pool without SSL: {e2}")
                raise

# ---------- init ----------
async def init_db(owner_id: int):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        # tables
        await conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            tg_id BIGINT UNIQUE,
            username TEXT,
            full_name TEXT,
            personal_account TEXT
        )""")
        await conn.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
            id BIGSERIAL PRIMARY KEY,
            account_id TEXT UNIQUE,
            owner_tg_id BIGINT,
            type TEXT,          -- 'PERSONAL' | 'BUSINESS' | 'BANK'
            name TEXT,
            balance NUMERIC NOT NULL DEFAULT 0
        )""")
        await conn.execute("""CREATE TABLE IF NOT EXISTS register_codes (code TEXT PRIMARY KEY)""")
        await conn.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id BIGSERIAL PRIMARY KEY,
            txid TEXT,
            from_acc TEXT,
            to_acc TEXT,
            amount NUMERIC,
            status TEXT
        )""")
        await conn.execute("""CREATE TABLE IF NOT EXISTS admins (tg_id BIGINT PRIMARY KEY, name TEXT)""")

        # ensure main bank
        row = await conn.fetchrow("SELECT 1 FROM accounts WHERE account_id='ACC-001'")
        if not row:
            await conn.execute(
                "INSERT INTO accounts (account_id, owner_tg_id, type, name, balance) VALUES ('ACC-001', $1, 'BANK', 'Central Bank', 0)",
                int(owner_id)
            )

# ---------- users ----------
async def create_user(tg_id, username, full_name, code):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        # check code
        if not await conn.fetchrow("SELECT code FROM register_codes WHERE code=$1", code):
            return None, "Invalid registration code."
        # already registered?
        if await conn.fetchrow("SELECT 1 FROM users WHERE tg_id=$1", tg_id):
            return None, "User already registered."
        # consume code
        await conn.execute("DELETE FROM register_codes WHERE code=$1", code)
        # unique personal account (avoid ACC-001)
        # loop until unique
        while True:
            account_id = _acc("ACC-", 6)
            if account_id == "ACC-001":
                continue
            exists = await conn.fetchrow("SELECT 1 FROM accounts WHERE account_id=$1", account_id)
            if not exists:
                break
        # create
        await conn.execute(
            "INSERT INTO users (tg_id, username, full_name, personal_account) VALUES ($1,$2,$3,$4)",
            tg_id, username, full_name, account_id
        )
        await conn.execute(
            "INSERT INTO accounts (account_id, owner_tg_id, type, name, balance) VALUES ($1,$2,'PERSONAL',$3,0)",
            account_id, tg_id, full_name
        )
    return account_id, None

async def get_user_by_tgid(tg_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM users WHERE tg_id=$1", tg_id)
        return dict(row) if row else None

async def get_user_by_account(account_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        r = await conn.fetchrow("SELECT owner_tg_id FROM accounts WHERE account_id=$1", account_id)
        if not r:
            return None
        owner = r["owner_tg_id"]
        u = await conn.fetchrow("SELECT * FROM users WHERE tg_id=$1", owner)
        if not u:
            return {"tg_id": owner}
        return {
            "tg_id": u["tg_id"],
            "username": u["username"],
            "full_name": u["full_name"],
            "account_id": u["personal_account"],
        }

async def list_all_users():
    await _ensure_pool()
    async with POOL.acquire() as conn:
        rows = await conn.fetch("""
        SELECT u.tg_id, u.username, u.full_name, a.account_id
        FROM users u
        JOIN accounts a ON a.owner_tg_id=u.tg_id AND a.type='PERSONAL'
        ORDER BY u.full_name NULLS LAST
        """)
        return [{"tg_id": r["tg_id"], "username": r["username"], "full_name": r["full_name"], "account_id": r["account_id"]} for r in rows]

# ---------- accounts ----------
async def list_user_accounts(tg_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        rows = await conn.fetch("SELECT account_id, type, name, balance FROM accounts WHERE owner_tg_id=$1", tg_id)
        return [{"account_id": r["account_id"], "type": r["type"], "name": r["name"], "balance": float(r["balance"])} for r in rows]

async def can_use_account(tg_id, account_id, must_be_type=None):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        r = await conn.fetchrow("SELECT type FROM accounts WHERE account_id=$1 AND owner_tg_id=$2", account_id, tg_id)
        if not r:
            return False
        if must_be_type and r["type"] != must_be_type:
            return False
        return True

async def get_account_balance(account_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        r = await conn.fetchrow("SELECT balance FROM accounts WHERE account_id=$1", account_id)
        return float(r["balance"]) if r else 0.0

async def adjust_account_balance(account_id, amount):
    await _ensure_pool()
    amt = _to_decimal(amount)
    if amt == 0:
        return False, "Amount must be non-zero."
    async with POOL.acquire() as conn, conn.transaction():
        r = await conn.fetchrow("SELECT balance FROM accounts WHERE account_id=$1 FOR UPDATE", account_id)
        if not r:
            return False, "Account not found."
        new_bal = Decimal(r["balance"]) + amt
        if new_bal < 0:
            return False, "Insufficient funds."
        await conn.execute("UPDATE accounts SET balance=$1 WHERE account_id=$2", new_bal, account_id)
    return True, None

# ---------- transfers / transactions ----------
async def transfer_funds(from_acc, to_acc, amount):
    await _ensure_pool()
    amt = _to_decimal(amount)
    if amt <= 0:
        return False, "Amount must be > 0."
    if from_acc == to_acc:
        return False, "Cannot transfer to the same account."
    async with POOL.acquire() as conn, conn.transaction():
        fr = await conn.fetchrow("SELECT balance FROM accounts WHERE account_id=$1 FOR UPDATE", from_acc)
        to = await conn.fetchrow("SELECT balance FROM accounts WHERE account_id=$1 FOR UPDATE", to_acc)
        if not fr or not to:
            return False, "Account not found."
        if Decimal(fr["balance"]) < amt:
            return False, "Not enough balance."
        await conn.execute("UPDATE accounts SET balance = balance - $1 WHERE account_id=$2", amt, from_acc)
        await conn.execute("UPDATE accounts SET balance = balance + $1 WHERE account_id=$2", amt, to_acc)
    return True, "Completed"

async def create_transaction(txid, from_acc, to_acc, amount, status):
    await _ensure_pool()
    amt = _to_decimal(amount)
    async with POOL.acquire() as conn:
        await conn.execute(
            "INSERT INTO transactions (txid, from_acc, to_acc, amount, status) VALUES ($1,$2,$3,$4,$5)",
            txid, from_acc, to_acc, amt, status
        )

# ---------- business ----------
async def create_business_account(owner_tg_id, name):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        # find unique BUS- id
        while True:
            acc_id = _acc("BUS-", 5)
            if not await conn.fetchrow("SELECT 1 FROM accounts WHERE account_id=$1", acc_id):
                break
        await conn.execute(
            "INSERT INTO accounts (account_id, owner_tg_id, type, name, balance) VALUES ($1,$2,'BUSINESS',$3,0)",
            acc_id, owner_tg_id, name
        )
    return acc_id, None

async def transfer_account_ownership(acc_id, new_owner):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        if not await conn.fetchrow("SELECT 1 FROM accounts WHERE account_id=$1", acc_id):
            return False, "Account not found."
        await conn.execute("UPDATE accounts SET owner_tg_id=$1 WHERE account_id=$2", new_owner, acc_id)
    return True, None

# ---------- admin ----------
async def add_register_code(code):
    await _ensure_pool()
    code = (code or "").strip()
    if not code:
        return False, "Code cannot be empty."
    async with POOL.acquire() as conn:
        try:
            await conn.execute("INSERT INTO register_codes (code) VALUES ($1)", code)
            return True, None
        except asyncpg.UniqueViolationError:
            return False, "Code already exists."
        except Exception:
            # also handle unique via generic ON CONFLICT
            try:
                await conn.execute("INSERT INTO register_codes (code) VALUES ($1) ON CONFLICT DO NOTHING", code)
                return True, None
            except Exception:
                return False, "Code already exists."

async def add_admin(tg_id, name):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        await conn.execute("INSERT INTO admins (tg_id, name) VALUES ($1,$2) ON CONFLICT (tg_id) DO UPDATE SET name=EXCLUDED.name",
                           tg_id, name)

async def remove_admin(tg_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        await conn.execute("DELETE FROM admins WHERE tg_id=$1", tg_id)

async def list_admins():
    await _ensure_pool()
    async with POOL.acquire() as conn:
        rows = await conn.fetch("SELECT tg_id, name FROM admins ORDER BY name NULLS LAST")
        return [(r["tg_id"], r["name"]) for r in rows]

async def is_admin(tg_id):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        return bool(await conn.fetchrow("SELECT 1 FROM admins WHERE tg_id=$1", tg_id))

async def is_bank_owner(tg_id, owner_id):
    return int(tg_id) == int(owner_id)

# ---------- delete ----------
async def delete_account(account_id: str):
    await _ensure_pool()
    acc = account_id.upper()
    if acc == "ACC-001":
        return False, "Cannot delete the main bank account."
    async with POOL.acquire() as conn:
        res = await conn.execute("DELETE FROM accounts WHERE account_id=$1", acc)
        # res is like "DELETE 1"
        deleted = res.split()[-1] != "0"
        if not deleted:
            return False, "Account not found."
    return True, None

async def delete_business_account(account_id: str):
    await _ensure_pool()
    async with POOL.acquire() as conn:
        res = await conn.execute("DELETE FROM accounts WHERE account_id=$1 AND type='BUSINESS'", account_id.upper())
        deleted = res.split()[-1] != "0"
        if not deleted:
            return False, "Business account not found."
    return True, None
