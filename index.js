// index.js
const { Telegraf, Markup, session } = require('telegraf');
const { createCanvas, loadImage, registerFont } = require('canvas');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// تنظیمات محیط
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BANK_GROUP_ID = parseInt(process.env.BANK_GROUP_ID) || -1002585326279;
const BANK_OWNER_ID = parseInt(process.env.BANK_OWNER_ID) || 8423995337;

// راه‌اندازی سوپابیس
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// راه‌اندازی ربات
const bot = new Telegraf(BOT_TOKEN);

// متن‌های راهنما
const WELCOME_TEXT = `
👋 به سولن بانک خوش آمدید!
برای ساخت حساب شخصی: /register <code>
برای دیدن دستورات: /help
`;

const HELP_TEXT = `
📖 دستورات:

— همه —
/start — شروع
/help — راهنما
/register <code> — ساخت حساب شخصی با کد ثبت‌نام
/balance — ماندهٔ حساب اصلی
/myaccounts — لیست حساب‌ها
/transfer <to_account_id> <amount> — انتقال وجه

— صاحبان کسب‌وکار —
/paysalary <from_business_acc> <to_acc> <amount>

— ادمین بانک —
/newcode <code>
/createbusiness <name>
/transferowner <account_id> <new_owner_tg_id>
/listusers
/bankadd <amount>
/banktake <amount>
/bankbalance
/banktransfer <to_account_id> <amount>
/takefrom <from_account_id> <amount>
/closeaccount <account_id>
/closebusiness <account_id>

— مالک بانک —
/addadmin <telegram_id> <name>
/removeadmin <telegram_id>
/listadmins
/transferowner@EclisBank_bot
/listadmins@EclisBank_bot
/removeadmin@EclisBank_bot
`;

// توابع کمکی
function generateAccountId(prefix, digits) {
    const numbers = '0123456789';
    let result = prefix;
    for (let i = 0; i < digits; i++) {
        result += numbers.charAt(Math.floor(Math.random() * numbers.length));
    }
    return result;
}

function parseAmount(amountStr) {
    const amount = parseFloat(amountStr);
    return amount > 0 ? amount : null;
}

async function splitReply(ctx, text, chunkSize = 3900) {
    for (let i = 0; i < text.length; i += chunkSize) {
        await ctx.reply(text.substring(i, i + chunkSize));
    }
}

// توابع دیتابیس
async function initDatabase() {
    try {
        // ایجاد جدول users
        const { error: usersError } = await supabase
            .from('users')
            .insert([{
                tg_id: BANK_OWNER_ID,
                username: 'bank_owner',
                full_name: 'Bank Owner',
                personal_account: 'ACC-001'
            }])
            .select();

        // ایجاد حساب بانک مرکزی
        const { error: accountsError } = await supabase
            .from('accounts')
            .insert([{
                account_id: 'ACC-001',
                owner_tg_id: BANK_OWNER_ID,
                type: 'BANK',
                name: 'Central Bank',
                balance: 0
            }])
            .select();

        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.log('Database already initialized');
    }
}

async function createUser(tgId, username, fullName, code) {
    // بررسی کد ثبت‌نام
    const { data: codeData, error: codeError } = await supabase
        .from('register_codes')
        .select('code')
        .eq('code', code)
        .single();

    if (!codeData) {
        return { error: 'کد ثبت‌نام نامعتبر است.' };
    }

    // بررسی وجود کاربر
    const { data: existingUser } = await supabase
        .from('users')
        .select('tg_id')
        .eq('tg_id', tgId)
        .single();

    if (existingUser) {
        return { error: 'کاربر قبلاً ثبت‌نام کرده است.' };
    }

    // حذف کد استفاده شده
    await supabase
        .from('register_codes')
        .delete()
        .eq('code', code);

    // ایجاد حساب منحصربه‌فرد
    let accountId;
    let isUnique = false;
    
    while (!isUnique) {
        accountId = generateAccountId('ACC-', 6);
        if (accountId === 'ACC-001') continue;
        
        const { data: existingAccount } = await supabase
            .from('accounts')
            .select('account_id')
            .eq('account_id', accountId)
            .single();
            
        if (!existingAccount) {
            isUnique = true;
        }
    }

    // ایجاد کاربر
    const { error: userError } = await supabase
        .from('users')
        .insert([{
            tg_id: tgId,
            username: username,
            full_name: fullName,
            personal_account: accountId
        }]);

    if (userError) {
        return { error: 'خطا در ایجاد کاربر.' };
    }

    // ایجاد حساب شخصی
    const { error: accountError } = await supabase
        .from('accounts')
        .insert([{
            account_id: accountId,
            owner_tg_id: tgId,
            type: 'PERSONAL',
            name: fullName,
            balance: 0
        }]);

    if (accountError) {
        return { error: 'خطا در ایجاد حساب.' };
    }

    return { accountId };
}

