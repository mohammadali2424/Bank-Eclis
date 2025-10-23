// index.js - Eclis Bank Telegram Bot
const express = require('express');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// تنظیمات اولیه
const app = express();
const PORT = process.env.PORT || 3000;

// متغیرهای محیطی
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BANK_OWNER_ID = parseInt(process.env.BANK_OWNER_ID || '8423995337');
const BANK_GROUP_ID = process.env.BANK_GROUP_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'eclis_bank_secret_2024';

// بررسی وجود توکن
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required!');
  process.exit(1);
}

// ایجاد ربات
const bot = new Telegraf(BOT_TOKEN);

// اتصال به دیتابیس با تنظیمات بهبود یافته
let pool;
let dbConnected = false;

if (DATABASE_URL) {
  try {
    // بررسی فرمت DATABASE_URL
    console.log('🔧 Testing database connection...');
    
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
      // تنظیمات اضافی برای Supabase
      query_timeout: 10000,
      statement_timeout: 10000
    });

    // تست اتصال
    pool.query('SELECT NOW()', (err, res) => {
      if (err) {
        console.error('❌ Database connection failed:', err.message);
        dbConnected = false;
      } else {
        console.log('✅ Database connected successfully');
        dbConnected = true;
      }
    });

    pool.on('error', (err) => {
      console.error('❌ PostgreSQL pool error:', err.message);
      dbConnected = false;
    });

  } catch (error) {
    console.error('❌ Database configuration error:', error.message);
    dbConnected = false;
  }
} else {
  console.log('⚠️ DATABASE_URL not set, running in limited mode');
  dbConnected = false;
}

// Middleware
app.use(express.json());

// -------------------- توابع کمکی --------------------
function generateAccountId(prefix, digits) {
  const numbers = '0123456789';
  let result = prefix;
  for (let i = 0; i < digits; i++) {
    result += numbers.charAt(Math.floor(Math.random() * numbers.length));
  }
  return result;
}

function generateTxId() {
  return 'TX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function parseAmount(amountStr) {
  const amount = parseFloat(amountStr);
  return amount > 0 ? amount : null;
}

