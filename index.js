// index.js - Eclis Bank Telegram Bot with Supabase Client
const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// تنظیمات اولیه
const app = express();
const PORT = process.env.PORT || 3000;

// متغیرهای محیطی - استفاده از Supabase Client
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cerehuakrbjajwkwykee.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BANK_OWNER_ID = parseInt(process.env.BANK_OWNER_ID || '8423995337');
const BANK_GROUP_ID = process.env.BANK_GROUP_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'eclis_bank_secret_2024';

// بررسی وجود توکن و کلید Supabase
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required!');
  process.exit(1);
}

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_KEY is required!');
  console.log('💡 Get it from: Supabase Dashboard → Settings → API → Project API keys → anon/public');
  process.exit(1);
}

// ایجاد ربات
const bot = new Telegraf(BOT_TOKEN);

// ایجاد Supabase Client
console.log('🔧 Initializing Supabase Client...');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
});

let dbConnected = false;

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

// -------------------- توابع دیتابیس با Supabase Client --------------------
async function initDb() {
  try {
    console.log('🔄 Testing database connection...');
    
    // تست اتصال با یک کوئری ساده
    const { data, error } = await supabase
      .from('users')
      .select('count')
      .limit(1);

    if (error) {
      console.error('❌ Database connection failed:', error.message);
      dbConnected = false;
      return;
    }

    console.log('✅ Database connected successfully');
    dbConnected = true;

    // بررسی و ایجاد جداول اگر وجود ندارند
    await createTablesIfNotExist();
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    dbConnected = false;
  }
}

async function createTablesIfNotExist() {
  try {
    // این کوئری‌ها باید در Supabase SQL Editor اجرا شوند
    // اینجا فقط بررسی می‌کنیم که جداول اساساً کار می‌کنند
    console.log('✅ Assuming tables are created via SQL Editor');
    
  } catch (error) {
    console.error('Error in table creation:', error.message);
  }
}

// تابع برای بررسی اتصال دیتابیس
async function checkDbConnection() {
  if (!dbConnected) {
    // تلاش برای reconnect
    await initDb();
  }
  return dbConnected;
}

async function createUser(tgId, username, fullName, code) {
  if (!await checkDbConnection()) return [null, 'سیستم دیتابیس در دسترس نیست.'];

  try {
    // بررسی کد ثبت‌نام
    const { data: codeData, error: codeError } = await supabase
      .from('register_codes')
      .select('code')
      .eq('code', code)
      .single();

    if (codeError || !codeData) {
      return [null, 'کد ثبت‌نام نامعتبر است.'];
    }

    // بررسی وجود کاربر
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('tg_id')
      .eq('tg_id', tgId)
      .single();

    if (userData) {
      return [null, 'شما قبلاً ثبت‌نام کرده‌اید.'];
    }

    // حذف کد استفاده شده
    const { error: deleteError } = await supabase
      .from('register_codes')
      .delete()
      .eq('code', code);

    if (deleteError) {
      return [null, 'خطا در استفاده از کد.'];
    }

    // تولید شماره حساب منحصر به فرد
    let accountId;
    let attempts = 0;
    while (attempts < 10) {
      accountId = generateAccountId('ACC-', 6);
      if (accountId === 'ACC-001') continue;
      
      const { data: accountData } = await supabase
        .from('accounts')
        .select('account_id')
        .eq('account_id', accountId)
        .single();
      
      if (!accountData) break;
      attempts++;
    }

    if (attempts >= 10) {
      return [null, 'خطا در تولید شماره حساب. لطفاً مجدداً تلاش کنید.'];
    }

    // ایجاد کاربر
    const { error: userInsertError } = await supabase
      .from('users')
      .insert([
        {
          tg_id: tgId,
          username: username,
          full_name: fullName,
          personal_account: accountId
        }
      ]);

    if (userInsertError) {
      console.error('User insert error:', userInsertError);
      return [null, 'خطا در ایجاد کاربر.'];
    }

    // ایجاد حساب
    const { error: accountInsertError } = await supabase
      .from('accounts')
      .insert([
        {
          account_id: accountId,
          owner_tg_id: tgId,
          type: 'PERSONAL',
          name: fullName,
          balance: 0
        }
      ]);

    if (accountInsertError) {
      // حذف کاربر اگر ایجاد حساب شکست خورد
      await supabase
        .from('users')
        .delete()
        .eq('tg_id', tgId);
      return [null, 'خطا در ایجاد حساب.'];
    }

    return [accountId, null];
  } catch (error) {
    console.error('Error in createUser:', error);
    return [null, 'خطای سیستمی. لطفاً بعداً تلاش کنید.'];
  }
}

async function getUserByTgId(tgId) {
  if (!await checkDbConnection()) return null;
  
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('tg_id', tgId)
      .single();

    if (error) return null;
    return data;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

async function listUserAccounts(tgId) {
  if (!await checkDbConnection()) return [];
  
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('account_id, type, name, balance')
      .eq('owner_tg_id', tgId);

    if (error) return [];
    return data.map(row => ({
      account_id: row.account_id,
      type: row.type,
      name: row.name,
      balance: parseFloat(row.balance)
    }));
  } catch (error) {
    console.error('Error listing accounts:', error);
    return [];
  }
}

async function getUserByAccount(accountId) {
  if (!await checkDbConnection()) return null;
  
  try {
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('owner_tg_id')
      .eq('account_id', accountId.toUpperCase())
      .single();

    if (accountError || !accountData) return null;

    const ownerTgId = accountData.owner_tg_id;
    
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('tg_id', ownerTgId)
      .single();

    if (userError || !userData) {
      return { tg_id: ownerTgId };
    }

    return {
      tg_id: userData.tg_id,
      username: userData.username,
      full_name: userData.full_name,
      account_id: userData.personal_account
    };
  } catch (error) {
    console.error('Error getting user by account:', error);
    return null;
  }
}

