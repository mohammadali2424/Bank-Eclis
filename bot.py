# bot.py
import os
import sys
import uuid
import logging
import asyncio
from datetime import datetime

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

# وب‌سرور سبک برای وبهوک
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Route
import uvicorn

# ایمپورت ماژول‌های داخلی
try:
    from db import (
        init_db, create_user, get_user_by_tgid, get_user_by_account,
        transfer_funds, create_transaction, add_register_code,
        get_account_balance, adjust_account_balance,
        add_admin, remove_admin, list_admins,
        can_use_account, create_business_account, transfer_account_ownership,
        list_all_users, list_user_accounts, is_admin, is_bank_owner,
        delete_account, delete_business_account
    )
    from receipt import generate_receipt_image
except ImportError as e:
    print(f"Import error: {e}")
    # Fallback functions for testing
    async def init_db(*args, **kwargs): pass
    async def create_user(*args, **kwargs): return None, "Database not available"
    async def get_user_by_tgid(*args, **kwargs): return None
    async def get_user_by_account(*args, **kwargs): return None
    async def transfer_funds(*args, **kwargs): return False, "Database error"
    async def create_transaction(*args, **kwargs): pass
    async def add_register_code(*args, **kwargs): return False, "Database error"
    async def get_account_balance(*args, **kwargs): return 0.0
    async def adjust_account_balance(*args, **kwargs): return False, "Database error"
    async def add_admin(*args, **kwargs): pass
    async def remove_admin(*args, **kwargs): pass
    async def list_admins(*args, **kwargs): return []
    async def can_use_account(*args, **kwargs): return False
    async def create_business_account(*args, **kwargs): return None, "Database error"
    async def transfer_account_ownership(*args, **kwargs): return False, "Database error"
    async def list_all_users(*args, **kwargs): return []
    async def list_user_accounts(*args, **kwargs): return []
    async def is_admin(*args, **kwargs): return False
    async def is_bank_owner(tg_id, owner_id): return int(tg_id) == int(owner_id)
    async def delete_account(*args, **kwargs): return False, "Database error"
    async def delete_business_account(*args, **kwargs): return False, "Database error"
    
    def generate_receipt_image(*args, **kwargs): 
        return "/tmp/test_receipt.png"

# ---------------- Config ----------------
BOT_TOKEN = os.getenv("BOT_TOKEN", "8021975466:AAGV_CanoaR3FQ-7c3WcPXbZRPpK6_K-KMQ")
BANK_GROUP_ID = int(os.getenv("BANK_GROUP_ID", "-1002585326279"))
BANK_OWNER_ID = int(os.getenv("BANK_OWNER_ID", "8423995337"))

# پورت و URL عمومی سرویس برای ست‌کردن وبهوک
PORT = int(os.getenv("PORT", "8000"))
PUBLIC_URL = os.getenv("RENDER_EXTERNAL_URL") or os.getenv("BASE_URL")
WEBHOOK_SECRET = os.getenv("TELEGRAM_WEBHOOK_SECRET", "eclis_bank_secret_2024")
WEBHOOK_PATH = f"/webhook/{BOT_TOKEN}"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("bankbot")

# متن‌های راهنما
WELCOME_TEXT = (
    "👋 به سولن بانک خوش آمدید!\n\n"
    "دستورات قابل استفاده:\n"
    "/start - شروع کار\n"
    "/help - راهنمای کامل\n"
    "/register <کد> - ساخت حساب شخصی\n"
    "/balance - مشاهده موجودی\n"
    "/myaccounts - لیست حساب‌ها\n"
    "/transfer <شماره حساب> <مبلغ> - انتقال وجه"
)