// -------------------- توابع دیتابیس با مدیریت خطا بهتر --------------------
async function initDb() {
  if (!dbConnected || !pool) {
    console.log('⚠️ Skipping DB init - no database connection');
    return;
  }

  try {
    const client = await pool.connect();
    
    // ایجاد جداول
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        tg_id BIGINT UNIQUE,
        username TEXT,
        full_name TEXT,
        personal_account TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id BIGSERIAL PRIMARY KEY,
        account_id TEXT UNIQUE,
        owner_tg_id BIGINT,
        type TEXT,
        name TEXT,
        balance NUMERIC NOT NULL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS register_codes (
        code TEXT PRIMARY KEY
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        txid TEXT,
        from_acc TEXT,
        to_acc TEXT,
        amount NUMERIC,
        status TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        tg_id BIGINT PRIMARY KEY,
        name TEXT
      )
    `);

    // ایجاد حساب بانک مرکزی
    const bankAccount = await client.query(
      "SELECT 1 FROM accounts WHERE account_id = 'ACC-001'"
    );

    if (bankAccount.rows.length === 0) {
      await client.query(
        "INSERT INTO accounts (account_id, owner_tg_id, type, name, balance) VALUES ('ACC-001', $1, 'BANK', 'Central Bank', 0)",
        [BANK_OWNER_ID]
      );
      console.log('✅ Central bank account created');
    }

    client.release();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    dbConnected = false;
  }
}

// تابع برای بررسی اتصال دیتابیس قبل از اجرای کوئری
async function checkDbConnection() {
  if (!dbConnected || !pool) {
    return false;
  }
  
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('❌ Database connection check failed:', error.message);
    dbConnected = false;
    return false;
  }
}

async function createUser(tgId, username, fullName, code) {
  if (!await checkDbConnection()) return [null, 'سیستم دیتابیس در دسترس نیست.'];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // بررسی کد ثبت‌نام
    const codeCheck = await client.query(
      'SELECT code FROM register_codes WHERE code = $1',
      [code]
    );

    if (codeCheck.rows.length === 0) {
      return [null, 'کد ثبت‌نام نامعتبر است.'];
    }

    // بررسی وجود کاربر
    const userCheck = await client.query(
      'SELECT 1 FROM users WHERE tg_id = $1',
      [tgId]
    );

    if (userCheck.rows.length > 0) {
      return [null, 'شما قبلاً ثبت‌نام کرده‌اید.'];
    }

    // حذف کد استفاده شده
    await client.query(
      'DELETE FROM register_codes WHERE code = $1',
      [code]
    );

    // تولید شماره حساب منحصر به فرد
    let accountId;
    let attempts = 0;
    while (attempts < 10) {
      accountId = generateAccountId('ACC-', 6);
      if (accountId === 'ACC-001') continue;
      
      const accountCheck = await client.query(
        'SELECT 1 FROM accounts WHERE account_id = $1',
        [accountId]
      );
      
      if (accountCheck.rows.length === 0) break;
      attempts++;
    }

    if (attempts >= 10) {
      return [null, 'خطا در تولید شماره حساب. لطفاً مجدداً تلاش کنید.'];
    }

    // ایجاد کاربر
    await client.query(
      'INSERT INTO users (tg_id, username, full_name, personal_account) VALUES ($1, $2, $3, $4)',
      [tgId, username, fullName, accountId]
    );

    // ایجاد حساب
    await client.query(
      'INSERT INTO accounts (account_id, owner_tg_id, type, name, balance) VALUES ($1, $2, $3, $4, 0)',
      [accountId, tgId, 'PERSONAL', fullName]
    );

    await client.query('COMMIT');
    return [accountId, null];
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in createUser:', error.message);
    return [null, 'خطای سیستمی. لطفاً بعداً تلاش کنید.'];
  } finally {
    client.release();
  }
}

async function getUserByTgId(tgId) {
  if (!await checkDbConnection()) return null;
  
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE tg_id = $1',
      [tgId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting user:', error.message);
    return null;
  }
}

async function listUserAccounts(tgId) {
  if (!await checkDbConnection()) return [];
  
  try {
    const result = await pool.query(
      'SELECT account_id, type, name, balance FROM accounts WHERE owner_tg_id = $1',
      [tgId]
    );
    return result.rows.map(row => ({
      account_id: row.account_id,
      type: row.type,
      name: row.name,
      balance: parseFloat(row.balance)
    }));
  } catch (error) {
    console.error('Error listing accounts:', error.message);
    return [];
  }
}

async function getUserByAccount(accountId) {
  if (!await checkDbConnection()) return null;
  
  try {
    const result = await pool.query(
      'SELECT owner_tg_id FROM accounts WHERE account_id = $1',
      [accountId.toUpperCase()]
    );

    if (result.rows.length === 0) return null;

    const ownerTgId = result.rows[0].owner_tg_id;
    const userResult = await pool.query(
      'SELECT * FROM users WHERE tg_id = $1',
      [ownerTgId]
    );

    if (userResult.rows.length === 0) {
      return { tg_id: ownerTgId };
    }

    const user = userResult.rows[0];
    return {
      tg_id: user.tg_id,
      username: user.username,
      full_name: user.full_name,
      account_id: user.personal_account
    };
  } catch (error) {
    console.error('Error getting user by account:', error.message);
    return null;
  }
}

async function transferFunds(fromAcc, toAcc, amount) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (amount <= 0) {
      return [false, 'مبلغ باید بزرگتر از صفر باشد.'];
    }

    if (fromAcc === toAcc) {
      return [false, 'امکان انتقال به حساب خود وجود ندارد.'];
    }

    // بررسی موجودی
    const fromBalance = await client.query(
      'SELECT balance FROM accounts WHERE account_id = $1 FOR UPDATE',
      [fromAcc]
    );

    const toBalance = await client.query(
      'SELECT balance FROM accounts WHERE account_id = $1 FOR UPDATE',
      [toAcc]
    );

    if (fromBalance.rows.length === 0 || toBalance.rows.length === 0) {
      return [false, 'حساب مورد نظر یافت نشد.'];
    }

    if (parseFloat(fromBalance.rows[0].balance) < amount) {
      return [false, 'موجودی کافی نیست.'];
    }

    // انجام انتقال
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE account_id = $2',
      [amount, fromAcc]
    );

    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE account_id = $2',
      [amount, toAcc]
    );

    await client.query('COMMIT');
    return [true, 'انجام شد'];
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in transferFunds:', error.message);
    return [false, 'خطا در انتقال وجه. لطفاً بعداً تلاش کنید.'];
  } finally {
    client.release();
  }
}

async function createTransaction(txid, fromAcc, toAcc, amount, status) {
  if (!await checkDbConnection()) return;
  
  try {
    await pool.query(
      'INSERT INTO transactions (txid, from_acc, to_acc, amount, status) VALUES ($1, $2, $3, $4, $5)',
      [txid, fromAcc, toAcc, amount, status]
    );
  } catch (error) {
    console.error('Error creating transaction:', error.message);
  }
}

async function addRegisterCode(code) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    await pool.query(
      'INSERT INTO register_codes (code) VALUES ($1) ON CONFLICT (code) DO NOTHING',
      [code.trim()]
    );
    return [true, null];
  } catch (error) {
    console.error('Error adding register code:', error.message);
    return [false, 'خطا در اضافه کردن کد.'];
  }
}

async function isAdmin(tgId) {
  if (!await checkDbConnection()) return false;
  
  try {
    const result = await pool.query(
      'SELECT 1 FROM admins WHERE tg_id = $1',
      [tgId]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error checking admin:', error.message);
    return false;
  }
}

function isBankOwner(tgId) {
  return parseInt(tgId) === BANK_OWNER_ID;
}

async function isAdminOrOwner(tgId) {
  try {
    return (await isAdmin(tgId)) || isBankOwner(tgId);
  } catch (error) {
    console.error('Error in isAdminOrOwner:', error.message);
    return false;
  }
}

// -------------------- توابع جدید برای دستورات --------------------
async function deleteAccount(accountId) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    if (accountId.toUpperCase() === 'ACC-001') {
      return [false, 'امکان حذف حساب اصلی بانک وجود ندارد.'];
    }

    const result = await pool.query(
      'DELETE FROM accounts WHERE account_id = $1',
      [accountId.toUpperCase()]
    );

    if (result.rowCount === 0) {
      return [false, 'حساب مورد نظر یافت نشد.'];
    }

    return [true, null];
  } catch (error) {
    console.error('Error deleting account:', error.message);
    return [false, 'خطا در حذف حساب.'];
  }
}

async function transferAccountOwnership(accountId, newOwnerTgId) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    // بررسی وجود حساب
    const accountCheck = await pool.query(
      'SELECT 1 FROM accounts WHERE account_id = $1',
      [accountId.toUpperCase()]
    );

    if (accountCheck.rows.length === 0) {
      return [false, 'حساب مورد نظر یافت نشد.'];
    }

    // انتقال مالکیت
    await pool.query(
      'UPDATE accounts SET owner_tg_id = $1 WHERE account_id = $2',
      [newOwnerTgId, accountId.toUpperCase()]
    );

    return [true, null];
  } catch (error) {
    console.error('Error transferring ownership:', error.message);
    return [false, 'خطا در انتقال مالکیت.'];
  }
}

async function takeFromAccount(fromAccountId, amount) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  return await transferFunds(fromAccountId, 'ACC-001', amount);
}

async function getAllAccounts() {
  if (!await checkDbConnection()) return [];
  
  try {
    const result = await pool.query(
      'SELECT account_id, owner_tg_id, type, name, balance FROM accounts ORDER BY type, account_id'
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting all accounts:', error.message);
    return [];
  }
}

// -------------------- توابع receipt --------------------
async function generateReceiptImage(txid, date, fromAccount, toAccount, amount, status) {
  const W = 800, H = 1000;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // پس‌زمینه
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // رنگ‌ها
  const gold = '#c9a151';
  const white = '#f0f0f0';

  // لوگو (اگر وجود دارد)
  try {
    if (fs.existsSync('assets/logo.png')) {
      const logo = await loadImage('assets/logo.png');
      const logoSize = W * 0.4;
      const lx = (W - logoSize) / 2;
      ctx.drawImage(logo, lx, 40, logoSize, logoSize);
    }
  } catch (error) {
    // اگر لوگو نبود، مشکلی نیست
  }

  // عنوان
  ctx.fillStyle = gold;
  ctx.font = 'bold 40px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('ECLIS BANK', W / 2, 300);

  // خط جداکننده
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 360);
  ctx.lineTo(W - 80, 360);
  ctx.stroke();

  // اطلاعات تراکنش
  const startY = 400;
  const gap = 60;
  
  const lines = [
    ['Transaction ID:', txid],
    ['Date:', date],
    ['From Account:', fromAccount],
    ['To Account:', toAccount],
    ['Amount:', `${amount} Solen`],
    ['Status:', status],
  ];

  ctx.textAlign = 'left';
  const xLabel = 100;
  const xVal = 350;

  lines.forEach(([label, value], i) => {
    const y = startY + i * gap;
    
    ctx.fillStyle = white;
    ctx.font = '24px Arial';
    ctx.fillText(label, xLabel, y);
    
    const valueColor = (label === 'Status:' && value.toLowerCase() === 'completed') ? gold : white;
    ctx.fillStyle = valueColor;
    ctx.font = '26px Arial';
    ctx.fillText(String(value), xVal, y);
  });

  // خط پایین
  ctx.beginPath();
  ctx.moveTo(80, H - 120);
  ctx.lineTo(W - 80, H - 120);
  ctx.stroke();

  // ذخیره تصویر
  const outDir = 'receipts';
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, `receipt_${txid}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);

  return outPath;
}