async function transferFunds(fromAcc, toAcc, amount) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    if (amount <= 0) {
      return [false, 'مبلغ باید بزرگتر از صفر باشد.'];
    }

    if (fromAcc === toAcc) {
      return [false, 'امکان انتقال به حساب خود وجود ندارد.'];
    }

    // دریافت موجودی حساب مبدا
    const { data: fromData, error: fromError } = await supabase
      .from('accounts')
      .select('balance')
      .eq('account_id', fromAcc)
      .single();

    if (fromError || !fromData) {
      return [false, 'حساب مبدا یافت نشد.'];
    }

    // دریافت موجودی حساب مقصد
    const { data: toData, error: toError } = await supabase
      .from('accounts')
      .select('balance')
      .eq('account_id', toAcc)
      .single();

    if (toError || !toData) {
      return [false, 'حساب مقصد یافت نشد.'];
    }

    if (parseFloat(fromData.balance) < amount) {
      return [false, 'موجودی کافی نیست.'];
    }

    // انجام انتقال - کسر از حساب مبدا
    const { error: deductError } = await supabase
      .from('accounts')
      .update({ balance: parseFloat(fromData.balance) - amount })
      .eq('account_id', fromAcc);

    if (deductError) {
      return [false, 'خطا در کسر از حساب مبدا.'];
    }

    // اضافه کردن به حساب مقصد
    const { error: addError } = await supabase
      .from('accounts')
      .update({ balance: parseFloat(toData.balance) + amount })
      .eq('account_id', toAcc);

    if (addError) {
      // بازگرداندن مبلغ در صورت خطا
      await supabase
        .from('accounts')
        .update({ balance: parseFloat(fromData.balance) })
        .eq('account_id', fromAcc);
      return [false, 'خطا در واریز به حساب مقصد.'];
    }

    return [true, 'انجام شد'];
  } catch (error) {
    console.error('Error in transferFunds:', error);
    return [false, 'خطا در انتقال وجه. لطفاً بعداً تلاش کنید.'];
  }
}

async function createTransaction(txid, fromAcc, toAcc, amount, status) {
  if (!await checkDbConnection()) return;
  
  try {
    await supabase
      .from('transactions')
      .insert([
        {
          txid: txid,
          from_acc: fromAcc,
          to_acc: toAcc,
          amount: amount,
          status: status
        }
      ]);
  } catch (error) {
    console.error('Error creating transaction:', error);
  }
}

async function addRegisterCode(code) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    const { error } = await supabase
      .from('register_codes')
      .insert([{ code: code.trim() }])
      .select();

    if (error) {
      return [false, 'خطا در اضافه کردن کد.'];
    }
    return [true, null];
  } catch (error) {
    console.error('Error adding register code:', error);
    return [false, 'خطا در اضافه کردن کد.'];
  }
}

async function isAdmin(tgId) {
  if (!await checkDbConnection()) return false;
  
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('tg_id')
      .eq('tg_id', tgId)
      .single();

    if (error) return false;
    return !!data;
  } catch (error) {
    console.error('Error checking admin:', error);
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
    console.error('Error in isAdminOrOwner:', error);
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

    const { error } = await supabase
      .from('accounts')
      .delete()
      .eq('account_id', accountId.toUpperCase());

    if (error) {
      return [false, 'حساب مورد نظر یافت نشد.'];
    }

    return [true, null];
  } catch (error) {
    console.error('Error deleting account:', error);
    return [false, 'خطا در حذف حساب.'];
  }
}

async function transferAccountOwnership(accountId, newOwnerTgId) {
  if (!await checkDbConnection()) return [false, 'سیستم دیتابیس در دسترس نیست.'];
  
  try {
    // بررسی وجود حساب
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('account_id')
      .eq('account_id', accountId.toUpperCase())
      .single();

    if (accountError || !accountData) {
      return [false, 'حساب مورد نظر یافت نشد.'];
    }

    // انتقال مالکیت
    const { error } = await supabase
      .from('accounts')
      .update({ owner_tg_id: newOwnerTgId })
      .eq('account_id', accountId.toUpperCase());

    if (error) {
      return [false, 'خطا در انتقال مالکیت.'];
    }

    return [true, null];
  } catch (error) {
    console.error('Error transferring ownership:', error);
    return [false, 'خطا در انتقال مالکیت.'];
  }
}

async function takeFromAccount(fromAccountId, amount) {
  return await transferFunds(fromAccountId, 'ACC-001', amount);
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

// دستورات ربات (همانند قبل اما با Supabase Client)
// فقط نمونه‌ای از دستورات را می‌نویسم:

bot.start(async (ctx) => {
  console.log(`Start command from user: ${ctx.from.id}`);
  await ctx.reply(WELCOME_TEXT);
});

bot.help(async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
});

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

  } catch (error) {
    console.error('Error in register:', error);
    await ctx.reply('❌ خطایی در ثبت‌نام رخ داد. لطفاً بعداً تلاش کنید.');
  }
});

// دستورات دیگر مانند balance, myaccounts, transfer و...
// به همان صورت قب��ی اما با فراخوانی توابع Supabase Client

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

// سایر دستورات...

// -------------------- راه‌اندازی سرور --------------------
const webhookPath = `/webhook/${BOT_TOKEN}`;

app.post(webhookPath, (req, res) => {
  const secret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(403).send('Forbidden');
  }

  bot.handleUpdate(req.body, res);
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    database: dbConnected ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.status(200).send('Eclis Bank Bot is running with Supabase Client...');
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
    console.log(`🏦 Supabase URL: ${SUPABASE_URL}`);

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

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