async function getUserByTgId(tgId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('tg_id', tgId)
        .single();
    
    return data;
}

async function getUserByAccount(accountId) {
    const { data: accountData } = await supabase
        .from('accounts')
        .select('owner_tg_id')
        .eq('account_id', accountId)
        .single();

    if (!accountData) return null;

    const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('tg_id', accountData.owner_tg_id)
        .single();

    return userData || { tg_id: accountData.owner_tg_id };
}

async function listUserAccounts(tgId) {
    const { data, error } = await supabase
        .from('accounts')
        .select('account_id, type, name, balance')
        .eq('owner_tg_id', tgId);
    
    return data || [];
}

async function getAccountBalance(accountId) {
    const { data, error } = await supabase
        .from('accounts')
        .select('balance')
        .eq('account_id', accountId)
        .single();
    
    return data ? parseFloat(data.balance) : 0.0;
}

async function adjustAccountBalance(accountId, amount) {
    if (amount === 0) {
        return { success: false, error: 'مبلغ باید غیرصفر باشد.' };
    }

    const { data: account } = await supabase
        .from('accounts')
        .select('balance')
        .eq('account_id', accountId)
        .single();

    if (!account) {
        return { success: false, error: 'حساب پیدا نشد.' };
    }

    const newBalance = parseFloat(account.balance) + amount;
    
    if (newBalance < 0) {
        return { success: false, error: 'موجودی کافی نیست.' };
    }

    const { error } = await supabase
        .from('accounts')
        .update({ balance: newBalance })
        .eq('account_id', accountId);

    if (error) {
        return { success: false, error: 'خطا در به‌روزرسانی موجودی.' };
    }

    return { success: true };
}

async function transferFunds(fromAcc, toAcc, amount) {
    if (amount <= 0) {
        return { success: false, error: 'مبلغ باید بزرگتر از صفر باشد.' };
    }

    if (fromAcc === toAcc) {
        return { success: false, error: 'نمی‌توان به همان حساب انتقال داد.' };
    }

    // بررسی موجود بودن حساب‌ها
    const { data: fromAccount } = await supabase
        .from('accounts')
        .select('balance')
        .eq('account_id', fromAcc)
        .single();

    const { data: toAccount } = await supabase
        .from('accounts')
        .select('balance')
        .eq('account_id', toAcc)
        .single();

    if (!fromAccount || !toAccount) {
        return { success: false, error: 'حساب پیدا نشد.' };
    }

    if (parseFloat(fromAccount.balance) < amount) {
        return { success: false, error: 'موجودی کافی نیست.' };
    }

    // انجام انتقال
    const fromNewBalance = parseFloat(fromAccount.balance) - amount;
    const toNewBalance = parseFloat(toAccount.balance) + amount;

    await supabase
        .from('accounts')
        .update({ balance: fromNewBalance })
        .eq('account_id', fromAcc);

    await supabase
        .from('accounts')
        .update({ balance: toNewBalance })
        .eq('account_id', toAcc);

    return { success: true, message: 'تکمیل شد' };
}

async function createTransaction(txid, fromAcc, toAcc, amount, status) {
    await supabase
        .from('transactions')
        .insert([{
            txid: txid,
            from_acc: fromAcc,
            to_acc: toAcc,
            amount: amount,
            status: status
        }]);
}