// -------------------- دستورات ربات --------------------
const WELCOME_TEXT = `👋 به سولن بانک خوش آمدید!

دستورات قابل استفاده:
/start - شروع کار
/help - راهنمای کامل
/register <کد> - ساخت حساب شخصی
/balance - مشاهده موجودی
/myaccounts - لیست حساب‌ها
/transfer <شماره حساب> <مبلغ> - انتقال وجه`;

const HELP_TEXT = `📖 **دستورات ربات بانک سولن**

👤 **دستورات عمومی:**
/start - شروع کار با ربات
/help - نمایش این راهنما  
/register <کد> - ساخت حساب شخصی
/balance - مشاهده موجودی حساب
/myaccounts - لیست تمام حساب‌های شما
/transfer <شماره حساب مقصد> <مبلغ> - انتقال وجه

⚙️ **دستورات ادمین:**
/newcode <کد> - ایجاد کد ثبت‌نام جدید
/listusers - لیست کاربران
/bankbalance - موجودی بانک
/banktransfer <حساب مقصد> <مبلغ> - انتقال از حساب بانک
/takefrom <حساب مبدا> <مبلغ> - برداشت از حساب کاربر
/closeaccount <شماره حساب> - بستن حساب
/transferowner <شماره حساب> <آیدی کاربر جدید> - انتقال مالکیت حساب`;