HELP_TEXT = """
📖 **دستورات ربات بانک سولن**

👤 **دستورات عمومی:**
/start - شروع کار با ربات
/help - نمایش این راهنما  
/register <کد> - ساخت حساب شخصی
/balance - مشاهده موجودی حساب
/myaccounts - لیست تمام حساب‌های شما
/transfer <شماره حساب مقصد> <مبلغ> - انتقال وجه

🏢 **دستورات کسب‌وکار:**
/paysalary <حساب کسب‌وکار> <حساب مقصد> <مبلغ> - پرداخت حقوق

⚙️ **دستورات ادمین:**
/newcode <کد> - ایجاد کد ثبت‌نام جدید
/createbusiness <نام> - ساخت حساب کسب‌وکار
/listusers - لیست کاربران
/bankbalance - موجودی بانک
/banktransfer <حساب مقصد> <مبلغ> - انتقال از حساب بانک

👑 **دستورات مالک:**
/addadmin <آیدی> <نام> - افزودن ادمین
/removeadmin <آیدی> - حذف ادمین
/listadmins - لیست ادمین‌ها
"""

# ---------------- Helper Functions ----------------
def _parse_amount(s: str) -> float | None:
    try:
        v = float(s)
        return v if v > 0 else None
    except:
        return None

async def _reply_split(update, text: str, chunk: int = 3900):
    """ارسال متن طولانی در چند پیام"""
    for i in range(0, len(text), chunk):
        await update.message.reply_text(text[i:i+chunk])

async def _is_admin_or_owner(tg_id: int) -> bool:
    """بررسی آیا کاربر ادمین یا مالک است"""
    try:
        return (await is_admin(tg_id)) or (await is_bank_owner(tg_id, BANK_OWNER_ID))
    except Exception as e:
        logger.error(f"Error checking admin status: {e}")
        return False

async def _send_receipt(context: ContextTypes.DEFAULT_TYPE, receipt_path: str, sender_tg_id: int, receiver_tg_id: int | None):
    """ارسال فیش تراکنش"""
    try:
        with open(receipt_path, "rb") as f:
            await context.bot.send_photo(chat_id=sender_tg_id, photo=f, caption="📄 فیش تراکنش شما")
    except Exception as e:
        logger.warning(f"Failed sending receipt to sender: {e}")
    
    if receiver_tg_id:
        try:
            with open(receipt_path, "rb") as f:
                await context.bot.send_photo(chat_id=receiver_tg_id, photo=f, caption="💰 واریز جدید")
        except Exception as e:
            logger.warning(f"Failed sending receipt to receiver: {e}")
    
    if BANK_GROUP_ID:
        try:
            with open(receipt_path, "rb") as f:
                await context.bot.send_photo(chat_id=BANK_GROUP_ID, photo=f, caption="📊 تراکنش جدید")
        except Exception as e:
            logger.warning(f"Failed sending receipt to group: {e}")

# ---------------- Command Handlers ----------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /start command"""
    logger.info(f"Start command from user: {update.effective_user.id}")
    await update.message.reply_text(WELCOME_TEXT)

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /help command"""
    await update.message.reply_text(HELP_TEXT, parse_mode='Markdown')

async def register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /register command"""
    user = update.effective_user
    logger.info(f"Register command from user: {user.id}")
    
    if not context.args:
        await update.message.reply_text("❌ لطفاً کد ثبت‌نام را وارد کنید:\n/register <کد>")
        return
    
    code = context.args[0].strip()
    try:
        account_id, msg = await create_user(user.id, user.username or "", user.full_name or "", code)
        if not account_id:
            await update.message.reply_text(f"❌ {msg}")
            return
        
        await update.message.reply_text(
            f"✅ **حساب شما با موفقیت ساخته شد!**\n\n"
            f"📋 اطلاعات حساب:\n"
            f"• شماره حساب: `{account_id}`\n"
            f"• موجودی اولیه: 0 سولن\n"
            f"• نوع حساب: شخصی\n\n"
            f"از طریق دستور /balance می‌توانید موجودی خود را بررسی کنید.",
            parse_mode='Markdown'
        )
        
        if BANK_GROUP_ID:
            await context.bot.send_message(
                chat_id=BANK_GROUP_ID,
                text=f"🟢 کاربر جدید ثبت‌نام کرد:\n"
                     f"👤 نام: {user.full_name}\n"
                     f"📱 آیدی: @{user.username or 'ندارد'}\n"
                     f"🆔 کد کاربری: {user.id}\n"
                     f"📊 شماره حساب: {account_id}"
            )
    except Exception as e:
        logger.error(f"Error in register: {e}")
        await update.message.reply_text("❌ خطایی در ثبت‌نام رخ داد. لطفاً بعداً تلاش کنید.")