async function addRegisterCode(code) {
    code = (code || '').trim();
    if (!code) {
        return { success: false, error: 'کد نمی‌تواند خالی باشد.' };
    }

    const { error } = await supabase
        .from('register_codes')
        .insert([{ code: code }]);

    if (error) {
        return { success: false, error: 'کد از قبل وجود دارد.' };
    }

    return { success: true };
}

async function createBusinessAccount(ownerTgId, name) {
    let accountId;
    let isUnique = false;
    
    while (!isUnique) {
        accountId = generateAccountId('BUS-', 5);
        const { data: existingAccount } = await supabase
            .from('accounts')
            .select('account_id')
            .eq('account_id', accountId)
            .single();
            
        if (!existingAccount) {
            isUnique = true;
        }
    }

    const { error } = await supabase
        .from('accounts')
        .insert([{
            account_id: accountId,
            owner_tg_id: ownerTgId,
            type: 'BUSINESS',
            name: name,
            balance: 0
        }]);

    if (error) {
        return { accountId: null, error: 'خطا در ایجاد حساب بیزینسی.' };
    }

    return { accountId };
}

async function canUseAccount(tgId, accountId, mustBeType = null) {
    const { data } = await supabase
        .from('accounts')
        .select('type')
        .eq('account_id', accountId)
        .eq('owner_tg_id', tgId)
        .single();

    if (!data) return false;
    if (mustBeType && data.type !== mustBeType) return false;
    
    return true;
}

async function transferAccountOwnership(accountId, newOwnerTgId) {
    const { data: account } = await supabase
        .from('accounts')
        .select('account_id')
        .eq('account_id', accountId)
        .single();

    if (!account) {
        return { success: false, error: 'حساب پیدا نشد.' };
    }

    const { error } = await supabase
        .from('accounts')
        .update({ owner_tg_id: newOwnerTgId })
        .eq('account_id', accountId);

    if (error) {
        return { success: false, error: 'خطا در انتقال مالکیت.' };
    }

    return { success: true };
}

async function listAllUsers() {
    const { data, error } = await supabase
        .from('users')
        .select('tg_id, username, full_name, personal_account')
        .order('full_name', { ascending: true, nullsFirst: false });

    return data || [];
}

async function addAdmin(tgId, name) {
    await supabase
        .from('admins')
        .upsert([{
            tg_id: tgId,
            name: name
        }], { onConflict: 'tg_id' });
}

async function removeAdmin(tgId) {
    await supabase
        .from('admins')
        .delete()
        .eq('tg_id', tgId);
}

async function listAdmins() {
    const { data, error } = await supabase
        .from('admins')
        .select('tg_id, name')
        .order('name', { ascending: true, nullsFirst: false });

    return data || [];
}

async function isAdmin(tgId) {
    const { data } = await supabase
        .from('admins')
        .select('tg_id')
        .eq('tg_id', tgId)
        .single();

    return !!data;
}

async function isBankOwner(tgId) {
    return parseInt(tgId) === BANK_OWNER_ID;
}

async function deleteAccount(accountId) {
    accountId = accountId.toUpperCase();
    if (accountId === 'ACC-001') {
        return { success: false, error: 'نمی‌توان حساب بانک اصلی را حذف کرد.' };
    }

    const { error } = await supabase
        .from('accounts')
        .delete()
        .eq('account_id', accountId);

    if (error) {
        return { success: false, error: 'حساب پیدا نشد.' };
    }

    return { success: true };
}

async function deleteBusinessAccount(accountId) {
    const { error } = await supabase
        .from('accounts')
        .delete()
        .eq('account_id', accountId.toUpperCase())
        .eq('type', 'BUSINESS');

    if (error) {
        return { success: false, error: 'حساب بیزینسی پیدا نشد.' };
    }

    return { success: true };
}