// دستور start
bot.start(async (ctx) => {
  console.log(`Start command from user: ${ctx.from.id}`);
  await ctx.reply(WELCOME_TEXT);
});

// دستور help
bot.help(async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
});

// دستور register
bot.command('register', async (ctx) => {
  const user = ctx.from;
  console.log(`Register command from user: ${user.id}`);
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    await ctx.reply('❌ لطفاً کد ثبت‌نام را وارد کنید:\n/register <کد>');
    return;
  }

  const code = args[0];
  try {
    const [accountId, msg] = await createUser(user.id, user.username || '', user.first_name || '', code);
    
    if (!accountId) {
      await ctx.reply(`❌ ${msg}`);
      return;
    }

    await ctx.reply(
      `✅ **حساب شما با موفقیت ساخته شد!**\n\n` +
      `📋 اطلاعات حساب:\n` +
      `• شماره حساب: \`${accountId}\`\n` +
      `• موجودی اولیه: 0 سولن\n` +
      `• نوع حساب: شخصی\n\n` +
      `از طریق دستور /balance می‌توانید موجودی خود را بررسی کنید.`,
      { parse_mode: 'Markdown' }
    );

    if (BANK_GROUP_ID) {
      try {
        await bot.telegram.sendMessage(
          BANK_GROUP_ID,
          `🟢 کاربر جدید ثبت‌نام کرد:\n` +
          `👤 نام: ${user.first_name}\n` +
          `📱 آیدی: @${user.username || 'ندارد'}\n` +
          `🆔 کد کاربری: ${user.id}\n` +
          `📊 شماره حساب: ${accountId}`
        );
      } catch (error) {
        console.log('Could not send notification to group');
      }
    }
  } catch (error) {
    console.error('Error in register:', error);
    await ctx.reply('❌ خطایی در ثبت‌نام رخ داد. لطفاً بعداً تلاش کنید.');
  }
});