async def balance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /balance command"""
    user_id = update.effective_user.id
    logger.info(f"Balance command from user: {user_id}")
    
    try:
        user = await get_user_by_tgid(user_id)
        if not user:
            await update.message.reply_text("❌ شما حساب بانکی ندارید. لطفاً اول ثبت‌نام کنید.")
            return
        
        accounts = await list_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("❌ هیچ حسابی برای شما یافت نشد.")
            return
        
        # پیدا کردن حساب شخصی اصلی
        main_acc = next((a for a in accounts if a["type"] == "PERSONAL"), accounts[0])
        await update.message.reply_text(
            f"💰 **موجودی حساب شما**\n\n"
            f"• شماره حساب: `{main_acc['account_id']}`\n"
            f"• موجودی: **{main_acc['balance']} سولن**\n"
            f"• نوع حساب: {main_acc['type']}",
            parse_mode='Markdown'
        )
    except Exception as e:
        logger.error(f"Error in balance: {e}")
        await update.message.reply_text("❌ خطایی در دریافت موجودی رخ داد.")

async def myaccounts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /myaccounts command"""
    user_id = update.effective_user.id
    logger.info(f"MyAccounts command from user: {user_id}")
    
    try:
        accounts = await list_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("📭 شما هیچ حسابی ندارید.")
            return
        
        text = "👛 **حساب‌های شما:**\n\n"
        for acc in accounts:
            text += f"• **{acc['account_id']}**\n"
            text += f"  نوع: {acc['type']}\n"
            text += f"  موجودی: {acc['balance']} سولن\n"
            if acc.get('name'):
                text += f"  نام: {acc['name']}\n"
            text += "\n"
        
        await update.message.reply_text(text, parse_mode='Markdown')
    except Exception as e:
        logger.error(f"Error in myaccounts: {e}")
        await update.message.reply_text("❌ خطایی در دریافت لیست حساب‌ها رخ داد.")