// تابع تولید رسید
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

    // لوگو (در صورت وجود)
    try {
        const logo = await loadImage('assets/logo.png');
        const logoSize = W * 0.4;
        const lx = (W - logoSize) / 2;
        ctx.drawImage(logo, lx, 40, logoSize, logoSize);
    } catch (error) {
        console.log('لوگو پیدا نشد');
    }

    // عنوان بانک
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
        { label: 'Transaction ID:', value: txid },
        { label: 'Date:', value: date },
        { label: 'From Account:', value: fromAccount },
        { label: 'To Account:', value: toAccount },
        { label: 'Amount:', value: `${amount} Solen` },
        { label: 'Status:', value: status },
    ];

    ctx.textAlign = 'left';
    const xLabel = 100;
    const xVal = 350;

    lines.forEach((line, i) => {
        const y = startY + i * gap;
        
        ctx.fillStyle = white;
        ctx.font = '24px Arial';
        ctx.fillText(line.label, xLabel, y);
        
        const valueColor = (line.label === 'Status:' && line.value.toLowerCase() === 'completed') ? gold : white;
        ctx.fillStyle = valueColor;
        ctx.font = '26px Arial';
        ctx.fillText(line.value, xVal, y);
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

// ارسال رسید
async function sendReceipt(ctx, receiptPath, senderTgId, receiverTgId) {
    try {
        await ctx.telegram.sendPhoto(senderTgId, { source: receiptPath });
    } catch (error) {
        console.log('خطا در ارسال رسید به فرستنده:', error);
    }

    if (receiverTgId) {
        try {
            await ctx.telegram.sendPhoto(receiverTgId, { source: receiptPath });
        } catch (error) {
            console.log('خطا در ارسال رسید به گیرنده:', error);
        }
    }

    if (BANK_GROUP_ID) {
        try {
            await ctx.telegram.sendPhoto(BANK_GROUP_ID, { source: receiptPath });
        } catch (error) {
            console.log('خطا در ارسال رسید به گروه:', error);
        }
    }
}

// دستورات ربات
bot.start(async (ctx) => {
    await ctx.reply(WELCOME_TEXT);
});

bot.help(async (ctx) => {
    await ctx.reply(HELP_TEXT);
});

bot.command('register', async (ctx) => {
    const user = ctx.from;
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
        await ctx.reply('نحوهٔ استفاده: /register <code>');
        return;
    }

    const code = args[0].trim();
    const result = await createUser(user.id, user.username || '', user.first_name || '', code);

    if (result.error) {
        await ctx.reply(`❌ ${result.error}`);
        return;
    }

    await ctx.reply(`✅ حساب ساخته شد!\nID: ${result.accountId}\nBalance: 0 Solen`);

    if (BANK_GROUP_ID) {
        await ctx.telegram.sendMessage(
            BANK_GROUP_ID,
            `🟢 کاربر جدید: ${user.first_name} (@${user.username || 'no-username'}) — TGID: ${user.id}\nAccount: ${result.accountId}`
        );
    }
});

bot.command('balance', async (ctx) => {
    const user = await getUserByTgId(ctx.from.id);
    if (!user) {
        await ctx.reply('⛔ حسابی پیدا نشد.');
        return;
    }

    const accounts = await listUserAccounts(ctx.from.id);
    if (!accounts || accounts.length === 0) {
        await ctx.reply('⛔ هیچ حسابی ندارید.');
        return;
    }

    const mainAcc = accounts.find(a => a.type === 'PERSONAL') || accounts[0];
    await ctx.reply(`📊 ${mainAcc.account_id}: ${mainAcc.balance} Solen`);
});

bot.command('myaccounts', async (ctx) => {
    const accounts = await listUserAccounts(ctx.from.id);
    if (!accounts || accounts.length === 0) {
        await ctx.reply('حسابی ندارید.');
        return;
    }

    const text = accounts.map(a => `- ${a.account_id} | ${a.type} | Balance: ${a.balance}`).join('\n');
    await ctx.reply('👛 حساب‌ها:\n' + text);
});

bot.command('transfer', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        await ctx.reply('نحوهٔ استفاده: /transfer <to_account_id> <amount>');
        return;
    }

    const user = await getUserByTgId(ctx.from.id);
    if (!user) {
        await ctx.reply('⛔ شما حساب ندارید.');
        return;
    }

    const toAcc = args[0].toUpperCase();
    const amount = parseAmount(args[1]);
    
    if (amount === null) {
        await ctx.reply('❌ مبلغ نامعتبر (باید > 0 باشد).');
        return;
    }

    const accounts = await listUserAccounts(ctx.from.id);
    if (!accounts || accounts.length === 0) {
        await ctx.reply('⛔ هیچ حسابی ندارید.');
        return;
    }

    const fromAcc = accounts.find(a => a.type === 'PERSONAL')?.account_id || accounts[0].account_id;
    const txid = 'TX-' + uuidv4().slice(0, 8).toUpperCase();

    const transferResult = await transferFunds(fromAcc, toAcc, amount);
    const receiver = await getUserByAccount(toAcc);
    
    await createTransaction(txid, fromAcc, toAcc, amount, transferResult.success ? 'Completed' : 'Failed');
    
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const receiptPath = await generateReceiptImage(txid, now, fromAcc, toAcc, amount, transferResult.success ? 'Completed' : 'Failed');
    
    const receiverTg = receiver ? receiver.tg_id : null;
    await sendReceipt(ctx, receiptPath, ctx.from.id, receiverTg);
    
    await ctx.reply(transferResult.success ? '✅ انجام شد!' : `❌ ${transferResult.error}`);
});