// دستور balance
bot.command('balance', async (ctx) => {
  const userId = ctx.from.id;
  console.log(`Balance command from user: ${userId}`);
  
  try {
    const user = await getUserByTgId(userId);
    if (!user) {
      await ctx.reply('❌ شما حساب بانکی ندارید. لطفاً اول ثبت‌نام کنید.');
      return;
    }

    const accounts = await listUserAccounts(userId);
    if (accounts.length === 0) {
      await ctx.reply('❌ هیچ حسابی برای شما یافت نشد.');
      return;
    }

    const mainAcc = accounts.find(a => a.type === 'PERSONAL') || accounts[0];
    await ctx.reply(
      `💰 **موجودی حساب شما**\n\n` +
      `• شماره حساب: \`${mainAcc.account_id}\`\n` +
      `• موجودی: **${mainAcc.balance} سولن**\n` +
      `• نوع حساب: ${mainAcc.type}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in balance:', error);
    await ctx.reply('❌ خطایی در دریافت موجودی رخ داد.');
  }
});

// ... (بقیه دستورات مانند myaccounts, transfer و غیره مانند قبل می‌مانند)
// فقط کدهای مربوط به دستورات جدید را اینجا قرار می‌دهم

// دستور closeaccount
bot.command('closeaccount', async (ctx) => {
  const userId = ctx.from.id;
  console.log(`Closeaccount command from user: ${userId}`);
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    await ctx.reply('❌ لطفاً شماره حساب را وارد کنید: /closeaccount <شماره حساب>');
    return;
  }

  const accountId = args[0];
  try {
    const [success, msg] = await deleteAccount(accountId);
    if (success) {
      await ctx.reply(`✅ حساب ${accountId} با موفقیت بسته شد.`);
    } else {
      await ctx.reply(`❌ ${msg}`);
    }
  } catch (error) {
    console.error('Error in closeaccount:', error);
    await ctx.reply('❌ خطایی در بستن حساب رخ داد.');
  }
});

// دستور transferowner
bot.command('transferowner', async (ctx) => {
  const userId = ctx.from.id;
  console.log(`Transferowner command from user: ${userId}`);
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    await ctx.reply('❌ فرمت دستور: /transferowner <شماره حساب> <آیدی کاربر جدید>');
    return;
  }

  const accountId = args[0];
  const newOwnerId = parseInt(args[1]);

  if (isNaN(newOwnerId)) {
    await ctx.reply('❌ آیدی کاربر جدید باید عدد باشد.');
    return;
  }

  try {
    const [success, msg] = await transferAccountOwnership(accountId, newOwnerId);
    if (success) {
      await ctx.reply(`✅ مالکیت حساب ${accountId} به کاربر ${newOwnerId} منتقل شد.`);
    } else {
      await ctx.reply(`❌ ${msg}`);
    }
  } catch (error) {
    console.error('Error in transferowner:', error);
    await ctx.reply('❌ خطایی در انتقال مالکیت رخ داد.');
  }
});

// دستور takefrom
bot.command('takefrom', async (ctx) => {
  const userId = ctx.from.id;
  console.log(`Takefrom command from user: ${userId}`);
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    await ctx.reply('❌ فرمت دستور: /takefrom <شماره حساب مبدا> <مبلغ>');
    return;
  }

  const fromAccount = args[0].toUpperCase();
  const amount = parseAmount(args[1]);

  if (!amount) {
    await ctx.reply('❌ مبلغ نامعتبر است.');
    return;
  }

  try {
    const txid = generateTxId();
    const [success, status] = await takeFromAccount(fromAccount, amount);
    
    await createTransaction(txid, fromAccount, 'ACC-001', amount, success ? 'Completed' : 'Failed');

    if (success) {
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const receiptPath = await generateReceiptImage(txid, now, fromAccount, 'ACC-001', amount, 'Completed');

      await ctx.replyWithPhoto({ source: receiptPath }, {
        caption: `✅ **برداشت از حساب با موفقیت انجام شد!**\n\n` +
                `• مبلغ: ${amount} سولن\n` +
                `• از حساب: ${fromAccount}\n` +
                `• به حساب بانک: ACC-001\n` +
                `• کد تراکنش: ${txid}`,
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.reply(`❌ برداشت ناموفق: ${status}`);
    }

  } catch (error) {
    console.error('Error in takefrom:', error);
    await ctx.reply('❌ خطایی در برداشت از حساب رخ داد.');
  }
});

// دستور newcode (ادمین)
bot.command('newcode', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    await ctx.reply('❌ لطفاً کد را وارد کنید: /newcode <کد>');
    return;
  }

  const code = args[0];
  try {
    const [ok, msg] = await addRegisterCode(code);
    if (ok) {
      await ctx.reply('✅ کد ثبت‌نام با موفقیت اضافه شد.');
    } else {
      await ctx.reply(`❌ ${msg}`);
    }
  } catch (error) {
    console.error('Error in newcode:', error);
    await ctx.reply('❌ خطایی در اضافه کردن کد رخ داد.');
  }
});

// دستور bankbalance (ادمین)
bot.command('bankbalance', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  try {
    if (!dbConnected) {
      await ctx.reply('❌ دیتابیس در دسترس نیست.');
      return;
    }

    const result = await pool.query(
      'SELECT balance FROM accounts WHERE account_id = $1',
      ['ACC-001']
    );
    
    const balance = result.rows[0] ? parseFloat(result.rows[0].balance) : 0;
    await ctx.reply(`🏦 **موجودی بانک مرکزی:** ${balance} سولن`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error in bankbalance:', error);
    await ctx.reply('❌ خطایی در دریافت موجودی بانک رخ داد.');
  }
});

// دستور listusers (ادمین)
bot.command('listusers', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!await isAdminOrOwner(userId)) {
    await ctx.reply('❌ دسترسی denied. فقط ادمین‌ها می‌توانند از این دستور استفاده کنند.');
    return;
  }

  try {
    if (!dbConnected) {
      await ctx.reply('❌ دیتابیس در دسترس نیست.');
      return;
    }

    const result = await pool.query(`
      SELECT u.tg_id, u.username, u.full_name, a.account_id
      FROM users u
      JOIN accounts a ON a.owner_tg_id = u.tg_id AND a.type = 'PERSONAL'
      ORDER BY u.full_name NULLS LAST
    `);

    if (result.rows.length === 0) {
      await ctx.reply('📭 هیچ کاربری ثبت‌نام نکرده است.');
      return;
    }

    let text = `👥 **لیست کاربران (${result.rows.length} نفر):**\n\n`;
    result.rows.forEach(user => {
      text += `• **${user.full_name}**\n`;
      text += `  آیدی: @${user.username || 'ندارد'}\n`;
      text += `  کد کاربری: ${user.tg_id}\n`;
      text += `  شماره حساب: ${user.account_id}\n\n`;
    });

    // اگر متن خیلی طولانی شد، آن را تقسیم می‌کنیم
    if (text.length > 4000) {
      const chunks = text.match(/.{1,4000}/g) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Error in listusers:', error);
    await ctx.reply('❌ خطایی در دریافت لیست کاربران رخ داد.');
  }
});

// -------------------- راه‌اندازی سرور --------------------
// مسیر وبهوک
const webhookPath = `/webhook/${BOT_TOKEN}`;

// Route برای وبهوک
app.post(webhookPath, (req, res) => {
  // بررسی secret token
  const secret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(403).send('Forbidden');
  }

  bot.handleUpdate(req.body, res);
});

// Route برای سلامت سرویس
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    database: dbConnected ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.status(200).send('Eclis Bank Bot is running...');
});

// شروع سرور
async function startServer() {
  try {
    // مقداردهی اولیه دیتابیس
    await initDb();
    
    // تنظیم وبهوک
    const webhookUrl = process.env.RENDER_EXTERNAL_URL + webhookPath;

    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: WEBHOOK_SECRET
    });

    console.log('✅ Webhook set successfully');
    console.log('🤖 Bot is running in webhook mode...');
    console.log(`🔗 Webhook URL: ${webhookUrl}`);
    console.log(`💾 Database status: ${dbConnected ? 'Connected' : 'Disconnected'}`);

    // شروع سرور Express
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// شروع برنامه
startServer();

// هندل کردن خطاهای catch نشده
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