async def transfer(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /transfer command"""
    user_id = update.effective_user.id
    logger.info(f"Transfer command from user: {user_id}")
    
    if len(context.args) < 2:
        await update.message.reply_text(
            "❌ فرمت دستور نادرست است.\n\n"
            "✅ روش صحیح:\n"
            "`/transfer <شماره حساب مقصد> <مبلغ>`\n\n"
            "📝 مثال:\n"
            "`/transfer ACC-123456 100`",
            parse_mode='Markdown'
        )
        return
    
    if not await get_user_by_tgid(user_id):
        await update.message.reply_text("❌ شما حساب بانکی ندارید. لطفاً اول ثبت‌نام کنید.")
        return
    
    to_acc = context.args[0].strip().upper()
    amount = _parse_amount(context.args[1])
    
    if amount is None:
        await update.message.reply_text("❌ مبلغ نامعتبر است. لطفاً یک عدد مثبت وارد کنید.")
        return
    
    try:
        accounts = await list_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("❌ شما هیچ حسابی ندارید.")
            return
        
        from_acc = next((a["account_id"] for a in accounts if a["type"] == "PERSONAL"), accounts[0]["account_id"])
        txid = "TX-" + uuid.uuid4().hex[:8].upper()
        
        success, status = await transfer_funds(from_acc, to_acc, amount)
        receiver = await get_user_by_account(to_acc)
        
        await create_transaction(txid, from_acc, to_acc, amount, "Completed" if success else "Failed")
        
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        receipt = generate_receipt_image(txid, now, from_acc, to_acc, amount, "Completed" if success else "Failed")
        
        receiver_tg = receiver["tg_id"] if receiver else None
        await _send_receipt(context, receipt, user_id, receiver_tg)
        
        if success:
            await update.message.reply_text(
                f"✅ **انتقال با موفقیت انجام شد!**\n\n"
                f"• مبلغ: {amount} سولن\n"
                f"• از حساب: {from_acc}\n"
                f"• به حساب: {to_acc}\n"
                f"• کد تراکنش: {txid}",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text(f"❌ انتقال ناموفق: {status}")
            
    except Exception as e:
        logger.error(f"Error in transfer: {e}")
        await update.message.reply_text("❌ خطایی در انتقال وجه رخ داد.")

async def paysalary(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /paysalary command"""
    user_id = update.effective_user.id
    logger.info(f"Paysalary command from user: {user_id}")
    
    if len(context.args) < 3:
        await update.message.reply_text(
            "❌ فرمت دستور نادرست است.\n\n"
            "✅ روش صحیح:\n"
            "`/paysalary <حساب کسب‌وکار> <حساب مقصد> <مبلغ>`\n\n"
            "📝 مثال:\n"
            "`/paysalary BUS-12345 ACC-678901 500`",
            parse_mode='Markdown'
        )
        return
    
    from_acc, to_acc = context.args[0].upper(), context.args[1].upper()
    amount = _parse_amount(context.args[2])
    
    if amount is None:
        await update.message.reply_text("❌ مبلغ نامعتبر است.")
        return
    
    try:
        if not await can_use_account(user_id, from_acc, must_be_type="BUSINESS"):
            await update.message.reply_text("❌ این حساب کسب‌وکار متعلق به شما نیست یا وجود ندارد.")
            return
        
        txid = "TX-" + uuid.uuid4().hex[:8].upper()
        success, status = await transfer_funds(from_acc, to_acc, amount)
        receiver = await get_user_by_account(to_acc)
        
        await create_transaction(txid, from_acc, to_acc, amount, "Completed" if success else "Failed")
        
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        receipt = generate_receipt_image(txid, now, from_acc, to_acc, amount, "Completed" if success else "Failed")
        
        receiver_tg = receiver["tg_id"] if receiver else None
        await _send_receipt(context, receipt, user_id, receiver_tg)
        
        if success:
            await update.message.reply_text(f"✅ حقوق با موفقیت پرداخت شد.")
        else:
            await update.message.reply_text(f"❌ پرداخت ناموفق: {status}")
            
    except Exception as e:
        logger.error(f"Error in paysalary: {e}")
        await update.message.reply_text("❌ خطایی در پرداخت حقوق رخ داد.")

# ---------------- Admin Commands ----------------
async def newcode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /newcode command"""
    user_id = update.effective_user.id
    logger.info(f"Newcode command from user: {user_id}")
    
    if not await _is_admin_or_owner(user_id):
        await update.message.reply_text("❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.")
        return
    
    if not context.args:
        await update.message.reply_text("❌ لطفاً کد را وارد کنید: /newcode <کد>")
        return
    
    try:
        ok, msg = await add_register_code(context.args[0].strip())
        if ok:
            await update.message.reply_text(f"✅ کد ثبت‌نام با موفقیت اضافه شد.")
        else:
            await update.message.reply_text(f"❌ {msg}")
    except Exception as e:
        logger.error(f"Error in newcode: {e}")
        await update.message.reply_text("❌ خطایی در اضافه کردن کد رخ داد.")

async def createbusiness(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /createbusiness command"""
    user_id = update.effective_user.id
    logger.info(f"Createbusiness command from user: {user_id}")
    
    if not await _is_admin_or_owner(user_id):
        await update.message.reply_text("❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.")
        return
    
    if not context.args:
        await update.message.reply_text("❌ لطفاً نام کسب‌وکار را وارد کنید: /createbusiness <نام>")
        return
    
    try:
        name = " ".join(context.args).strip()
        acc_id, err = await create_business_account(user_id, name)
        if err:
            await update.message.reply_text(f"❌ {err}")
        else:
            await update.message.reply_text(
                f"✅ **حساب کسب‌وکار با موفقیت ساخته شد!**\n\n"
                f"• شماره حساب: `{acc_id}`\n"
                f"• نام: {name}\n"
                f"• مالک: {update.effective_user.full_name}",
                parse_mode='Markdown'
            )
    except Exception as e:
        logger.error(f"Error in createbusiness: {e}")
        await update.message.reply_text("❌ خطایی در ساخت حساب کسب‌وکار رخ داد.")

async def listusers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /listusers command"""
    user_id = update.effective_user.id
    logger.info(f"Listusers command from user: {user_id}")
    
    if not await _is_admin_or_owner(user_id):
        await update.message.reply_text("❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.")
        return
    
    try:
        users = await list_all_users()
        if not users:
            await update.message.reply_text("📭 هیچ کاربری ثبت‌نام نکرده است.")
            return
        
        text = f"👥 **لیست کاربران ({len(users)} نفر):**\n\n"
        for user in users:
            text += f"• **{user['full_name']}**\n"
            text += f"  آیدی: @{user['username'] or 'ندارد'}\n"
            text += f"  کد کاربری: {user['tg_id']}\n"
            text += f"  شماره حساب: {user['account_id']}\n\n"
        
        await _reply_split(update, text)
    except Exception as e:
        logger.error(f"Error in listusers: {e}")
        await update.message.reply_text("❌ خطایی در دریافت لیست کاربران رخ داد.")

async def bank_balance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /bankbalance command"""
    user_id = update.effective_user.id
    logger.info(f"Bankbalance command from user: {user_id}")
    
    if not await _is_admin_or_owner(user_id):
        await update.message.reply_text("❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.")
        return
    
    try:
        bal = await get_account_balance("ACC-001")
        await update.message.reply_text(f"🏦 **موجودی بانک مرکزی:** {bal} سولن", parse_mode='Markdown')
    except Exception as e:
        logger.error(f"Error in bank_balance: {e}")
        await update.message.reply_text("❌ خطایی در دریافت موجودی بانک رخ داد.")

async def bank_transfer(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /banktransfer command"""
    user_id = update.effective_user.id
    logger.info(f"Banktransfer command from user: {user_id}")
    
    if not await _is_admin_or_owner(user_id):
        await update.message.reply_text("❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.")
        return
    
    if len(context.args) < 2:
        await update.message.reply_text("❌ فرمت دستور: /banktransfer <حساب مقصد> <مبلغ>")
        return
    
    to_acc = context.args[0].upper()
    amount = _parse_amount(context.args[1])
    
    if amount is None:
        await update.message.reply_text("❌ مبلغ نامعتبر است.")
        return
    
    try:
        txid = "TX-" + uuid.uuid4().hex[:8].upper()
        success, status = await transfer_funds("ACC-001", to_acc, amount)
        receiver = await get_user_by_account(to_acc)
        
        await create_transaction(txid, "ACC-001", to_acc, amount, "Completed" if success else "Failed")
        
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        receipt = generate_receipt_image(txid, now, "ACC-001", to_acc, amount, "Completed" if success else "Failed")
        
        receiver_tg = receiver["tg_id"] if receiver else None
        await _send_receipt(context, receipt, user_id, receiver_tg)
        
        if success:
            await update.message.reply_text("✅ انتقال از حساب بانک با موفقیت انجام شد.")
        else:
            await update.message.reply_text(f"❌ انتقال ناموفق: {status}")
            
    except Exception as e:
        logger.error(f"Error in bank_transfer: {e}")
        await update.message.reply_text("❌ خطایی در انتقال از حساب بانک رخ داد.")

# ---------------- Owner Commands ----------------
async def add_admin_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /addadmin command"""
    user_id = update.effective_user.id
    
    if not await is_bank_owner(user_id, BANK_OWNER_ID):
        await update.message.reply_text("❌ فقط مالک بانک می‌تواند از این دستور استفاده کند.")
        return
    
    if len(context.args) < 2:
        await update.message.reply_text("❌ فرمت دستور: /addadmin <آیدی کاربر> <نام>")
        return
    
    try:
        tg_id = int(context.args[0])
        name = " ".join(context.args[1:]).strip()
        
        await add_admin(tg_id, name)
        await update.message.reply_text(f"✅ ادمین با موفقیت اضافه شد: {name} (آیدی: {tg_id})")
    except ValueError:
        await update.message.reply_text("❌ آیدی باید عدد باشد.")
    except Exception as e:
        logger.error(f"Error in add_admin: {e}")
        await update.message.reply_text("❌ خطایی در اضافه کردن ادمین رخ داد.")

async def list_admins_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler for /listadmins command"""
    user_id = update.effective_user.id
    
    if not await is_bank_owner(user_id, BANK_OWNER_ID):
        await update.message.reply_text("❌ فقط مالک بانک می‌تواند از این دستور استفاده کند.")
        return
    
    try:
        admins = await list_admins()
        if not admins:
            await update.message.reply_text("📭 هیچ ادمینی وجود ندارد.")
            return
        
        text = "👑 **لیست ادمین‌ها:**\n\n"
        for tg_id, name in admins:
            text += f"• {name} (آیدی: {tg_id})\n"
        
        await update.message.reply_text(text, parse_mode='Markdown')
    except Exception as e:
        logger.error(f"Error in list_admins: {e}")
        await update.message.reply_text("❌ خطایی در دریافت لیست ادمین‌ها رخ داد.")

# ---------------- Main Application ----------------
async def setup_application():
    """Setup and return the Telegram application"""
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Register all command handlers
    commands = [
        ('start', start),
        ('help', help_cmd),
        ('register', register),
        ('balance', balance),
        ('myaccounts', myaccounts),
        ('transfer', transfer),
        ('paysalary', paysalary),
        ('newcode', newcode),
        ('createbusiness', createbusiness),
        ('listusers', listusers),
        ('bankbalance', bank_balance),
        ('banktransfer', bank_transfer),
        ('addadmin', add_admin_cmd),
        ('listadmins', list_admins_cmd),
    ]
    
    for command, handler in commands:
        application.add_handler(CommandHandler(command, handler))
    
    # Add a fallback handler for unknown commands
    async def unknown(update: Update, context: ContextTypes.DEFAULT_TYPE):
        await update.message.reply_text(
            "❌ دستور نامعتبر.\n"
            "برای مشاهده دستورات قابل استفاده /help را ارسال کنید."
        )
    
    application.add_handler(MessageHandler(filters.COMMAND, unknown))
    
    return application

async def main():
    """Main function to start the bot"""
    logger.info("Starting Bank Bot...")
    
    # Initialize database
    try:
        await init_db(BANK_OWNER_ID)
        logger.info("✅ Database initialized successfully")
    except Exception as e:
        logger.error(f"❌ Database initialization failed: {e}")
        logger.info("⚠️ Continuing without database...")
    
    # Setup Telegram application
    application = await setup_application()
    
    # Setup webhook URL
    if not PUBLIC_URL:
        logger.error("❌ PUBLIC_URL is not set!")
        return
    
    webhook_url = f"{PUBLIC_URL}{WEBHOOK_PATH}"
    logger.info(f"🔧 Setting webhook to: {webhook_url}")
    
    # Set webhook
    try:
        await application.bot.set_webhook(
            url=webhook_url,
            secret_token=WEBHOOK_SECRET,
            drop_pending_updates=True
        )
        logger.info("✅ Webhook set successfully")
    except Exception as e:
        logger.error(f"❌ Failed to set webhook: {e}")
        return
    
    # Setup web server
    async def webhook_handler(request: Request):
        if WEBHOOK_SECRET:
            secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
            if secret != WEBHOOK_SECRET:
                return PlainTextResponse("Forbidden", status_code=403)
        
        try:
            data = await request.json()
            update = Update.de_json(data, application.bot)
            await application.process_update(update)
            return Response()
        except Exception as e:
            logger.error(f"Webhook error: {e}")
            return PlainTextResponse("Error", status_code=500)
    
    async def health_check(request: Request):
        return PlainTextResponse("OK")
    
    # Create Starlette app
    app = Starlette(routes=[
        Route(WEBHOOK_PATH, webhook_handler, methods=["POST"]),
        Route("/health", health_check, methods=["GET"]),
        Route("/", health_check, methods=["GET"]),
    ])
    
    # Start server
    config = uvicorn.Config(
        app=app,
        host="0.0.0.0",
        port=PORT,
        log_level="info"
    )
    server = uvicorn.Server(config)
    
    logger.info("🤖 Bank Bot is running in webhook mode...")
    
    async with application:
        await application.start()
        try:
            await server.serve()
        finally:
            await application.stop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bot stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