// دستورات جدید مدیریت ادمین
bot.command('transferowner', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (!await isAdmin(ctx.from.id) && !await isBankOwner(ctx.from.id)) {
        await ctx.reply('⛔ فقط ادمین.');
        return;
    }

    if (args.length < 2) {
        await ctx.reply('نحوهٔ استفاده: /transferowner <account_id> <new_owner_tg_id>');
        return;
    }

    const accountId = args[0].toUpperCase();
    const newOwnerTgId = parseInt(args[1]);

    if (isNaN(newOwnerTgId)) {
        await ctx.reply('❌ new_owner_tg_id باید عدد باشد.');
        return;
    }

    const newOwner = await getUserByTgId(newOwnerTgId);
    if (!newOwner) {
        await ctx.reply('❌ مالک جدید هنوز /register نکرده.');
        return;
    }

    const result = await transferAccountOwnership(accountId, newOwnerTgId);
    await ctx.reply(result.success ? '✅ مالکیت منتقل شد.' : `❌ ${result.error}`);
});

bot.command('listadmins', async (ctx) => {
    if (!await isBankOwner(ctx.from.id)) {
        await ctx.reply('⛔ فقط مالک بانک.');
        return;
    }

    const admins = await listAdmins();
    if (!admins || admins.length === 0) {
        await ctx.reply('ادمینی وجود ندارد.');
        return;
    }

    const text = admins.map(admin => `- ${admin.name} (${admin.tg_id})`).join('\n');
    await ctx.reply('👑 ادمین‌ها:\n' + text);
});

bot.command('removeadmin', async (ctx) => {
    if (!await isBankOwner(ctx.from.id)) {
        await ctx.reply('⛔ فقط مالک بانک.');
        return;
    }

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
        await ctx.reply('نحوهٔ استفاده: /removeadmin <telegram_id>');
        return;
    }

    const tgId = parseInt(args[0]);
    if (isNaN(tgId)) {
        await ctx.reply('❌ <telegram_id> باید عدد باشد.');
        return;
    }

    await removeAdmin(tgId);
    await ctx.reply(`✅ ادمین حذف شد: ${tgId}`);
});

// دستورات دیگر (مشابه نمونه بالا)...
// [اینجا بقیه دستورات مانند newcode, createbusiness, bankadd, banktake و غیره اضافه شوند]

// راه‌اندازی ربات
async function startBot() {
    try {
        await initDatabase();
        console.log('✅ Database initialized');
        
        await bot.launch();
        console.log('🤖 Bot started successfully');
        
        // Enable graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (error) {
        console.error('❌ Error starting bot:', error);
        process.exit(1);
    }
}

startBot();
