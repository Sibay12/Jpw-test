require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { hashPassword, verifyPassword } = require('./utils/passwords');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage, EditedMessage } = require("telegram/events");
const { debugLog, getRecentLogs, getAllLogs, getLogFilePath } = require('./utils/logger');
const { buildXlsx } = require('./utils/xlsx');
const adsModule = require('./adsModule');
const { startKeepAlive, keepAliveMiddleware, getPublicBase } = require('./utils/keepAlive');

process.on('uncaughtException', (err) => {
    debugLog('CrashGuard', 'Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    debugLog('CrashGuard', 'Unhandled Rejection:', reason);
});

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy -> correct client IP / https
app.use(express.json({ limit: '3mb' }));   // 3 MB: offer images (max 1 MB) travel as base64
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(keepAliveMiddleware); // learns the public URL automatically for the self-ping
// Lightweight health endpoint (used by the Render anti-sleep auto-ping)
app.get('/health', (req, res) => { res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()) }); });

// ================= 🛠️ MAINTENANCE MODE =================
// One switch in the Admin Panel. While ON: every portal page shows the maintenance page (no login possible),
// every user API call is refused with 503, and both Telegram bots answer with the maintenance message.
// Kept open on purpose: admin panel + admin API, health check, payment webhooks / internal bot API (so money already paid is still credited).
const MAINT_DEFAULT_WA = String(process.env.WHATSAPP_NUMBER || '919382856020').replace(/\D/g, '');
const maintenance = { enabled: false, whatsapp: MAINT_DEFAULT_WA, since: null };
global.__JPW_MAINTENANCE = maintenance; // bot.js (runs in this same process) reads this object
const MAINT_OPEN_PREFIXES = ['/admin', '/api/admin', '/api/maintenance-status', '/api/payment-webhook', '/api/external/v1', '/health'];
const MAINT_TEXT_ON = 'Complete system is going into Maintenance Mode for now. Login and orders are paused on all portals and bots. Please try again later.';
const MAINT_TEXT_OFF = 'Maintenance completed successfully! Server is LIVE again - you can use the portals and bot as usual.';
const maintMessage = () => `🛠️ ${MAINT_TEXT_ON}\n\n🆘 Help (WhatsApp only): +${maintenance.whatsapp}`;

function maintenancePageHtml() {
    const wa = String(maintenance.whatsapp || '').replace(/\D/g, '');
    const link = wa ? `https://wa.me/${wa}?text=${encodeURIComponent('Hello, I need help (site is in maintenance mode).')}` : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Maintenance Mode</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Segoe UI',Tahoma,Verdana,sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#311042 100%);color:#f8fafc;text-align:center}
.card{max-width:420px;width:100%;background:rgba(15,23,42,.85);border:1px solid rgba(168,85,247,.45);border-radius:24px;padding:32px 24px;box-shadow:0 0 40px rgba(168,85,247,.25)}
.ico{font-size:56px;margin-bottom:8px}h1{font-size:20px;margin:0 0 12px;color:#fbbf24;text-transform:uppercase;letter-spacing:1px}p{font-size:14px;line-height:1.6;color:#cbd5e1;margin:0 0 10px}
a.wa{display:block;margin-top:18px;padding:13px;border-radius:14px;background:rgba(16,185,129,.12);border:1px solid #10b981;color:#34d399;font-weight:700;text-decoration:none;font-size:14px}
.num{font-family:monospace;color:#34d399}small{display:block;margin-top:16px;color:#64748b;font-size:11px}</style></head>
<body><div class="card"><div class="ico">🛠️</div><h1>Maintenance Mode</h1>
<p>${MAINT_TEXT_ON}</p><p>सिस्टम अभी मेंटेनेंस मोड में है। कृपया थोड़ी देर बाद आएँ।</p>
${link ? `<a class="wa" href="${link}" target="_blank" rel="noopener">💬 Help on WhatsApp: <span class="num">+${wa}</span></a>` : ''}
<small>This page refreshes automatically when the system is back.</small></div>
<script>setInterval(function(){fetch('/api/maintenance-status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d&&d.enabled===false)location.reload()}).catch(function(){})},15000);</script>
</body></html>`;
}

app.use((req, res, next) => {
    if (!maintenance.enabled) return next();
    const p = req.path;
    if (MAINT_OPEN_PREFIXES.some(x => p === x || p.startsWith(x + '/') || p.startsWith(x + '.'))) return next();
    res.set({ 'Cache-Control': 'no-store', 'Retry-After': '300', 'X-Maintenance': '1' });
    if (p.startsWith('/api/')) return res.status(503).json({ success: false, maintenance: true, message: maintMessage() });
    return res.status(503).type('html').send(maintenancePageHtml());
});

app.get('/api/maintenance-status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, enabled: maintenance.enabled, whatsapp: maintenance.whatsapp, since: maintenance.since });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_SECRET_PASS = process.env.ADMIN_SECRET_PASS;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Environment check: only MONGO_URI is fatal. Anything else missing is reported loudly but the
// website keeps running (so login/register never die just because one optional secret is missing).
const REQUIRED_ENV_VARS = ['MONGO_URI', 'ADMIN_SECRET_PASS', 'ADMIN_CHAT_ID', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'PRIVATE_PG_URL', 'PRIVATE_API_KEY', 'CUSTOMER_BOT_TOKEN', 'ADMIN_BOT_TOKEN', 'INTERNAL_API_SECRET'];
const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is missing - cannot start without a database. Set it in Render > Environment.');
    process.exit(1);
}
if (missingVars.length > 0) {
    console.error(`⚠️ Missing environment variables (related features will not work): ${missingVars.join(', ')}`);
}

// 🔑 Telegram Userbot MTProto Credentials
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const HARDCODED_SESSION_STRING = process.env.HARDCODED_SESSION_STRING;

const TARGET_THIRD_PARTY_BOT = process.env.TARGET_BOT_USERNAME || '@JPWREACHEDBOT';

let userbotClient = null;
const activeCheckIntervals = {};

// 💳 Private Payment Gateway Configuration
const PRIVATE_PG_URL = process.env.PRIVATE_PG_URL;
const PRIVATE_API_KEY = process.env.PRIVATE_API_KEY;

// 🤖 Customer Bot Token & Admin Bot Token
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN;
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;

// 🔐 Internal API secret — required header for admin & external bot-to-server routes
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// ---------- small security helpers ----------
function safeEqual(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
}

// in-memory failed-attempt limiter (per key)
const rlHits = new Map();
function isBlocked(key, max) { const h = rlHits.get(key); return !!(h && h.reset > Date.now() && h.n >= max); }
function addFail(key, windowMs) {
    const now = Date.now();
    let h = rlHits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; rlHits.set(key, h); }
    h.n++;
}
function clearFails(key) { rlHits.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, v] of rlHits) if (v.reset < now) rlHits.delete(k); }, 10 * 60 * 1000).unref();

function requireAdminAuth(req, res, next) {
    const key = `adm|${req.ip}`;
    if (isBlocked(key, 10)) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again in 15 minutes.' });
    const providedPass = req.body?.adminPass || req.body?.pin || req.headers['x-admin-pass'];
    if (!ADMIN_SECRET_PASS || !providedPass || !safeEqual(providedPass, ADMIN_SECRET_PASS)) {
        addFail(key, 15 * 60 * 1000);
        return res.status(401).json({ success: false, message: 'Unauthorized: invalid or missing admin credentials' });
    }
    next();
}

function requireInternalAuth(req, res, next) {
    const providedSecret = req.headers['x-internal-secret'];
    if (!INTERNAL_API_SECRET || !providedSecret || !safeEqual(providedSecret, INTERNAL_API_SECRET)) {
        return res.status(401).json({ success: false, message: 'Unauthorized: invalid or missing internal secret' });
    }
    next();
}

// ---------- user sessions (signed token issued at login / OTP / Telegram mini-app) ----------
// Stateless HMAC token: <b64url(chatId)>.<expiry>.<signature>. Same secret after every restart.
const SESSION_SECRET = process.env.SESSION_SECRET
    || ((INTERNAL_API_SECRET || ADMIN_SECRET_PASS || MONGO_URI)
        ? crypto.createHash('sha256').update('jpw-session:' + [INTERNAL_API_SECRET, ADMIN_SECRET_PASS, MONGO_URI].join('|')).digest('hex')
        : crypto.randomBytes(32).toString('hex'));
const SESSION_DAYS = 30;
function issueToken(chatId) {
    const body = Buffer.from(String(chatId)).toString('base64url');
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`${body}.${exp}`).digest('hex');
    return `${body}.${exp}.${sig}`;
}
function readToken(token) {
    try {
        const [body, exp, sig] = String(token || '').split('.');
        if (!body || !exp || !sig || Number(exp) < Date.now()) return null;
        const good = crypto.createHmac('sha256', SESSION_SECRET).update(`${body}.${exp}`).digest('hex');
        if (!safeEqual(sig, good)) return null;
        return Buffer.from(body, 'base64url').toString();
    } catch (e) { return null; }
}
function tokenFromReq(req) {
    return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-user-token'] || '');
}
// Logged-in users only. The chat id comes from the signed token, never from the browser body.
// The bot (bot.js) can call with the internal secret instead.
function requireUser(req, res, next) {
    const internal = req.headers['x-internal-secret'];
    if (internal && INTERNAL_API_SECRET && safeEqual(internal, INTERNAL_API_SECRET)) return next();
    const chatId = readToken(tokenFromReq(req));
    if (!chatId) return res.status(401).json({ success: false, authExpired: true, message: 'Session expired. Please login again.' });
    req.authChatId = chatId;
    if (!req.body || typeof req.body !== 'object') req.body = {};
    req.body.telegramChatId = chatId;
    req.body.senderChatId = chatId;
    next();
}

// Telegram Mini App: verify the signed initData that Telegram gives the page (cannot be forged without the bot token)
function verifyTelegramInitData(initData, botToken) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');
        const check = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
        if (!safeEqual(calc, hash)) return null;
        const authDate = Number(params.get('auth_date') || 0);
        if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
        return JSON.parse(params.get('user') || 'null');
    } catch (e) { return null; }
}

// Public website address, detected automatically (env, Render, or learned from the first request)
function publicBase(req) {
    return getPublicBase() || (req ? `${req.protocol}://${req.get('host')}` : '') || 'https://cashtree.space';
}

// While MongoDB is (re)connecting, answer clearly instead of hanging for 10 seconds and then failing
const NO_DB_ROUTES = new Set(['/api/packages', '/api/service-hours', '/api/external/v1/packages', '/api/call-complete-submit', '/api/sr-submit', '/api/admin/login']);
app.use('/api', (req, res, next) => {
    if (mongoose.connection.readyState === 1 || NO_DB_ROUTES.has(req.originalUrl.split('?')[0])) return next();
    res.status(503).json({ success: false, message: 'Server is starting (database connecting). Please try again in a few seconds.' });
});

// 📦 Telegram Referral Bot Pricing Chart (₹20 = 1 Coin)
const BOT_RECHARGE_PACKAGES = [
    { amount: 20, coins: 1, commission: 5 },
    { amount: 55, coins: 3, commission: 3 },
    { amount: 105, coins: 7, commission: 2 },
    { amount: 210, coins: 15, commission: 1 }
];

// 📦 Web Portal Pricing Chart (₹13 = 1 Coin - Original Rates)
let waPackCount = 5;   // number of packages shown in the WhatsApp list (regular + live offers) - set right before the list is sent
const WEB_RECHARGE_PACKAGES = [
    { amount: 13, coins: 1 },
    { amount: 60, coins: 5 },
    { amount: 115, coins: 10 },
    { amount: 210, coins: 20 },
    { amount: 400, coins: 40 }
];

let otpStorage = {};

// Referral codes are random JPW + 4 digits (only 9000 combinations) and must be unique:
// check the DB first so a clash never crashes registration.
async function generateUniqueReferralCode() {
    for (let i = 0; i < 20; i++) {
        const code = `JPW${Math.floor(1000 + Math.random() * 9000)}`;
        if (!(await UserModel.exists({ referralCode: code }))) return code;
    }
    return `JPW${Date.now().toString().slice(-7)}`; // fallback when the 4-digit space is crowded
}

// 📊 Google Sheet Logger Function
// The URL is now saved from Admin Panel > Connections > Google Sheet (stored in the database).
// The GOOGLE_SHEET_SCRIPT_URL environment variable is only used as a fallback while nothing is saved in the panel.
let sheetUrlFromPanel = '';
function getSheetScriptUrl() { return sheetUrlFromPanel || process.env.GOOGLE_SHEET_SCRIPT_URL || ''; }
async function loadSheetUrl() {
    try { sheetUrlFromPanel = (await getSettingValue('google_sheet_script_url')) || ''; debugLog('Sheet', sheetUrlFromPanel ? 'Google Sheet URL loaded from Admin Panel setting.' : (process.env.GOOGLE_SHEET_SCRIPT_URL ? 'Using GOOGLE_SHEET_SCRIPT_URL environment variable (fallback).' : 'No Google Sheet URL set yet.')); }
    catch (e) { debugLog('Sheet', 'load failed:', e.message); }
}
function sendLogToGoogleSheet(payload, onDone) {
    const scriptUrl = getSheetScriptUrl();
    if (!scriptUrl) { if (onDone) onDone(new Error('Google Sheet URL set nahi hai.')); return; }
    let urlObj;
    try { urlObj = new URL(scriptUrl); } catch (e) { debugLog('Sheet', 'Invalid Google Sheet URL saved.'); if (onDone) onDone(new Error('URL galat hai.')); return; }
    const dataString = JSON.stringify(payload);

    const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dataString)
        }
    };

    const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => { if (onDone) onDone(null, res.statusCode, responseBody.slice(0, 200)); });
    });

    req.on('error', (err) => { if (onDone) onDone(err); });
    req.setTimeout(15000, () => req.destroy(new Error('Timeout (15s)')));
    req.write(dataString);
    req.end();
}

// 🕒 Service hours (IST). Default 08:00-22:00; admin can change from the Admin Panel.
// Stored in the DB (Setting key 'service_hours') so it survives restarts, cached in memory for speed.
const DEFAULT_SERVICE_HOURS = { enabled: true, open: '08:00', close: '22:00' };
let serviceHours = { ...DEFAULT_SERVICE_HOURS };

function isValidHHMM(v) { return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
function hhmmToMinutes(v) { const [h, m] = v.split(':').map(Number); return h * 60 + m; }
function formatHHMM12(v) {
    const [h, m] = v.split(':').map(Number);
    return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function describeServiceHours() { return `${formatHHMM12(serviceHours.open)} - ${formatHHMM12(serviceHours.close)} (IST)`; }

async function loadServiceHours() {
    try {
        const doc = await SettingModel.findOne({ key: 'service_hours' }).lean();
        if (doc && doc.value) {
            const parsed = JSON.parse(doc.value);
            if (isValidHHMM(parsed.open) && isValidHHMM(parsed.close)) {
                serviceHours = { enabled: parsed.enabled !== false, open: parsed.open, close: parsed.close };
            }
        }
        debugLog('ServiceHours', `Loaded: ${serviceHours.enabled ? describeServiceHours() : 'Always open'}`);
    } catch (e) {
        debugLog('ServiceHours', 'Load failed, using defaults:', e.message);
        serviceHours = { ...DEFAULT_SERVICE_HOURS };
    }
}

function isServiceOpen() {
    try {
        if (!serviceHours.enabled) return true; // time limit switched off by admin
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
        const h = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
        const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
        const nowMin = h * 60 + m;
        const openMin = hhmmToMinutes(serviceHours.open);
        const closeMin = hhmmToMinutes(serviceHours.close);
        if (openMin === closeMin) return true;                       // same time = 24 hours
        if (openMin < closeMin) return nowMin >= openMin && nowMin < closeMin;
        return nowMin >= openMin || nowMin < closeMin;               // overnight window, e.g. 20:00 - 06:00
    } catch (e) {
        debugLog('ServiceHours', 'isServiceOpen error, defaulting to open:', e.message);
        return true;
    }
}

// The bot's "Work Orders:" list (header line, then the entries below it) - cut out of the generic text,
// and shown to the customer separately only when the bot actually sends it.
const WORK_ORDERS_HEADER_RE = /^[^\S\n]*(?:[^\w\s]+\s*)?work\s*orders\s*:[^\S\n]*$/im;
function extractWorkOrdersBlock(rawText) {
    const idx = String(rawText || '').search(WORK_ORDERS_HEADER_RE);
    if (idx < 0) return '';
    const lines = rawText.slice(idx).split('\n');
    const BLANK = /^(?:n\/?a|null|none|nil|undefined|-+|\u2014+|\u2013+|\.+)$/i;
    const kept = [lines[0].trim()];
    let entries = 0;
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        if (/^\s*\d+[.)]\s*$/.test(line)) continue;                 // numbered line with nothing after the number
        if (/^\s*\d+[.)]\s*\S/.test(line)) { entries++; kept.push(line.replace(/\s+$/, '')); continue; }
        // detail line (name, phone, location...): keep only when the bot filled in a real value
        const core = line.replace(/^[^\w]+/, '').trim();
        const val = core.replace(/^[A-Za-z ]{1,20}:\s*/, '').trim();
        if (!val || BLANK.test(val)) continue;
        kept.push(line.replace(/\s+$/, ''));
    }
    return entries > 0 ? kept.join('\n') : '';                          // header with no entries = nothing to show
}

function sanitizeCustomerMessage(rawText) {
    if (!rawText) return '';
    const woIdx = rawText.search(WORK_ORDERS_HEADER_RE);
    if (woIdx >= 0) rawText = rawText.slice(0, woIdx);
    const getCurrentTime = () => {
        return new Date().toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    };

    let sanitized = rawText
        .split('\n')
        .filter(line => {
            const lower = line.toLowerCase();
            return !lower.includes('remaining reaches') &&
                    !lower.includes('plan:') &&
                    !lower.includes('valid till') &&
                    !lower.includes('subscription') &&
                    !lower.includes('use money on next reach') &&
                    !lower.includes('wallet balance:') &&
                    !lower.includes('work order:') &&
                    !lower.includes('remaining') &&
                    !lower.includes('plan');
        })
        .join('\n');

    sanitized = sanitized.replace(/approx\s*(\d{1,2}):(\d{2})\s?(am|pm|AM|PM)/gi, (match, h, m, ampm) => {
        let hours = parseInt(h);
        let minutes = parseInt(m) + 2; 
        let period = ampm;

        if (minutes >= 60) {
            minutes -= 60;
            hours += 1;
            if (hours === 12) {
                period = period.toLowerCase() === 'am' ? 'PM' : 'AM';
            } else if (hours > 12) {
                hours = 1;
            }
        }
        const formattedMin = minutes < 10 ? '0' + minutes : minutes;
        return `approx ${hours}:${formattedMin}${period}`;
    });

    sanitized = sanitized.replace(/\d{1,2}:\d{2}\s?(am|pm|AM|PM)/gi, getCurrentTime());
    sanitized = sanitized.replace(/(completed in \d+s|\d+\s*min[s]? ago|\d+\s*minute[s]? ago)/gi, `Completed just now (${getCurrentTime()})`);

    return sanitized.replace(/\n{3,}/g, '\n\n').trim();
}

// Extra lines for the customer message: wallet balance (only if > 0), plan expiry (only if one is running),
// and the bot's Work Orders list (only if the bot sent it).
async function buildCustomerExtras(telegramChatId, rawText) {
    const lines = [];
    try {
        const user = await UserModel.findOne({ telegramChatId: String(telegramChatId) });
        if (user) {
            const coins = round2(user.jpwCoins || 0);
            if (coins > 0) lines.push(`📍 Remaining Reaches: ${Number.isInteger(coins) ? coins : coins.toFixed(2)}`);
            if (user.packageExpiryTime && new Date(user.packageExpiryTime) > new Date()) {
                const d = new Date(user.packageExpiryTime).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
                lines.push(`🗓️ Plan valid till: ${d}`);
            }
        }
    } catch (e) { debugLog('Userbot', 'buildCustomerExtras error:', e.message); }
    const wo = extractWorkOrdersBlock(rawText);
    if (wo) lines.push('', wo);
    return lines.join('\n').trim();
}

// Sends with Markdown; if Telegram rejects the formatting (names/symbols), resends as plain text instead of dropping it.
async function sendCustomerMessage(bot, chatId, text) {
    if (String(chatId).startsWith('wa:')) return waNotify(String(chatId), text);   // WhatsApp customer: reply goes to WhatsApp
    if (!bot || String(chatId).startsWith('WEB_') || String(chatId) === 'ADMIN_TEST') return; // web/app users read the order reply from the portal
    try { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
    catch (e) {
        try { await bot.sendMessage(chatId, text.replace(/[*_`]/g, '')); }
        catch (e2) { debugLog('Userbot', 'Customer notify failed:', e2.message); }
    }
}

// ---- Fully customised customer messages. The bot's own text is NEVER forwarded to the customer (it can contain the
// bot account's reaches/plan/etc.); we only read the status from it and send our own message with the customer's data.
function istClock(d = new Date()) {
    return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
}
function approxFinishTime(rawText) {                       // "approx 12:46 PM" -> "12:48 PM" (same +2 min buffer as before)
    const m = String(rawText || '').match(/approx\s*(\d{1,2}):(\d{2})\s?(am|pm)/i);
    if (!m) return '';
    const total = (((parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + parseInt(m[2], 10) + 2) % 1440;
    const hh = Math.floor(total / 60), mm = total % 60;
    return `${(hh % 12) || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}
const plainText = t => String(t || '').replace(/[*_`]/g, '');

function buildCustomerMessage(kind, c) {
    const id = `👤 Tech ID: \`${c.targetId}\``;
    const refund = '🪙 _1 Coin has been refunded to your wallet._';
    const tail = c.extras ? `\n\n${c.extras}` : '';
    const hasWO = c.workOrderId && c.workOrderId !== 'N/A';
    switch (kind) {
        case 'queued': {
            const q = (String(c.rawText).match(/queue:\s*(\d+\s*\/\s*\d+)/i) || [])[1];
            const eta = approxFinishTime(c.rawText);
            return `⏳ **ORDER IN QUEUE**\n\n${id}${q ? `\n📍 Queue: ${q.replace(/\s/g, '')}` : ''}${eta ? `\n🕐 Expected by: ~${eta}` : ''}\n\n⚠️ Please do not login to this ID until the process is complete.`;
        }
        case 'received':
            return `🔄 **ORDER RECEIVED**\n\n${id}\n\nYour order has been received. Work will start shortly.`;
        case 'checking':
            return `🔒 **SECURITY CHECK IN PROGRESS**\n\n${id}\n\nYour ID is being checked. You will get the final status shortly.\n\n⚠️ Please do not login to this ID meanwhile.`;
        case 'working':
            return `⚙️ **WORKING ON YOUR ORDER**\n\n${id}\n⏱️ This can take up to 5 minutes.\n\n⚠️ Please do not login to this ID meanwhile.`;
        case 'verifying':
            return `🔎 **REACH DONE - VERIFYING**\n\n${id}\n✅ Reach completed at ${istClock()}\n\nFinal verification is in progress. You will get the final status shortly.`;
        case 'success':
            return `✅ **REACHED SUCCESSFULLY**\n\n${id}\n📋 Work Order: \`${c.workOrderId || 'N/A'}\`\n📊 Status: SUCCESS${tail}`;
        case 'locked':
            return `🔒 **ACCOUNT LOCKED**\n\n${id}\n\nThis Tech ID is locked. Please reset its password, then place the order again.\n\n${refund}${tail}`;
        case 'credentials':
            return `🔑 **LOGIN FAILED**\n\n${id}\n\nThe ID or password was not accepted. Please check them and place the order again.\n\n${refund}${tail}`;
        case 'verifyFailed':
            return `❌ **VERIFICATION FAILED - ORDER CANCELLED**\n\n${id}${hasWO ? `\n📋 Work Order: \`${c.workOrderId}\`` : ''}\n📊 Status: Not Reached\n\nPlease place the order again with your credentials.\n\n${refund}${tail}`;
        case 'timeout':
            return `⏰ **ORDER CANCELLED - TIMEOUT**\n\n${id}\n\nYour order was not completed within 30 minutes, so it has been cancelled.\nPlease place the order again.\n\n${refund}`;
        default:
            return `❌ **ORDER CANCELLED**\n\n${id}\n\nYour order could not be completed. Please try again.\n\n${refund}${tail}`;
    }
}

// The bot edits one message 2-3 times (queued -> processing -> final). Each edit has new text, so process every
// distinct version once, but skip an edit event that carries exactly the same text we already handled.
const seenBotMessages = new Map();
const botMsgWatchers = new Map();      // orderId -> interval: re-reads the bot's message every 5s until its text changes to a final status
let startBotMsgWatch = null;           // set once the userbot is connected
function alreadyHandledBotMessage(message, rawText) {
    const key = String(message.id);
    if (seenBotMessages.get(key) === rawText) return true;
    seenBotMessages.set(key, rawText);
    if (seenBotMessages.size > 500) seenBotMessages.delete(seenBotMessages.keys().next().value);
    return false;
}

// 🔧 FIX: this used to re-send the Tech ID + password to the third-party bot every 2 minutes, which made the
// bot place the same order again and again. An order is now sent ONCE; progress is picked up only by reading the
// bot's replies (live events + the 10s edit-poll below). This function is kept as a harmless no-op.
function startAutoRecheck(orderId) {
    debugLog('Userbot', `Order ${orderId}: waiting for the final reply (no re-sending).`);
}

function stopAutoRecheck(orderId) {
    if (activeCheckIntervals[orderId]) {
        clearInterval(activeCheckIntervals[orderId]);
        delete activeCheckIntervals[orderId];
    }
}

async function notifyAdminAndUser(order, messageText) {
    try {
        if (ADMIN_BOT_TOKEN) {
            const tempBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: false });
            await tempBot.sendMessage(ADMIN_CHAT_ID, messageText, { parse_mode: 'Markdown' });
        }
    } catch (e) {}
}

function startSmartGreetingsTimer() {
    setInterval(async () => {
        try {
            if (maintenance.enabled) return; // no greetings while the system is in maintenance
            const users = await UserModel.find({ telegramChatId: { $not: /^(WEB_|wa:)/ } });
            if (users.length === 0 || !CUSTOMER_BOT_TOKEN) return;

            const tempBot = new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false });
            const istHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getHours();

            let greetingOptions = [];
            if (istHour >= 6 && istHour < 11) {
                greetingOptions = [
                    "🌅 **Good Morning, Engineer!**\n\nHope you had a great sleep. Have a productive day ahead! ☕🚀",
                    "☀️ **Good Morning!**\n\nSubah ka waqt fresh energy ka hota hai. Have a wonderful day! 🥐"
                ];
            } else if (istHour >= 11 && istHour < 16) {
                greetingOptions = [
                    "☀️ **Good Afternoon, Engineer!**\n\nDoophoor ka waqt ho gaya hai. Thoda break lijiye, lunch kar lijiye! 🥗🍽️",
                    "🍽️ **Lunch Time Reminder!**\n\nKaam ke beech mein lunch karna na bhooliyega! 🍛"
                ];
            } else if (istHour >= 16 && istHour < 20) {
                greetingOptions = [
                    "🌆 **Good Evening, Engineer!**\n\nShaam ki chai ka waqt ho chuka hai. Relax hokar baaki ke tasks pure kijiye! ☕",
                    "🌇 **Evening Vibes!**\n\nDin ka kafi kaam ho chuka hai. Thoda break lijiye. 🍪"
                ];
            } else {
                greetingOptions = [
                    "🌙 **Good Night, Engineer!**\n\nRaat ho chuki hai, ab aaram kijiye! 🌌",
                    "🌙 **Late Night Check!**\n\nService hours close hone wale hain. Good night! 😴"
                ];
            }

            const randomMsg = greetingOptions[Math.floor(Math.random() * greetingOptions.length)];
            for (let u of users) {
                try { await tempBot.sendMessage(u.telegramChatId, randomMsg, { parse_mode: 'Markdown' }); } catch (err) {}
            }
        } catch (e) {}
    }, 40 * 60 * 1000);
}

// 🪙 COIN SYSTEM
// jpwCoins   = total coins the user sees and spends.
// bonusCoins = the part of jpwCoins that came from Daily Bonus.
// Package coins = jpwCoins - bonusCoins. Package coins expire after 28 days, bonus coins never do,
// and a Daily Bonus never blocks buying a package. Orders spend package coins first (they expire sooner).
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
function packageCoinsOf(user) { return Math.max(0, round2((user.jpwCoins || 0) - (user.bonusCoins || 0))); }

// Atomically takes 1 coin (safe against double-clicks / parallel requests). Returns the updated user, or null if not enough coins.
async function spendOneCoin(telegramChatId) {
    return UserModel.findOneAndUpdate(
        { telegramChatId: String(telegramChatId), jpwCoins: { $gte: 0.9999 } },
        [{ $set: {
            bonusCoins: { $round: [{ $max: [0, { $subtract: [
                { $ifNull: ['$bonusCoins', 0] },
                { $max: [0, { $subtract: [1, { $subtract: ['$jpwCoins', { $ifNull: ['$bonusCoins', 0] }] }] }] }
            ] }] }, 2] },
            jpwCoins: { $round: [{ $max: [0, { $subtract: ['$jpwCoins', 1] }] }, 2] }
        } }],
        { new: true }
    );
}

function startPackageExpiryTimer() {
    setInterval(async () => {
        try {
            const now = new Date();
            const expiredUsers = await UserModel.find({ packageExpiryTime: { $lte: now } });

            for (let user of expiredUsers) {
                const lostCoins = packageCoinsOf(user);
                // Only package coins are cleared — Daily Bonus coins stay
                user.jpwCoins = Math.min(round2(user.jpwCoins), round2(user.bonusCoins || 0));
                user.activePackage = 'Expired (28 Days completed)';
                user.packageExpiryTime = null;
                user.lastPackageCoins = 0;
                await user.save();

                if (lostCoins > 0 && CUSTOMER_BOT_TOKEN && !String(user.telegramChatId).startsWith('WEB_')) {
                    const tempBot = new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false });
                    await (String(user.telegramChatId).startsWith('wa:') ? waNotify(user.telegramChatId, `⚠ **Package Expired!**\n\nYour 28-day package validity has expired. Remaining package coins (${lostCoins}) have been cleared. Daily Bonus coins are safe.`) : tempBot.sendMessage(user.telegramChatId, `⚠ **Package Expired!**\n\nYour 28-day package validity has expired. Remaining package coins (${lostCoins}) have been cleared. Daily Bonus coins are safe.`, { parse_mode: 'Markdown' })).catch(()=>{});
                }
            }
        } catch (err) { debugLog('Expiry', 'timer error:', err.message); }
    }, 60 * 60 * 1000);
}

// Last messages exchanged with the third-party bot (what we sent, what it replied, what we did with it) - shown in the Admin Panel Test Lab.
const botLog = [];
function pushBotLog(entry) {
    const e = Object.assign({ t: new Date().toISOString() }, entry);
    botLog.push(e);
    if (botLog.length > 150) botLog.shift();
    return e;
}
let userbotTargetId = null; // numeric id of the third-party bot, used to ignore messages from every other chat
let userbotReconnectAttempts = 0;
let userbotCheckInterval = null;
let userbotPollInterval = null;
let userbotUpdatesKeepAlive = null;
let userbotReconnectTimer = null;

async function getSavedSessionString() {
    try {
        const doc = await SettingModel.findOne({ key: 'tg_session' }).lean();
        if (doc && doc.value) return { value: doc.value, source: 'db' };
    } catch (e) { debugLog('Userbot', 'Could not read session from DB:', e.message); }
    if (HARDCODED_SESSION_STRING) return { value: HARDCODED_SESSION_STRING, source: 'env' };
    return { value: '', source: 'none' };
}
let userbotSessionSource = 'none';

async function initUserbotBridge() {
    try {
        // Drop any previous client/interval so a fresh login can replace it cleanly
        if (userbotCheckInterval) { clearInterval(userbotCheckInterval); userbotCheckInterval = null; }
        if (userbotPollInterval) { clearInterval(userbotPollInterval); userbotPollInterval = null; }
        if (userbotUpdatesKeepAlive) { clearInterval(userbotUpdatesKeepAlive); userbotUpdatesKeepAlive = null; }
        if (userbotClient) { try { await userbotClient.disconnect(); } catch (e) {} userbotClient = null; }

        const saved = await getSavedSessionString();
        userbotSessionSource = saved.source;
        if (!saved.value) {
            debugLog('Userbot', '⏸️ No Telegram session yet. Login from Admin Panel (phone + OTP) to start the userbot bridge.');
            return;
        }
        const session = new StringSession(saved.value);
        userbotClient = new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });
        await userbotClient.connect();
        userbotReconnectAttempts = 0;
        debugLog('Userbot', '✅ Userbot bridge connected successfully.');
        try { const ent = await userbotClient.getEntity(TARGET_THIRD_PARTY_BOT); userbotTargetId = ent && ent.id != null ? String(ent.id) : null; } catch (e) { userbotTargetId = null; debugLog('Userbot', 'Could not resolve third-party bot id:', e.message); }

        const handleBotMessage = async (message, fromPoll = false) => {
            try {
                if (!message || message.out) return;
                const rawText = message.message || '';
                if (!rawText) return;
                // 🔧 FIX: the userbot account receives messages from EVERY chat. A live event is only trusted when it comes from the
                // third-party bot (the 10s poll below reads that bot's chat directly, so it is always safe).
                const peerKey = message.peerId ? String(message.peerId.userId || message.peerId.channelId || message.peerId.chatId || '') : '';
                if (!fromPoll && userbotTargetId && String(message.chatId) !== userbotTargetId && String(message.senderId) !== userbotTargetId && peerKey !== userbotTargetId) return;
                const text = rawText.toLowerCase();
                const logEntry = pushBotLog({ dir: 'IN', msgId: String(message.id), edited: !!message.editDate, via: fromPoll ? 'poll' : 'live', text: rawText, note: 'received' });

                // 🔧 FIX: only match orders that are NOT brand new ("New Reach Order" lines used to
                // break the whole loop for every pending order, not just skip the current one)
                if (rawText.includes('New Reach Order')) { if (fromPoll) seenBotMessages.set(String(message.id), rawText); return; }

                const pendingOrders = await OrderModel.find({ status: { $in: ['Pending', 'Accepted', 'In Progress'] } }).sort({ createdAt: 1 });
                if (pendingOrders.length === 0) { logEntry.note = 'ignored: no active order waiting'; return; }

                // 🔧 FIX: previously any single-pending-order case matched blindly even when the
                // target ID/password wasn't actually mentioned in the reply, which could misfile
                // a reply meant for a totally different order. Now we always require a positive
                // match on targetId or targetPass; falling back to the sole pending order only
                // when there is exactly one AND the reply doesn't look like a generic unrelated message.
                // The bot answers with ONE message and then EDITS that same message (Security Check -> final status).
                // So the strongest match is the Telegram message id we saw first; text match is the fallback.
                const mid = String(message.id);
                const normId = v => String(v || '').replace(/[^0-9a-z]/gi, '').replace(/^0+/, '').toLowerCase();
                const msgMs = Math.max(Number(message.date) || 0, Number(message.editDate) || 0) * 1000;
                let matchedOrder = pendingOrders.find(o => o.botMsgId && o.botMsgId === mid);
                let matchedVia = matchedOrder ? 'message id' : '';
                if (!matchedOrder) {
                    matchedOrder = pendingOrders.find(o => rawText.includes(o.targetId) || rawText.includes(o.targetPass));
                    if (matchedOrder) matchedVia = 'target id/password in text';
                }
                if (!matchedOrder) {   // same Tech ID written differently (leading zeros, spaces)
                    const techM = rawText.match(/Tech\s*ID\s*:\s*([A-Za-z0-9]+)/i);
                    const n = techM ? normId(techM[1]) : '';
                    if (n) { matchedOrder = pendingOrders.find(o => normId(o.targetId) === n); if (matchedOrder) matchedVia = 'tech id (normalized)'; }
                }
                if (!matchedOrder && pendingOrders.length === 1) {   // only one order is waiting and this is clearly the bot's format
                    const o1 = pendingOrders[0];
                    const botFormat = /tech\s*id|work\s*order|status\s*:|security check|reach/i.test(rawText);
                    const fresh = msgMs >= new Date(o1.createdAt).getTime() - 60 * 1000;
                    if (botFormat && fresh && !pendingOrders.some(o => o.botMsgId === mid)) { matchedOrder = o1; matchedVia = 'only one order waiting'; }
                }
                if (!matchedOrder) { const tm = rawText.match(/Tech\s*ID\s*:\s*([A-Za-z0-9]+)/i); logEntry.note = `ignored: no active order matches (Tech ID in message: ${tm ? tm[1] : 'none'}; waiting orders: ${pendingOrders.map(o => o.targetId).join(', ')})`; if (fromPoll) seenBotMessages.set(String(message.id), rawText); return; } // not ours: don't re-check every 10s
                // Safety net (poll path only): never apply an old message to a newer order - the message (or its last edit)
                // must be newer than the order itself
                if (fromPoll && matchedVia !== 'message id') {
                    if (msgMs < new Date(matchedOrder.createdAt).getTime() - 60 * 1000) { seenBotMessages.set(String(message.id), rawText); return; }
                }
                matchedOrder.botMsgId = mid;
                logEntry.matchedVia = matchedVia;
                if (startBotMsgWatch) startBotMsgWatch(String(matchedOrder._id), mid);
                if (alreadyHandledBotMessage(message, rawText)) { logEntry.note = 'skipped: same text already handled'; return; }

                const order = matchedOrder;
                logEntry.orderId = String(order._id); logEntry.targetId = order.targetId;
                const cleanedText = sanitizeCustomerMessage(rawText);
                order.adminReply = cleanedText;
                let customerBot = CUSTOMER_BOT_TOKEN ? new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false }) : null;
                let adminBot = ADMIN_BOT_TOKEN ? new TelegramBot(ADMIN_BOT_TOKEN, { polling: false }) : null;

                // Final success = the bot's "Status: SUCCESS" line (the earlier "Reach successful! Completed in 42s" is only
                // the work being done - verification is still pending, so that stays In Progress)
                const isFinalSuccess = /status:\s*success\b/.test(text);

                // Only a real "Work Order: <number>" line counts (never the Tech ID, never "N/A")
                const workOrderMatch = rawText.match(/Work\s*Order\s*:\s*(\d{5,})/i);
                let workOrderId = workOrderMatch ? workOrderMatch[1] : null;

                if (workOrderId && (!order.workOrderId || order.workOrderId === 'N/A')) {
                    order.workOrderId = workOrderId;
                }

                if (isFinalSuccess) {
                    stopAutoRecheck(order._id);
                    logEntry.note = '→ Completed';
                    order.status = 'Completed';
                    await order.save();

                    sendLogToGoogleSheet({
                        logType: 'ORDER',
                        type: 'REACH_COMPLETED',
                        telegramChatId: order.telegramChatId,
                        details: `Target: ${order.targetId}, WorkOrder:${order.workOrderId}`,
                        status: 'Completed'
                    });

                    try {
                        const orderOwner = await UserModel.findOne({ telegramChatId: order.telegramChatId });
                        if (orderOwner && orderOwner.referredBy && orderOwner.referredBy !== 'ADMIN_DIRECT') {
                            const referrer = await UserModel.findOne({ referralCode: orderOwner.referredBy });
                            if (referrer) {
                                let earnedComm = 5.00;
                                if (orderOwner.lastPackageCoins === 3) earnedComm = 3.00;
                                else if (orderOwner.lastPackageCoins === 7) earnedComm = 2.00;
                                else if (orderOwner.lastPackageCoins === 15) earnedComm = 1.00;

                                referrer.commissionBalance = (referrer.commissionBalance || 0) + earnedComm;
                                await referrer.save();
                            }
                        }
                    } catch (err) {
                        debugLog('Userbot', 'Commission credit error:', err.message);
                    }

                    const successExtras = await buildCustomerExtras(order.telegramChatId, rawText);
                    const successReplyFormat = buildCustomerMessage('success', { targetId: order.targetId, workOrderId: order.workOrderId, extras: successExtras });
                    order.adminReply = plainText(successReplyFormat);
                    await order.save();

                    await sendCustomerMessage(customerBot, order.telegramChatId, successReplyFormat);
                    if (adminBot) await adminBot.sendMessage(ADMIN_CHAT_ID, `🎉 **Order Complete & Commission Credited:** \`${order.targetId}\`\n\n${rawText}`, { parse_mode: 'Markdown' }).catch(err => debugLog('Userbot', 'Admin notify failed:', err.message));
                }
                else if (text.includes('locked') || text.includes('alert ls') || text.includes('account is locked') || text.includes('login failed') || text.includes('invalid credentials') || text.includes('reject') || text.includes('fail') || text.includes('error') || text.includes('status: fail') || text.includes('not verified') || text.includes('not reached') || text.includes('cancel')) {
                    stopAutoRecheck(order._id);
                    logEntry.note = '→ Rejected (coin refunded)';
                    order.status = 'Rejected';
                    await order.save();
                    await refundCoinTo(order.telegramChatId);

                    const failKind = ['locked', 'alert ls', 'account is locked'].some(k => text.includes(k)) ? 'locked'
                        : ['login failed', 'invalid credentials'].some(k => text.includes(k)) ? 'credentials'
                        : ['not verified', 'not reached', 'status: fail'].some(k => text.includes(k)) ? 'verifyFailed'
                        : 'failed';
                    const failExtras = await buildCustomerExtras(order.telegramChatId, rawText);
                    const failReply = buildCustomerMessage(failKind, { targetId: order.targetId, workOrderId: order.workOrderId, extras: failExtras });
                    order.adminReply = plainText(failReply);
                    await order.save();

                    sendLogToGoogleSheet({
                        logType: 'ORDER',
                        type: 'REACH_REJECTED',
                        telegramChatId: order.telegramChatId,
                        details: `Target: ${order.targetId} (Failed/Locked)`,
                        status: 'Rejected'
                    });

                    await sendCustomerMessage(customerBot, order.telegramChatId, failReply);
                    if (adminBot) await adminBot.sendMessage(ADMIN_CHAT_ID, `❌ **Order Rejected:** \`${order.targetId}\`\n\n${rawText}`, { parse_mode: 'Markdown' }).catch(()=>{});
                }
                else if (text.includes('security check') || text.includes('completed in') || text.includes('queued') || text.includes('queue:') || text.includes('starting reach') || text.includes('still reaching') || text.includes('processing your reach') || text.includes('processing reach') || text.includes('working on reach')) {
                    logEntry.note = '→ In Progress';
                    order.status = 'In Progress';
                    await order.save();
                    if (text.includes('completed in')) startAutoRecheck(order._id, order.targetId, order.targetPass);
                    const progKind = text.includes('completed in') ? 'verifying'
                        : text.includes('security check') ? 'checking'
                        : (text.includes('queued') || text.includes('queue:')) ? 'queued'
                        : (text.includes('processing your reach') || text.includes('processing reach')) ? 'received'
                        : 'working';
                    const progReply = buildCustomerMessage(progKind, { targetId: order.targetId, rawText });
                    order.adminReply = plainText(progReply);
                    await order.save();
                    await sendCustomerMessage(customerBot, order.telegramChatId, progReply);
                } else {
                    logEntry.note = '→ unrecognized reply pattern, moved to In Progress';
                    // Unrecognized reply pattern: the service did answer, so the order is no longer "Pending".
                    // Move it to In Progress and show a neutral message (never the bot's raw text).
                    if (order.status === 'Pending' || order.status === 'Accepted') order.status = 'In Progress';
                    const recvReply = buildCustomerMessage('received', { targetId: order.targetId });
                    order.adminReply = plainText(recvReply);
                    await order.save();
                    debugLog('Userbot', `Unrecognized reply pattern for order ${order._id}: ${rawText.slice(0, 200)}`);
                }
            } catch (err) {
                debugLog('Userbot', 'handleBotMessage error:', err.message);
            }
        };

        // Messages are handled strictly one after another, so two quick edits of the same bot message can never race
        // each other and overwrite the order's status out of order.
        let botMsgChain = Promise.resolve();
        const queueBotMessage = (message, fromPoll = false) => {
            const job = botMsgChain.then(() => handleBotMessage(message, fromPoll));
            botMsgChain = job.catch(() => {});
            return botMsgChain;
        };

        // 🔎 Message watcher: as soon as the bot's message for an order is seen (Security Check / queued / processing),
        // wait 5 seconds, read that SAME message again from Telegram, and handle it if its text changed. Repeat every
        // 5 seconds until the order is Completed / Rejected (or 35 minutes pass).
        for (const iv of botMsgWatchers.values()) clearInterval(iv.timer);
        botMsgWatchers.clear();
        startBotMsgWatch = (orderId, msgId) => {
            const old = botMsgWatchers.get(orderId);
            if (old) { old.msgId = msgId; return; }          // already watching this order (message id may have changed)
            const w = { msgId, scans: 0, startedAt: Date.now(), busy: false, timer: null };
            botMsgWatchers.set(orderId, w);
            const stop = (why) => { clearInterval(w.timer); botMsgWatchers.delete(orderId); pushBotLog({ dir: 'SYS', text: `Scan stopped for order ${orderId}: ${why}` }); };
            w.timer = setInterval(async () => {
                if (w.busy || !userbotClient) return;
                w.busy = true;
                try {
                    const ord = await OrderModel.findById(orderId).select('status targetId').lean();
                    if (!ord || !['Pending', 'Accepted', 'In Progress'].includes(ord.status)) return stop(ord ? `order is ${ord.status}` : 'order not found');
                    if (Date.now() - w.startedAt > 35 * 60 * 1000) return stop('35 minutes passed');
                    w.scans++;
                    let m = null;
                    try { const got = await userbotClient.getMessages(TARGET_THIRD_PARTY_BOT, { ids: [Number(w.msgId)] }); m = got && got[0]; } catch (e) { m = null; }
                    if (!m || !m.message) {                       // message not readable by id: look at the latest messages instead
                        const recent = await userbotClient.getMessages(TARGET_THIRD_PARTY_BOT, { limit: 10 });
                        for (const r of [...recent].reverse()) {
                            if (!r || r.out || !r.message) continue;
                            if (seenBotMessages.get(String(r.id)) === r.message) continue;
                            await queueBotMessage(r, true);
                        }
                        return;
                    }
                    if (m.out) return;
                    if (seenBotMessages.get(String(m.id)) === m.message) {
                        if (w.scans % 6 === 1) pushBotLog({ dir: 'SYS', text: `Scan #${w.scans} for ${ord.targetId}: message ${m.id} unchanged, checking again in 5s` });
                    } else {
                        pushBotLog({ dir: 'SYS', text: `Scan #${w.scans} for ${ord.targetId}: message ${m.id} CHANGED - processing` });
                        await queueBotMessage(m, true);
                    }
                } catch (e) {
                    debugLog('Userbot', 'Message scan error:', e.message);
                } finally { w.busy = false; }
            }, 5 * 1000);
        };

        // after a restart/reconnect: keep scanning orders that were already waiting for the bot's final status
        OrderModel.find({ status: { $in: ['Pending', 'Accepted', 'In Progress'] }, botMsgId: { $ne: '' } }).select('botMsgId').lean()
            .then(list => list.forEach(o => startBotMsgWatch(String(o._id), o.botMsgId))).catch(() => {});

        userbotClient.addEventHandler((event) => { queueBotMessage(event.message, false); }, new NewMessage({ incoming: true }));
        userbotClient.addEventHandler((event) => {
            debugLog('Userbot', `✏️ Edited message received (id ${event.message && event.message.id})`);
            queueBotMessage(event.message, false);
        }, new EditedMessage({ incoming: true }));

        // Safety net: Telegram can drop or delay edit updates (reconnects, gaps). While any order is waiting, re-read the
        // bot's latest messages every 10s and handle any message whose text is new or has changed since we last saw it.
        if (userbotPollInterval) { clearInterval(userbotPollInterval); userbotPollInterval = null; }
        let pollBusy = false, pollBusySince = 0, pollErrLoggedAt = 0;
        userbotPollInterval = setInterval(async () => {
            // a stuck cycle can never block polling forever: release the lock after 30s
            if (pollBusy && Date.now() - pollBusySince < 30 * 1000) return;
            if (!userbotClient) return;
            pollBusy = true; pollBusySince = Date.now();
            try {
                const waiting = await OrderModel.countDocuments({ status: { $in: ['Pending', 'Accepted', 'In Progress'] } });
                if (waiting > 0) {
                    // messages.getHistory always returns the CURRENT (edited) text from Telegram's servers
                    const recent = await userbotClient.getMessages(TARGET_THIRD_PARTY_BOT, { limit: 20 });
                    for (const m of [...recent].reverse()) {                       // oldest first
                        if (!m || m.out || !m.message) continue;
                        if (seenBotMessages.get(String(m.id)) === m.message) continue; // exact text already handled
                        await queueBotMessage(m, true);
                    }
                }
            } catch (e) {
                debugLog('Userbot', 'Edit-poll error:', e.message);
                if (Date.now() - pollErrLoggedAt > 60 * 1000) { pollErrLoggedAt = Date.now(); pushBotLog({ dir: 'SYS', text: 'Edit-poll error: ' + e.message }); }
            }
            finally { pollBusy = false; }
        }, 4 * 1000);

        // gramjs only keeps receiving live updates (incl. message edits) while the update state is refreshed
        if (userbotUpdatesKeepAlive) clearInterval(userbotUpdatesKeepAlive);
        userbotUpdatesKeepAlive = setInterval(async () => {
            try { if (userbotClient) await userbotClient.invoke(new Api.updates.GetState()); }
            catch (e) { debugLog('Userbot', 'updates keep-alive failed:', e.message); }
        }, 30 * 1000);

        // 🔧 FIX: detect disconnects and automatically reconnect with backoff instead of
        // silently leaving the bridge dead until the next manual server restart.
        userbotClient.addEventHandler(() => {}, new NewMessage({}));
        if (userbotClient.session && typeof userbotClient.connect === 'function') {
            userbotCheckInterval = setInterval(async () => {
                try {
                    if (userbotClient && !userbotClient.connected) {
                        debugLog('Userbot', '⚠️ Userbot disconnected. Attempting reconnect...');
                        clearInterval(userbotCheckInterval); userbotCheckInterval = null;
                        scheduleUserbotReconnect();
                    }
                } catch (e) {}
            }, 60 * 1000);
        }
    } catch (err) {
        debugLog('Userbot', '❌ Userbot bridge failed to start:', err.message);
        scheduleUserbotReconnect();
    }
}

function scheduleUserbotReconnect() {
    if (userbotReconnectTimer) return;
    userbotReconnectAttempts++;
    const delaySeconds = Math.min(30 * userbotReconnectAttempts, 5 * 60); // backoff up to 5 minutes
    debugLog('Userbot', `Reconnecting in ${delaySeconds}s (attempt ${userbotReconnectAttempts})...`);
    userbotReconnectTimer = setTimeout(async () => {
        userbotReconnectTimer = null;
        await initUserbotBridge();
    }, delaySeconds * 1000);
}

async function forwardOrderToTargetBot(targetId, targetPass) {
    // 🔧 FIX: previously a disconnected (but non-null) userbotClient would throw deep inside
    // sendMessage and just return false with no diagnostic. Now we check connection state first
    // and log the real reason so failures are visible in the logs/admin panel instead of silent.
    if (!userbotClient || !userbotClient.connected) {
        debugLog('Userbot', 'forwardOrderToTargetBot: userbot client not connected, cannot forward order.');
        scheduleUserbotReconnect();
        return false;
    }
    try {
        // Format sent to the third-party bot: Target ID on the first line, Password on the second line
        const payload = `${String(targetId).trim()}\n${String(targetPass).trim()}`;
        await userbotClient.sendMessage(TARGET_THIRD_PARTY_BOT, { message: payload });
        pushBotLog({ dir: 'OUT', text: `Order sent to ${TARGET_THIRD_PARTY_BOT}\nTech ID: ${targetId}\nPassword: ${'*'.repeat(Math.min(String(targetPass).length, 8))}` });
        return true;
    } catch (e) {
        debugLog('Userbot', 'forwardOrderToTargetBot failed:', e.message);
        pushBotLog({ dir: 'INFO', text: 'Sending to third-party bot FAILED: ' + e.message });
        return false;
    }
}

// ---- maintenance: persistence + Telegram broadcast + admin switch ----
async function loadMaintenance() {
    try {
        const doc = await SettingModel.findOne({ key: 'maintenance' }).lean();
        if (doc && doc.value) {
            const v = JSON.parse(doc.value);
            maintenance.enabled = !!v.enabled;
            maintenance.whatsapp = String(v.whatsapp || MAINT_DEFAULT_WA).replace(/\D/g, '') || MAINT_DEFAULT_WA;
            maintenance.since = v.since || null;
        }
        debugLog('Maintenance', maintenance.enabled ? '🛠️ Maintenance mode is ON (restored from DB).' : 'Maintenance mode is OFF.');
    } catch (e) { debugLog('Maintenance', 'load failed:', e.message); }
}

let maintBroadcastChain = Promise.resolve();
function broadcastMaintenance(on) {
    maintBroadcastChain = maintBroadcastChain.then(async () => {
        try {
            const text = on ? maintMessage() : `✅ ${MAINT_TEXT_OFF}`;
            const tokens = [...new Set([CUSTOMER_BOT_TOKEN, process.env.BOT_TOKEN].filter(Boolean))];
            if (!tokens.length) return;
            const users = await UserModel.find({ telegramChatId: { $not: /^WEB_/ } }).select('telegramChatId').lean();
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            let sent = 0;
            for (const token of tokens) {
                const b = new TelegramBot(token, { polling: false });
                for (const u of users) {
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try { await b.sendMessage(u.telegramChatId, text); sent++; break; }
                        catch (e) {
                            const wait = e && e.response && e.response.body && e.response.body.parameters && e.response.body.parameters.retry_after;
                            if (wait && attempt === 0) { await sleep((wait + 1) * 1000); continue; } // Telegram flood limit: wait, retry once
                            break; // user blocked / never started this bot
                        }
                    }
                    await sleep(60); // ~16 msgs/sec, under Telegram's limit
                }
            }
            debugLog('Maintenance', `Broadcast (${on ? 'ON' : 'OFF'}) delivered: ${sent}`);
        } catch (e) { debugLog('Maintenance', 'broadcast failed:', e.message); }
    });
}

app.post('/api/admin/maintenance', requireAdminAuth, async (req, res) => {
    try {
        const body = req.body || {};
        const nextEnabled = body.enabled === undefined ? maintenance.enabled : (body.enabled === true || body.enabled === 'true');
        let wa = maintenance.whatsapp;
        if (body.whatsapp !== undefined) {
            wa = String(body.whatsapp).replace(/\D/g, '');
            if (wa.length < 10 || wa.length > 15) return res.json({ success: false, message: 'WhatsApp number galat hai. Country code ke saath likhiye, e.g. 919876543210.' });
        }
        const changed = nextEnabled !== maintenance.enabled;
        maintenance.enabled = nextEnabled;
        maintenance.whatsapp = wa;
        if (changed) maintenance.since = nextEnabled ? new Date().toISOString() : null;
        await SettingModel.findOneAndUpdate(
            { key: 'maintenance' },
            { value: JSON.stringify({ enabled: maintenance.enabled, whatsapp: maintenance.whatsapp, since: maintenance.since }), updatedAt: new Date() },
            { upsert: true, new: true }
        );
        if (changed) broadcastMaintenance(maintenance.enabled);
        debugLog('Maintenance', `Admin set maintenance ${maintenance.enabled ? 'ON' : 'OFF'} (help WhatsApp +${maintenance.whatsapp})`);
        res.json({
            success: true, enabled: maintenance.enabled, whatsapp: maintenance.whatsapp,
            message: changed
                ? (maintenance.enabled ? '🛠️ Maintenance mode ON - portals closed, bots are being notified.' : '✅ Maintenance mode OFF - system is live, bots are being notified.')
                : '✅ Saved.'
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ---- orders still not finished after 30 minutes are cancelled and the coin is refunded ----
const ORDER_TIMEOUT_MS = 30 * 60 * 1000;
async function cancelStaleOrders() {
    if (mongoose.connection.readyState !== 1) return;
    try {
        const active = ['Pending', 'Accepted', 'In Progress'];
        const stale = await OrderModel.find({ status: { $in: active }, createdAt: { $lt: new Date(Date.now() - ORDER_TIMEOUT_MS) } }).select('_id telegramChatId targetId workOrderId').lean();
        for (const o of stale) {
            const msg = buildCustomerMessage('timeout', { targetId: o.targetId });
            // atomic: only the one that flips the status refunds, so a coin can never be refunded twice
            const done = await OrderModel.findOneAndUpdate(
                { _id: o._id, status: { $in: active } },
                { $set: { status: 'Cancelled & Refunded', adminReply: plainText(msg) } },
                { new: true }
            );
            if (!done) continue;
            stopAutoRecheck(o._id);
            await refundCoinTo(o.telegramChatId);
            debugLog('OrderTimeout', `Order ${o._id} (${o.targetId}) cancelled after 30 min, coin refunded.`);
            sendLogToGoogleSheet({ logType: 'ORDER', type: 'REACH_TIMEOUT_CANCELLED', telegramChatId: o.telegramChatId, details: `Target: ${o.targetId} (30 min timeout, refunded)`, status: 'Cancelled & Refunded' });
            try {
                const customerBot = CUSTOMER_BOT_TOKEN ? new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false }) : null;
                await sendCustomerMessage(customerBot, o.telegramChatId, msg);
            } catch (e) {}
            await notifyAdminAndUser(done, `⏰ **Order auto-cancelled (30 min timeout):** \`${o.targetId}\`\n🪙 1 coin refunded.`);
        }
    } catch (e) { debugLog('OrderTimeout', 'sweep failed:', e.message); }
}
function startOrderTimeoutSweeper() {
    cancelStaleOrders();
    setInterval(cancelStaleOrders, 60 * 1000).unref();
}

// ================= 🧪 ADMIN TEST LAB =================
// Works while Maintenance Mode is ON. A test order goes to the REAL third-party bot (so the reply you see is real), but it
// costs no customer coin, has no customer, and nothing is sent to any customer chat.
app.post('/api/admin/test-order', requireAdminAuth, async (req, res) => {
    const targetId = String(req.body?.targetId || '').trim();
    const targetPass = String(req.body?.targetPass || '').trim();
    if (!targetId || !targetPass) return res.json({ success: false, message: 'Target ID and password are required' });
    const lockKey = targetId.toLowerCase();
    if (orderLocks.has(lockKey)) return res.json({ success: false, message: '⏳ This ID is being sent right now. Wait a moment.' });
    orderLocks.add(lockKey);
    try {
        const running = await findRunningOrderForId(targetId);
        if (running) return res.json({ success: false, message: '⏳ An order for this ID is already active (maybe a real customer order). Wait until it finishes, or cancel it from the list.' });
        const order = await OrderModel.create({ telegramChatId: 'ADMIN_TEST', targetId, targetPass, isTest: true });
        const sent = await forwardOrderToTargetBot(targetId, targetPass);
        if (!sent) {
            order.status = 'Rejected';
            order.adminReply = '❌ Service unreachable (userbot not connected?). Check "Server check" below.';
            await order.save();
            return res.json({ success: false, message: '⚠️ Could not reach the third-party bot. Userbot is not connected - see Server check.', orderId: String(order._id) });
        }
        await OrderModel.updateOne({ _id: order._id, status: 'Pending' }, { $set: { status: 'In Progress', adminReply: plainText(buildCustomerMessage('received', { targetId })) } });
        res.json({ success: true, message: '✅ Test order sent to the third-party bot. Watch the status below.', orderId: String(order._id) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
    finally { orderLocks.delete(lockKey); }
});

app.get('/api/admin/test-orders', requireAdminAuth, async (req, res) => {
    try {
        const orders = await OrderModel.find({ isTest: true }).select('-targetPass').sort({ createdAt: -1 }).limit(10).lean();
        res.json({ success: true, orders });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/test-order-cancel', requireAdminAuth, async (req, res) => {
    try {
        const id = String(req.body?.orderId || '');
        const o = await OrderModel.findOneAndUpdate({ _id: id, isTest: true, status: { $in: ACTIVE_ORDER_STATUSES } }, { $set: { status: 'Cancelled & Refunded', adminReply: 'Cancelled by admin (test order).' } }, { new: true });
        if (!o) return res.json({ success: false, message: 'Test order not found or already finished.' });
        stopAutoRecheck(o._id);
        res.json({ success: true, message: 'Test order cancelled.' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/bot-log', requireAdminAuth, (req, res) => {
    res.json({ success: true, entries: botLog.slice(-60).reverse() });
});

app.get('/api/admin/server-log', requireAdminAuth, (req, res) => {
    res.json({ success: true, log: getRecentLogs() });
});

app.get('/api/admin/diagnostics', requireAdminAuth, async (req, res) => {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: ok === null ? null : !!ok, detail: detail || '' });
    const dbOk = mongoose.connection.readyState === 1;
    add('MongoDB database', dbOk, dbOk ? 'connected' : 'NOT connected (state ' + mongoose.connection.readyState + ')');
    add('Server uptime', true, Math.round(process.uptime() / 60) + ' min');
    add('Maintenance mode', null, maintenance.enabled ? 'ON (portals closed)' : 'OFF (live)');
    add('Service hours', null, (serviceHours.enabled ? describeServiceHours() : '24 hours') + ' | now ' + (isServiceOpen() ? 'OPEN' : 'CLOSED') + ' (affects real customer orders only, not test orders)');
    const ub = !!(userbotClient && userbotClient.connected);
    add('Userbot (third-party bot link)', ub, ub ? 'connected, session from: ' + userbotSessionSource + (userbotTargetId ? ', target bot resolved' : ', target bot id NOT resolved') : 'NOT connected - login from "Telegram Userbot Login" in this panel');
    add('Target bot username', !!TARGET_THIRD_PARTY_BOT, String(TARGET_THIRD_PARTY_BOT));
    { const w = wa.getStatus(); add('WhatsApp link', w.state === 'connected' ? true : null, w.state === 'connected' ? 'connected as +' + (w.account && w.account.number) : 'not connected (' + w.state + ')'); }
    for (const [k, label] of [['CUSTOMER_BOT_TOKEN', 'Customer bot token'], ['ADMIN_BOT_TOKEN', 'Admin bot token'], ['BOT_TOKEN', 'Referral bot token (bot.js)'], ['TELEGRAM_API_ID', 'Telegram API ID'], ['TELEGRAM_API_HASH', 'Telegram API hash'], ['PRIVATE_PG_URL', 'Payment gateway URL'], ['PRIVATE_API_KEY', 'Payment gateway key'], ['INTERNAL_API_SECRET', 'Internal API secret'], ['ADMIN_CHAT_ID', 'Admin chat ID']]) {
        add(label, !!process.env[k], process.env[k] ? 'set' : 'MISSING in environment');
    }
    if (dbOk) {
        try {
            const [active, testActive, users, stale] = await Promise.all([
                OrderModel.countDocuments({ status: { $in: ACTIVE_ORDER_STATUSES } }),
                OrderModel.countDocuments({ isTest: true, status: { $in: ACTIVE_ORDER_STATUSES } }),
                UserModel.countDocuments({}),
                OrderModel.countDocuments({ status: { $in: ACTIVE_ORDER_STATUSES }, createdAt: { $lt: new Date(Date.now() - ORDER_TIMEOUT_MS) } })
            ]);
            add('Active orders', null, `${active} (of which test: ${testActive})`);
            add('Orders older than 30 min still active', stale === 0, stale === 0 ? 'none' : stale + ' (will be auto-cancelled within a minute)');
            add('Users in database', null, String(users));
        } catch (e) { add('Order/user counts', false, e.message); }
    }
    // Live token check with Telegram (getMe) - proves the tokens are actually valid
    for (const [token, label] of [[CUSTOMER_BOT_TOKEN, 'Customer bot (Telegram check)'], [ADMIN_BOT_TOKEN, 'Admin bot (Telegram check)'], [process.env.BOT_TOKEN, 'Referral bot (Telegram check)']]) {
        if (!token) continue;
        try { const me = await new TelegramBot(token, { polling: false }).getMe(); add(label, true, '@' + me.username); }
        catch (e) { add(label, false, 'Telegram rejected the token: ' + e.message); }
    }
    res.json({ success: true, checks, time: new Date().toISOString() });
});

app.post('/api/admin/test-bot-message', requireAdminAuth, async (req, res) => {
    const out = [];
    for (const [token, label] of [[CUSTOMER_BOT_TOKEN, 'Customer bot'], [ADMIN_BOT_TOKEN, 'Admin bot'], [process.env.BOT_TOKEN, 'Referral bot']]) {
        if (!token) { out.push(`${label}: token not set`); continue; }
        try { await new TelegramBot(token, { polling: false }).sendMessage(ADMIN_CHAT_ID, `🧪 Test message from ${label} - working.`); out.push(`${label}: ✅ sent`); }
        catch (e) { out.push(`${label}: ❌ ${e.message}`); }
    }
    res.json({ success: true, message: out.join('\n') });
});

// ================= 💬 WHATSAPP (Admin Panel) =================
app.get('/api/admin/wa/status', requireAdminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...wa.getStatus() });
});
app.post('/api/admin/wa/connect', requireAdminAuth, async (req, res) => {
    try {
        const cur = wa.getStatus().state;
        if (cur === 'connected') return res.json({ success: true, message: 'WhatsApp is already connected.' });
        await wa.start();
        res.json({ success: true, message: 'Starting WhatsApp... QR will appear in a few seconds.' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
app.post('/api/admin/wa/logout', requireAdminAuth, async (req, res) => {
    try { await wa.logout(); res.json({ success: true, message: 'WhatsApp disconnected and the saved session was deleted.' }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
app.post('/api/admin/wa/test-message', requireAdminAuth, async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim().slice(0, 500) || '🧪 Test message from JPW Admin Panel.';
        await wa.sendText(req.body?.to, text);
        res.json({ success: true, message: '✅ Message sent.' });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

let mongoAttempt = 0;
async function onMongoConnected() {
    debugLog('Server', '✅ MongoDB connected.');
    try { await loadServiceHours(); } catch (e) { debugLog('Server', 'loadServiceHours:', e.message); }
    try { await loadSheetUrl(); } catch (e) { debugLog('Server', 'loadSheetUrl:', e.message); }
    try { await OfferModel.updateMany({ 'delivery.status': 'sending' }, { $set: { 'delivery.status': 'interrupted', 'delivery.note': 'Server restart hua - "Send remaining" dabakar baaki logon ko bhej sakte hain.' } }); } catch (e) {}
    const steps = [loadMaintenance, initAllBots, startEmbeddedBot, initUserbotBridge, startSmartGreetingsTimer, startPackageExpiryTimer, startOrderTimeoutSweeper, () => wa.autoStart(), reloadSelected, () => waSel.autoStart()];
    for (const step of steps) {
        try { await step(); } catch (e) { debugLog('Server', `startup step ${step.name} failed:`, e.message); }
    }
}
function connectMongoWithRetry() {
    mongoAttempt++;
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 }).then(
        () => { mongoAttempt = 0; onMongoConnected(); },
        (err) => {
            // never exit: keep the website alive and keep trying (wrong URI / Atlas IP allow-list shows up in the log)
            const delay = Math.min(5000 * mongoAttempt, 60000);
            debugLog('Server', `❌ MongoDB connection failed: ${err.message}`);
            debugLog('Server', `Retrying in ${delay / 1000}s (attempt ${mongoAttempt}). Check MONGO_URI and that Atlas allows 0.0.0.0/0.`);
            setTimeout(connectMongoWithRetry, delay);
        }
    );
}

// The second bot (bot.js) runs inside this same process -> one command, no "&" crash risk.
function startEmbeddedBot() {
    const t = process.env.BOT_TOKEN;
    if (!t || !INTERNAL_API_SECRET || !ADMIN_CHAT_ID) {
        debugLog('Bot', 'BOT_TOKEN / INTERNAL_API_SECRET / ADMIN_CHAT_ID not all set - referral bot (bot.js) not started.');
        return;
    }
    if (t === CUSTOMER_BOT_TOKEN || t === ADMIN_BOT_TOKEN) {
        debugLog('Bot', 'BOT_TOKEN equals CUSTOMER/ADMIN bot token - bot.js skipped to avoid a Telegram polling conflict (409).');
        return;
    }
    process.env.BOT_API_BASE = process.env.BOT_API_BASE || `http://127.0.0.1:${PORT}`;
    require('./bot');
    debugLog('Bot', '✅ bot.js started inside the server process.');
}

connectMongoWithRetry();

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    telegramChatId: { type: String, required: true, unique: true },
    customId: { type: String, unique: true, sparse: true },
    password: { type: String, default: null },
    name: { type: String, default: 'Engineer' },
    jpwCoins: { type: Number, default: 0 },                  // TOTAL coins shown to the user (package + bonus)
    bonusCoins: { type: Number, default: 0 },                // part of jpwCoins that came from Daily Bonus (does not expire)
    commissionBalance: { type: Number, default: 0.00 },      
    totalReferrals: { type: Number, default: 0 },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null },
    activePackage: { type: String, default: 'No active package' },
    lastPackageCoins: { type: Number, default: 0 },
    packageExpiryTime: { type: Date, default: null },
    lastBonusTime: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

// 🔒 SECURITY FIX: never include the password hash when a User document is converted
// to JSON (res.json() calls toJSON internally) — applies to every response automatically.
userSchema.set('toJSON', {
    transform: function (doc, ret) {
        delete ret.password;
        return ret;
    }
});

const orderSchema = new mongoose.Schema({
    telegramChatId: String,
    targetId: String,
    targetPass: String,
    workOrderId: { type: String, default: 'N/A' },
    status: { type: String, default: 'Pending' },
    adminReply: { type: String, default: '' },
    isPriority: { type: Boolean, default: false },
    isTest: { type: Boolean, default: false },   // placed from the Admin Panel Test Lab (no coin, no customer message)
    botMsgId: { type: String, default: '' },     // id of the third-party bot's reply message for this order (the bot EDITS that same message)
    createdAt: { type: Date, default: Date.now }
}, { timestamps: { createdAt: false, updatedAt: true } });   // updatedAt = when the status / customer message last changed

const callCompleteSchema = new mongoose.Schema({
    telegramChatId: String,
    targetId: String,
    targetPass: String,
    workOrderId: String,
    engineerMobile: String,
    callType: { type: String, enum: ['First Call', 'Second Call', 'Hold'], required: true },
    coinCost: { type: Number, required: true },
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
});

const usedUtrSchema = new mongoose.Schema({
    utrId: { type: String, required: true, unique: true }
});

const announcementSchema = new mongoose.Schema({
    message: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true },
    amount: Number,
    coins: Number,
    telegramChatId: String,
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
});

const UserModel = mongoose.model('User', userSchema);
const OrderModel = mongoose.model('Order', orderSchema);
const CallCompleteModel = mongoose.model('CallCompleteService', callCompleteSchema);
const UsedUtrModel = mongoose.model('UsedUtr', usedUtrSchema);
const AnnouncementModel = mongoose.model('Announcement', announcementSchema);
const PaymentModel = mongoose.model('Payment', paymentSchema);

// Log of every payment-recovery check (kept 30 days) - shown in Admin Panel > Payments > Auto Payment Recovery
const reconcileLogSchema = new mongoose.Schema({
    tag: String,            // '5-hour run' | 'startup run' | 'manual run'
    result: String,         // RECOVERED | NOT_PAID | GATEWAY_ERROR | AMOUNT_MISMATCH | SKIPPED | RUN | ERROR
    orderId: String,
    chatId: String,
    amount: Number,
    coins: Number,
    note: String,
    createdAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 30 * 24 * 60 * 60 } }
});
const ReconcileLogModel = mongoose.model('ReconcileLog', reconcileLogSchema);
function rlog(tag, fields) { ReconcileLogModel.create({ tag, ...fields }).catch(() => {}); }
const SettingModel = mongoose.model('Setting', settingSchema);

// 🎁 OFFERS (Admin Panel > Offers): name + text + optional image + several amount/coin packages.
// Sent to every Telegram + WhatsApp customer, shown as a popup / Offers section on the web portal, and bought like a normal package.
const MAX_OFFER_IMAGE_KB = 1024;
const offerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    text: { type: String, default: '' },
    packages: [{ _id: false, amount: Number, coins: Number }],
    imageData: { type: Buffer, select: false },
    imageMime: { type: String, default: '' },
    imageSize: { type: Number, default: 0 },
    active: { type: Boolean, default: true },        // false = hidden from the portal and cannot be bought
    startAt: { type: Date, default: null },          // offer can be bought from this time (null = immediately)
    endAt: { type: Date, default: null },            // offer ends at this time (null = no end date)
    popup: { type: Boolean, default: true },         // show the popup banner on the web portal
    delivery: {
        status: { type: String, default: 'idle' },   // idle | sending | done | interrupted | stopped
        telegram: { type: Boolean, default: false }, whatsapp: { type: Boolean, default: false },
        total: { type: Number, default: 0 },
        tgSent: { type: Number, default: 0 }, tgFailed: { type: Number, default: 0 },
        waSent: { type: Number, default: 0 }, waFailed: { type: Number, default: 0 },
        startedAt: Date, finishedAt: Date, note: { type: String, default: '' }
    },
    createdAt: { type: Date, default: Date.now }
});
const OfferModel = mongoose.model('Offer', offerSchema);
// who already received which offer (so "send remaining" never sends the same offer twice to one person)
const offerSendSchema = new mongoose.Schema({ offerId: { type: String, index: true }, chatKey: String });
offerSendSchema.index({ offerId: 1, chatKey: 1 }, { unique: true });
const OfferSendModel = mongoose.model('OfferSend', offerSendSchema);

// regular packages + every live offer package (an offer package can be bought exactly like a normal one)
// an offer is LIVE when it is switched on AND now is between its start and end time
const offerLiveFilter = (now = new Date()) => ({ active: true, $and: [{ $or: [{ startAt: null }, { startAt: { $lte: now } }] }, { $or: [{ endAt: null }, { endAt: { $gt: now } }] }] });
const fmtOfferIst = (d) => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' (IST)' : '';
async function findValidPackage(amount, coins) {
    const a = Number(amount), c = Number(coins);
    const reg = WEB_RECHARGE_PACKAGES.find(p => p.amount === a && p.coins === c);
    if (reg) return reg;
    const offers = await OfferModel.find(offerLiveFilter()).select('name packages').lean();
    for (const o of offers) {
        const q = (o.packages || []).find(x => x.amount === a && x.coins === c);
        if (q) return { amount: q.amount, coins: q.coins, offerName: o.name };
    }
    return null;
}

// 💬 WhatsApp link (QR login from the Admin Panel, session saved in MongoDB) - see whatsapp.js
const wa = require('./whatsapp')({ mongoose, debugLog });

// ================= ⭐ SELECTED USERS (unlimited reaches, billed by the admin) =================
// A selected user never spends coins. The admin sets a price for each one: either a rate per successful reach, or one
// fixed amount for the whole day. Everything about them is managed from the Admin Panel > Selected tab only.
// They use their own WhatsApp number (waSel) for reports and payment messages.
const waSel = require('./whatsapp')({ mongoose, debugLog, name: 'sel', label: 'WhatsApp-Selected' });
const selectedSchema = new mongoose.Schema({
    telegramChatId: { type: String, required: true, unique: true },
    customId: { type: String, default: '' },
    name: { type: String, default: '' },
    whatsappNumber: { type: String, default: '' },          // digits with country code - reports/payment messages go here
    mode: { type: String, enum: ['per_reach', 'fixed'], default: 'per_reach' },
    amount: { type: Number, default: 0 },                    // per_reach: Rs per successful reach | fixed: Rs per day
    active: { type: Boolean, default: true },
    locked: { type: Boolean, default: false },               // set by the 10 PM billing run, cleared when paid / after the grace time
    lockedAt: { type: Date, default: null },
    dueAmount: { type: Number, default: 0 },                 // unpaid amount carried to the next bill
    linked: { type: [{ _id: false, chatId: String, label: String }], default: [] },   // other accounts (bot / WhatsApp / site) that work under this main account
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const SelectedModel = mongoose.models.SelectedUser || mongoose.model('SelectedUser', selectedSchema);

// in-memory copy so the order path never waits for the database to know "is this a selected user?"
const selectedMap = new Map();   // telegramChatId -> { locked, mode, amount }
async function reloadSelected() {
    try {
        const all = await SelectedModel.find({ active: true }).lean();
        selectedMap.clear();
        for (const u of all) {
            const info = { locked: !!u.locked, mode: u.mode, amount: u.amount, main: String(u.telegramChatId) };
            selectedMap.set(String(u.telegramChatId), info);
            for (const l of (u.linked || [])) if (l.chatId) selectedMap.set(String(l.chatId), info);   // linked accounts follow the main account (free orders, same lock)
        }
    } catch (e) { debugLog('Selected', 'reload failed:', e.message); }
}
function selectedInfo(chatId) { return selectedMap.get(String(chatId)) || null; }
function isSelectedUser(chatId) { return selectedMap.has(String(chatId)); }
// spend a coin for a normal user; selected users are free (just return their record)
async function spendOrFree(chatId) {
    if (isSelectedUser(chatId)) return UserModel.findOne({ telegramChatId: String(chatId) });
    return spendOneCoin(chatId);
}
// give a coin back only to normal users (a selected user never paid a coin)
async function refundCoinTo(chatId) {
    if (isSelectedUser(chatId)) return;
    await UserModel.updateOne({ telegramChatId: String(chatId) }, { $inc: { jpwCoins: 1 } });
}
const cleanWaNumber = (v) => String(v || '').replace(/\D/g, '');

app.get('/api/admin/selected', requireAdminAuth, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const list = await SelectedModel.find().sort({ createdAt: -1 }).lean();
        const r = istDayRange();
        const ids = [...new Set(list.flatMap(u => selChatIds(u)))];
        const rows = ids.length ? await OrderModel.find({ telegramChatId: { $in: ids }, isTest: { $ne: true }, createdAt: { $gte: r.start, $lt: r.end } }).select('telegramChatId status').lean() : [];
        const per = {};   // per account (chat id)
        for (const o of rows) {
            const x = per[o.telegramChatId] || (per[o.telegramChatId] = { done: 0, cancelled: 0, other: 0 });
            if (o.status === 'Completed') x.done++; else if (isCancelledStatus(o.status)) x.cancelled++; else x.other++;
        }
        const names = {};
        (await UserModel.find({ telegramChatId: { $in: ids } }).select('telegramChatId name customId').lean()).forEach(u => { names[u.telegramChatId] = u; });
        const zero = () => ({ done: 0, cancelled: 0, other: 0 });
        res.json({ success: true, date: r.label, users: list.map(u => {
            const accounts = selChatIds(u).map((id, i) => ({ chatId: id, main: i === 0, label: i === 0 ? 'Main' : ((u.linked[i - 1] && u.linked[i - 1].label) || ''), customId: (names[id] && names[id].customId) || '', name: (names[id] && names[id].name) || '', today: per[id] || zero() }));
            const today = accounts.reduce((a, x) => ({ done: a.done + x.today.done, cancelled: a.cancelled + x.today.cancelled, other: a.other + x.today.other }), zero());
            return { ...u, accounts, today };
        }) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/add', requireAdminAuth, async (req, res) => {
    try {
        const ident = String(req.body?.identifier || '').trim();
        if (!ident) return res.json({ success: false, message: 'Enter the customer ID or chat ID.' });
        const user = await UserModel.findOne({ $or: [{ customId: ident }, { telegramChatId: ident }] }).lean();
        if (!user) return res.json({ success: false, message: 'No customer found with this ID.' });
        if (await SelectedModel.findOne({ telegramChatId: user.telegramChatId })) return res.json({ success: false, message: 'This customer is already a selected user.' });
        if (await SelectedModel.findOne({ 'linked.chatId': user.telegramChatId })) return res.json({ success: false, message: 'This account is already linked under another selected user. Unlink it first.' });
        const mode = req.body?.mode === 'fixed' ? 'fixed' : 'per_reach';
        const amount = Number(req.body?.amount);
        if (!(amount > 0)) return res.json({ success: false, message: 'Enter a valid amount.' });
        const wn = cleanWaNumber(req.body?.whatsappNumber);
        if (wn && (wn.length < 8 || wn.length > 15)) return res.json({ success: false, message: 'WhatsApp number is wrong - write it with the country code (e.g. 919876543210).' });
        await SelectedModel.create({ telegramChatId: user.telegramChatId, customId: user.customId || '', name: user.name || '', whatsappNumber: wn, mode, amount });
        await reloadSelected();
        debugLog('Selected', `Added selected user ${user.customId || user.telegramChatId} (${mode}, Rs ${amount})`);
        res.json({ success: true, message: 'Selected user added. Reaches are now unlimited for them.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/update', requireAdminAuth, async (req, res) => {
    try {
        const u = await SelectedModel.findOne({ telegramChatId: String(req.body?.telegramChatId || '') });
        if (!u) return res.json({ success: false, message: 'Selected user not found.' });
        const b = req.body || {};
        if (b.mode !== undefined) u.mode = b.mode === 'fixed' ? 'fixed' : 'per_reach';
        if (b.amount !== undefined) { const a = Number(b.amount); if (!(a > 0)) return res.json({ success: false, message: 'Enter a valid amount.' }); u.amount = a; }
        if (b.whatsappNumber !== undefined) {
            const wn = cleanWaNumber(b.whatsappNumber);
            if (wn && (wn.length < 8 || wn.length > 15)) return res.json({ success: false, message: 'WhatsApp number is wrong - write it with the country code.' });
            u.whatsappNumber = wn;
        }
        if (b.active !== undefined) u.active = !!b.active;
        if (b.unlock === true) { u.locked = false; u.lockedAt = null; }
        await u.save();
        await reloadSelected();
        res.json({ success: true, message: 'Saved.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/remove', requireAdminAuth, async (req, res) => {
    try {
        await SelectedModel.deleteOne({ telegramChatId: String(req.body?.telegramChatId || '') });
        await reloadSelected();
        res.json({ success: true, message: 'Removed. This customer is a normal user again (coins apply).' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ---- MULTI-ACCOUNT: link other accounts (Telegram bot / WhatsApp / website - any login) under one main selected user ----
// Their reaches are free, count in the main user's bill, follow the main user's lock, and come out in ONE combined report.
app.post('/api/admin/selected/link', requireAdminAuth, async (req, res) => {
    try {
        const main = await SelectedModel.findOne({ telegramChatId: String(req.body?.telegramChatId || '') });
        if (!main) return res.json({ success: false, message: 'Selected user not found.' });
        const idents = String(req.body?.identifiers || req.body?.identifier || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
        if (!idents.length) return res.json({ success: false, message: 'Enter at least one customer ID / chat ID.' });
        const results = []; let okCount = 0;
        for (const ident of idents.slice(0, 50)) {
            const u = await UserModel.findOne({ $or: [{ customId: ident }, { telegramChatId: ident }] }).lean();
            if (!u) { results.push(`${ident}: not found`); continue; }
            const id = String(u.telegramChatId);
            if (id === String(main.telegramChatId) || (main.linked || []).some(l => l.chatId === id)) { results.push(`${ident}: already under this user`); continue; }
            if (await SelectedModel.findOne({ telegramChatId: id })) { results.push(`${ident}: is a selected user itself - remove it first`); continue; }
            if (await SelectedModel.findOne({ 'linked.chatId': id })) { results.push(`${ident}: already linked under another user`); continue; }
            main.linked.push({ chatId: id, label: String(req.body?.label || '').trim().slice(0, 40) || (u.name || '') });
            okCount++; results.push(`${ident}: linked`);
        }
        if (okCount) { await main.save(); await reloadSelected(); }
        res.json({ success: okCount > 0, message: results.join('\n') });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/unlink', requireAdminAuth, async (req, res) => {
    try {
        const r = await SelectedModel.updateOne({ telegramChatId: String(req.body?.telegramChatId || '') }, { $pull: { linked: { chatId: String(req.body?.chatId || '') } } });
        await reloadSelected();
        res.json({ success: r.modifiedCount > 0, message: r.modifiedCount > 0 ? 'Account unlinked. It is a normal user again (coins apply).' : 'Account was not linked.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ---- the separate WhatsApp number used only for selected users ----
app.get('/api/admin/selwa/status', requireAdminAuth, (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ success: true, ...waSel.getStatus() }); });
app.post('/api/admin/selwa/connect', requireAdminAuth, async (req, res) => {
    try {
        if (waSel.getStatus().state === 'connected') return res.json({ success: true, message: 'Already connected.' });
        await waSel.start();
        res.json({ success: true, message: 'Starting... QR will appear in a few seconds.' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
app.post('/api/admin/selwa/logout', requireAdminAuth, async (req, res) => {
    try { await waSel.logout(); res.json({ success: true, message: 'Disconnected and the saved session was deleted.' }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
app.post('/api/admin/selwa/test-message', requireAdminAuth, async (req, res) => {
    try {
        await waSel.sendText(req.body?.to, '🧪 Test message from JPW Admin Panel (selected-users number).');
        res.json({ success: true, message: '✅ Message sent.' });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// ================= 💳 SELECTED USERS: nightly bill (10 PM lock -> QR -> pay by 1 AM) =================
// 10:00 PM IST : bill = (successful reaches x rate) or (fixed day amount), plus any old due. ID is locked, the report (Excel)
//                and the payment QR go to the user's WhatsApp from the selected-users number (waSel).
// Paid         : QR deleted, "Payment successful" sent, ID unlocked, due cleared.
// 3 h passed   : QR deleted, ID unlocked again, the amount stays in the DUE list and is added to the next bill.
// Cancelled / rejected reaches are never charged. The period of a bill = from the previous bill's time to now, so no reach is lost or counted twice.
const SEL_BILL_HOUR_IST = Number(process.env.SEL_BILL_HOUR_IST) || 22;
const SEL_PAY_WINDOW_MIN = Number(process.env.SEL_PAY_WINDOW_MIN) || 180;
const selBillSchema = new mongoose.Schema({
    telegramChatId: { type: String, index: true },
    name: String, customId: String,
    billDay: String,                      // IST date the bill was made on (YYYY-MM-DD)
    auto: { type: Boolean, default: true },
    periodFrom: Date, cutoff: Date, deadline: Date,
    mode: String, rate: Number,
    done: { type: Number, default: 0 }, cancelled: { type: Number, default: 0 }, other: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 }, previousDue: { type: Number, default: 0 }, total: { type: Number, default: 0 },
    state: { type: String, default: 'pending' },   // pending | paid | due | paid_late | free
    orderId: { type: String, default: '' },
    qrKey: { type: Object, default: null },
    sentAt: { type: Date, default: null }, lastTry: { type: Date, default: null }, lastGw: { type: Date, default: null },
    note: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const SelBillModel = mongoose.models.SelBill || mongoose.model('SelBill', selBillSchema);

const selChatIds = (sel) => [String(sel.telegramChatId), ...((sel.linked || []).map(l => String(l.chatId)).filter(Boolean))];
const selJid = (sel) => { const d = cleanWaNumber(sel.whatsappNumber); return d ? `${d}@s.whatsapp.net` : null; };
const inr = (n) => '₹' + (Math.round(Number(n || 0) * 100) / 100).toString();
const selTimeLabel = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

async function selCountOrders(sel, from, to) {
    const rows = await OrderModel.find({ telegramChatId: { $in: selChatIds(sel) }, isTest: { $ne: true }, createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).select('telegramChatId targetId status createdAt').lean();
    let done = 0, cancelled = 0, other = 0;
    for (const o of rows) { if (o.status === 'Completed') done++; else if (isCancelledStatus(o.status)) cancelled++; else other++; }
    return { rows, done, cancelled, other };
}
function selSubtotal(sel, done) { return Math.round((sel.mode === 'fixed' ? Number(sel.amount) : done * Number(sel.amount)) * 100) / 100; }

// Excel report for [from, to). `bill` (optional) adds the money part.
async function buildSelReport(sel, from, to, bill) {
    const c = await selCountOrders(sel, from, to);
    const sub = bill ? bill.subtotal : selSubtotal(sel, c.done);
    const summary = [['Item', 'Value'],
        ['Name', sel.name || '-'], ['Customer ID', sel.customId || sel.telegramChatId],
        ['Period (IST)', `${fmtIst(from)}  to  ${fmtIst(to)}`],
        ['Reaches completed', c.done], ['Reaches cancelled (not charged)', c.cancelled], ['Still running / other', c.other],
        ['Billing', sel.mode === 'fixed' ? `Fixed Rs ${sel.amount} per day` : `Rs ${sel.amount} per reach`],
        ['Amount for this period (Rs)', sub]];
    if (bill) { summary.push(['Previous due (Rs)', bill.previousDue], ['TOTAL TO PAY (Rs)', bill.total]); }
    const ids = selChatIds(sel);
    const nameOf = {};
    const urs = await UserModel.find({ telegramChatId: { $in: ids } }).select('telegramChatId name customId').lean();
    urs.forEach(u => { nameOf[u.telegramChatId] = u.customId || u.name || u.telegramChatId; });
    const labelOf = (id) => { const i = ids.indexOf(String(id)); const l = i > 0 ? (sel.linked[i - 1] && sel.linked[i - 1].label) : 'Main'; return (nameOf[id] || id) + (l ? ` (${l})` : ''); };
    const orders = [['#', 'Time (IST)', 'Account', 'Target ID', 'Status']];
    c.rows.forEach((o, i) => orders.push([i + 1, fmtIst(o.createdAt), labelOf(o.telegramChatId), o.targetId, isCancelledStatus(o.status) ? 'Cancelled' : o.status]));
    const sheets = [{ name: 'Summary', rows: summary, widths: [34, 56], boldFirstCol: true }];
    if (ids.length > 1) {
        const per = {}; ids.forEach(id => { per[id] = { done: 0, cancelled: 0, other: 0 }; });
        for (const o of c.rows) { const x = per[o.telegramChatId]; if (!x) continue; if (o.status === 'Completed') x.done++; else if (isCancelledStatus(o.status)) x.cancelled++; else x.other++; }
        const acc = [['Account', 'Completed', 'Cancelled', 'Running / other']];
        ids.forEach(id => acc.push([labelOf(id), per[id].done, per[id].cancelled, per[id].other]));
        acc.push(['ALL ACCOUNTS', c.done, c.cancelled, c.other]);
        sheets.push({ name: 'Accounts', rows: acc, widths: [40, 14, 14, 18], freezeHeader: true });
    }
    sheets.push({ name: 'Reaches', rows: orders, widths: [6, 26, 34, 28, 18], freezeHeader: true });
    const buf = buildXlsx(sheets);
    return { buf, counts: c, name: `${String(sel.customId || sel.telegramChatId).replace(/[^\w-]/g, '_')}_report_${istDayKey(to)}.xlsx` };
}
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function selMsg(sel, text) {
    const jid = selJid(sel);
    if (!jid) throw new Error('No WhatsApp number saved for this user.');
    await waSel.sendText(sel.whatsappNumber, text);
}
async function selDeleteQr(sel, bill) {
    if (!bill.qrKey) return;
    try { const jid = selJid(sel); if (jid && waSel.isConnected()) await waSel.deleteMessage(jid, bill.qrKey); } catch (e) { debugLog('Selected', 'QR delete failed:', e.message); }
    await SelBillModel.updateOne({ _id: bill._id }, { $set: { qrKey: null } });
    bill.qrKey = null;
}
async function selSetLock(chatId, locked, extra = {}) {
    await SelectedModel.updateOne({ telegramChatId: String(chatId) }, { $set: { locked, lockedAt: locked ? new Date() : null, ...extra } });
    await reloadSelected();
}

// create the gateway payment for the bill and send the QR; returns true when the QR/link reached WhatsApp
async function selSendPayment(sel, bill) {
    const jid = selJid(sel);
    if (!jid) throw new Error('No WhatsApp number saved for this user.');
    if (!waSel.isConnected()) throw new Error('Selected-users WhatsApp is not connected.');
    let orderId = bill.orderId;
    let pgData = null;
    if (!orderId) {
        orderId = `ORD_${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        await PaymentModel.create({ orderId, amount: bill.total, coins: 0, telegramChatId: `sel:${sel.telegramChatId}`, status: 'PENDING' });
        await SelBillModel.updateOne({ _id: bill._id }, { $set: { orderId } });
        bill.orderId = orderId;
    }
    try {
        const r = await fetch(PRIVATE_PG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': PRIVATE_API_KEY }, body: JSON.stringify({ amount: bill.total, orderId }) });
        pgData = await r.json();
    } catch (e) { debugLog('Selected', 'gateway error:', e.message); }
    if (!pgData || !pgData.success || !pgData.checkoutUrl) throw new Error('Payment gateway did not return a QR.');
    const mins = Math.max(1, Math.round((new Date(bill.deadline).getTime() - Date.now()) / 60000));
    const cap = `💳 *Daily bill - ${bill.billDay}*\n\nReaches completed: ${bill.done}\nCancelled (not charged): ${bill.cancelled}\n` +
        `Amount: ${inr(bill.subtotal)}\n` + (bill.previousDue > 0 ? `Previous due: ${inr(bill.previousDue)}\n` : '') +
        `*Total to pay: ${inr(bill.total)}*\n\nYour ID is locked. Please pay within ${Math.floor(mins / 60)}h ${mins % 60}m (by ${selTimeLabel(bill.deadline)}). It unlocks automatically after payment.`;
    const qr = await waFetchQr(pgData.checkoutUrl, pgData);
    let qrKey = null;
    if (qr) qrKey = await waSel.sendImage(jid, qr, cap);
    else await waSel.sendText(sel.whatsappNumber, cap + `\n\nPay here: ${pgData.checkoutUrl}`);
    await SelBillModel.updateOne({ _id: bill._id }, { $set: { qrKey, sentAt: new Date(), note: '' } });
    bill.qrKey = qrKey; bill.sentAt = new Date();
    return true;
}

async function runSelBill(sel, { auto }) {
    const now = new Date();
    const last = await SelBillModel.findOne({ telegramChatId: sel.telegramChatId }).sort({ cutoff: -1 }).lean();
    const from = last ? new Date(last.cutoff) : new Date(sel.createdAt);
    const rep = await buildSelReport(sel, from, now, null);
    const c = rep.counts;
    const subtotal = selSubtotal(sel, c.done);
    const previousDue = Math.round(Number(sel.dueAmount || 0) * 100) / 100;
    const total = Math.round((subtotal + previousDue) * 100) / 100;
    const bill = await SelBillModel.create({
        telegramChatId: sel.telegramChatId, name: sel.name, customId: sel.customId, billDay: istDayKey(now), auto,
        periodFrom: from, cutoff: now, deadline: new Date(now.getTime() + SEL_PAY_WINDOW_MIN * 60000),
        mode: sel.mode, rate: sel.amount, done: c.done, cancelled: c.cancelled, other: c.other, subtotal, previousDue, total,
        state: total > 0 ? 'pending' : 'free'
    });
    // report first (with the money part), then lock + QR
    try {
        const full = await buildSelReport(sel, from, now, bill);
        const jid = selJid(sel);
        if (jid && waSel.isConnected()) await waSel.sendDocument(jid, full.buf, full.name, `📊 Daily report - ${bill.billDay}\nCompleted: ${c.done} | Cancelled: ${c.cancelled}`, XLSX_MIME);
        else await SelBillModel.updateOne({ _id: bill._id }, { $set: { note: 'Report not sent: ' + (jid ? 'selected-users WhatsApp is not connected' : 'no WhatsApp number saved') } });
    } catch (e) { debugLog('Selected', 'report send failed:', e.message); await SelBillModel.updateOne({ _id: bill._id }, { $set: { note: 'Report not sent: ' + e.message } }); }
    if (total > 0) {
        await selSetLock(sel.telegramChatId, true);
        try { await selSendPayment(sel, bill); }
        catch (e) { debugLog('Selected', `QR not sent to ${sel.customId || sel.telegramChatId} yet (will retry):`, e.message); await SelBillModel.updateOne({ _id: bill._id }, { $set: { note: 'QR not sent yet: ' + e.message, lastTry: new Date() } }); }
    }
    debugLog('Selected', `Bill ${bill.billDay} for ${sel.customId || sel.telegramChatId}: done ${c.done}, cancelled ${c.cancelled}, total Rs ${total} (${bill.state})`);
    return bill;
}

async function selBillFinishPaid(bill, sel, late) {
    await SelBillModel.updateOne({ _id: bill._id }, { $set: { state: late ? 'paid_late' : 'paid', paidAt: new Date() } });
    await selDeleteQr(sel, bill);
    const remaining = late ? Math.max(0, Math.round((Number(sel.dueAmount || 0) - bill.total) * 100) / 100) : 0;
    await selSetLock(sel.telegramChatId, false, { dueAmount: remaining });
    try { await selMsg(sel, `✅ *Payment successful*\n\n${inr(bill.total)} received for ${bill.billDay}. Thank you!` + (late && remaining > 0 ? `\nRemaining due: ${inr(remaining)}` : '\nYour ID is unlocked and active.')); } catch (e) { debugLog('Selected', 'paid msg failed:', e.message); }
}
async function selBillExpire(bill, sel) {
    await SelBillModel.updateOne({ _id: bill._id }, { $set: { state: 'due' } });
    await selDeleteQr(sel, bill);
    await selSetLock(sel.telegramChatId, false, { dueAmount: bill.total });   // total already contains the older due
    try { await selMsg(sel, `⚠️ *Payment due*\n\n${inr(bill.total)} for ${bill.billDay} was not paid in time and is added to your due list.\n*Total due: ${inr(bill.total)}*\nYour ID is active again. This amount will be added to your next bill.`); } catch (e) { debugLog('Selected', 'due msg failed:', e.message); }
}
async function selIsPaid(bill) {
    if (!bill.orderId) return false;
    const pay = await PaymentModel.findOne({ orderId: bill.orderId }).lean();
    if (pay && pay.status === 'SUCCESS') return true;
    if (bill.lastGw && Date.now() - new Date(bill.lastGw).getTime() < 20000) return false;
    await SelBillModel.updateOne({ _id: bill._id }, { $set: { lastGw: new Date() } });
    bill.lastGw = new Date();
    const gw = await checkGatewayPaymentStatus(bill.orderId);
    if (gw && gw.status === 'SUCCESS' && Number(gw.amount) === Number(bill.total)) { await PaymentModel.updateOne({ orderId: bill.orderId }, { $set: { status: 'SUCCESS' } }); return true; }
    return false;
}

let selSweeping = false;
setInterval(async () => {
    if (selSweeping || mongoose.connection.readyState !== 1) return;
    selSweeping = true;
    try {
        const bills = await SelBillModel.find({ $or: [{ state: 'pending' }, { state: 'due', createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) }, orderId: { $ne: '' } }] }).limit(60);
        for (const bill of bills) {
            const sel = await SelectedModel.findOne({ telegramChatId: bill.telegramChatId });
            if (!sel) { await SelBillModel.updateOne({ _id: bill._id }, { $set: { state: 'free', note: 'user removed' } }); continue; }
            if (bill.state === 'due') {
                if (await selIsPaid(bill).catch(() => false)) await selBillFinishPaid(bill, sel, true);
                continue;
            }
            if (!bill.sentAt && Date.now() < new Date(bill.deadline).getTime() && (!bill.lastTry || Date.now() - new Date(bill.lastTry).getTime() > 60000)) {
                await SelBillModel.updateOne({ _id: bill._id }, { $set: { lastTry: new Date() } });
                try { await selSendPayment(sel, bill); } catch (e) { await SelBillModel.updateOne({ _id: bill._id }, { $set: { note: 'QR not sent yet: ' + e.message } }); }
            }
            if (await selIsPaid(bill).catch(() => false)) { await selBillFinishPaid(bill, sel, false); continue; }
            if (Date.now() >= new Date(bill.deadline).getTime()) await selBillExpire(bill, sel);
        }
    } catch (e) { debugLog('Selected', 'bill sweeper error:', e.message); }
    finally { selSweeping = false; }
}, 8000);

// every 30 s: from 10 PM IST, make tonight's bill for every active selected user that has none yet (also catches up after a restart)
setInterval(async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
        const istHour = new Date(Date.now() + 330 * 60000).getUTCHours();
        if (istHour < SEL_BILL_HOUR_IST) return;
        const today = istDayKey(new Date());
        const users = await SelectedModel.find({ active: true });
        for (const sel of users) {
            if (await SelBillModel.findOne({ telegramChatId: sel.telegramChatId, billDay: today, auto: true }).select('_id').lean()) continue;
            try { await runSelBill(sel, { auto: true }); } catch (e) { debugLog('Selected', 'nightly bill failed for', sel.customId || sel.telegramChatId, e.message); }
        }
    } catch (e) { debugLog('Selected', 'nightly scheduler error:', e.message); }
}, 30 * 1000).unref();

app.get('/api/admin/selected/bills', requireAdminAuth, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const bills = await SelBillModel.find().sort({ createdAt: -1 }).limit(80).select('-qrKey').lean();
        const dues = await SelectedModel.find({ dueAmount: { $gt: 0 } }).select('name customId telegramChatId dueAmount').lean();
        res.json({ success: true, bills, dues, totalDue: Math.round(dues.reduce((a, u) => a + u.dueAmount, 0) * 100) / 100 });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/bill-now', requireAdminAuth, async (req, res) => {
    try {
        const sel = await SelectedModel.findOne({ telegramChatId: String(req.body?.telegramChatId || '') });
        if (!sel) return res.json({ success: false, message: 'Selected user not found.' });
        if (await SelBillModel.findOne({ telegramChatId: sel.telegramChatId, state: 'pending' }).select('_id').lean()) return res.json({ success: false, message: 'A bill is already waiting for payment for this user.' });
        const b = await runSelBill(sel, { auto: false });
        res.json({ success: true, message: b.total > 0 ? `Bill made: ${inr(b.total)}. ID locked, report + QR sent (see the note in the list if something failed).` : 'Nothing to pay right now (0 amount). Report sent.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/selected/mark-paid', requireAdminAuth, async (req, res) => {
    try {
        const bill = await SelBillModel.findById(String(req.body?.billId || ''));
        if (!bill || !['pending', 'due'].includes(bill.state)) return res.json({ success: false, message: 'This bill is not waiting for payment.' });
        const sel = await SelectedModel.findOne({ telegramChatId: bill.telegramChatId });
        if (!sel) return res.json({ success: false, message: 'Selected user not found.' });
        await selBillFinishPaid(bill, sel, bill.state === 'due');
        res.json({ success: true, message: 'Marked as paid. ID unlocked.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.get('/api/admin/selected/report', requireAdminAuth, async (req, res) => {
    try {
        const sel = await SelectedModel.findOne({ telegramChatId: String(req.query.telegramChatId || '') }).lean();
        if (!sel) return res.status(404).json({ success: false, message: 'Selected user not found.' });
        const r = istDayRange(req.query.date);
        const rep = await buildSelReport(sel, r.start, r.end, null);
        res.set('Content-Type', XLSX_MIME);
        res.set('Content-Disposition', `attachment; filename="${rep.name}"`);
        res.send(rep.buf);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 💬 WhatsApp bot (customer chat). Flow: first message -> choose language -> main menu.
// Menu words: pay / balance / lang (or 1 / 2 / 3).  "TargetID Password" -> order (see TODO below).
// PAY: same payment gateway as the website (/api/pay). The gateway's QR is fetched and sent here as a picture;
//      when the payment succeeds the coins are added and the QR picture is DELETED from the chat.
const WaChat = mongoose.models.WaChat || mongoose.model('WaChat', new mongoose.Schema({ _id: String, lang: { type: String, default: null }, state: { type: String, default: null }, jid: String, lastSeen: Date }, { versionKey: false }));
const WaPay = mongoose.models.WaPay || mongoose.model('WaPay', new mongoose.Schema({
    orderId: { type: String, unique: true }, from: String, jid: String, lang: String,
    amount: Number, coins: Number, qrKey: mongoose.Schema.Types.Mixed,
    state: { type: String, default: 'pending' },   // pending (QR shown) | expired (QR removed, still watching for a late payment) | paid | closed
    lastCheck: { type: Date, default: null }, createdAt: { type: Date, default: Date.now }
}, { versionKey: false }));
const WA_QR_TTL_MIN = Number(process.env.WA_QR_TTL_MIN) || 10;   // QR picture is removed after this many minutes if not paid
const WA_LATE_PAY_HOURS = 24;      // gateway still accepts a payment this long after the order was created (PENDING_WINDOW_HOURS) -> keep watching
const waLastReply = new Map();     // from -> timestamp (anti-spam: max 1 reply / 3 sec per person)

const WA_T = {
    en: {
        langSet: '✅ *Language set!*',
        menu: (id, coins) =>
`✨ *JPW Reach Services bot* ⚡

📌 *Before Sending ID & Pass:*
• ✅ Workorder should be assigned in Begin Journey.
• 🗺️ Map should be open.

📩 *Send in a single message:*
\`TargetID Password\` (e.g., \`06181921 Pass@123#\`)

🆔 Mobile ID: \`${id}\`
🪙 JPW COIN: *${coins}*

🎛️ *Quick Menu (Reply with number):*
1️⃣ 📦 *Recharge Packages* (\`pay\`)
2️⃣ 🪙 *Check Balance* (\`balance\`)
3️⃣ 🌐 *Change Language* (\`lang\`)`,
        balance: (coins, plan) => `🪙 *JPW COIN:* ${coins}\n📦 *Package:* ${plan}\n\nType "menu" to go back.`,
        packs: (list) => `🛒 *Recharge Packages*\n\n${list}\n\n👉 Reply with the package number (1-${waPackCount}) to get the payment QR.\nType "menu" to cancel.`,
        badPack: `⚠️ Please reply with a valid package number, or type "menu".`,
        making: '⏳ Creating your payment QR...',
        qrCaption: (amt, coins, min) => `💳 *Pay ₹${amt}* for *${coins} Coin${coins > 1 ? 's' : ''}*\n\nScan this QR with any UPI app.\n⏱️ Valid for ${min} minutes. Coins are added automatically after payment - no need to send anything.`,
        linkOnly: (amt, coins, url, min) => `💳 *Pay ₹${amt}* for *${coins} Coin${coins > 1 ? 's' : ''}*\n\nOpen this link to pay:\n${url}\n\n⏱️ Valid for ${min} minutes. Coins are added automatically after payment.`,
        paid: (coins, bal) => `✅ *Payment successful!*\n+${coins} Coin${coins > 1 ? 's' : ''} added.\n🪙 JPW COIN: *${bal}*\n\nType "menu" to continue.`,
        expired: '⌛ Payment QR expired and was removed. If you already paid, your coins will be added shortly. Otherwise type *pay* to try again.',
        noPending: 'ℹ️ No pending payment found. Type *pay* to recharge.',
        notYet: '⏳ Payment not received yet. It can take up to a minute after you pay - type *paid* again shortly.',
        payFail: '❌ Could not create the payment right now. Please try again in a minute.',
        orderChecking: '⏳ Checking your balance and processing order...',
        orderOk: (id, coins) => `✅ *Order submitted successfully!*\n\n🎯 Target ID: \`${id}\`\n🪙 Remaining Coins: *${coins}*\n\nYou will get the status updates here.`,
        noBalance: '❌ *No Active Plan / Insufficient Balance!*\n\nYou have 0 available Coins. Type *pay* to buy a package.',
        orderFail: (m) => `⚠️ *Order Status:*\n${m}`,
        orderError: '⚠️ Connection error with the server. Please try again.',
        help: 'Type *menu* to see the options.'
    },
    hi: {
        langSet: '✅ *भाषा सेट हो गई!*',
        menu: (id, coins) =>
`✨ *JPW Reach Services bot* ⚡

📌 *ID & Pass भेजने से पहले:*
• ✅ Begin Journey में Workorder assign होना चाहिए।
• 🗺️ Map खुला होना चाहिए।

📩 *एक ही मैसेज में भेजें:*
\`TargetID Password\` (जैसे, \`06181921 Pass@123#\`)

🆔 Mobile ID: \`${id}\`
🪙 JPW COIN: *${coins}*

🎛️ *Quick Menu (नंबर भेजकर जवाब दें):*
1️⃣ 📦 *Recharge Packages* (\`pay\`)
2️⃣ 🪙 *Balance देखें* (\`balance\`)
3️⃣ 🌐 *भाषा बदलें* (\`lang\`)`,
        balance: (coins, plan) => `🪙 *JPW COIN:* ${coins}\n📦 *Package:* ${plan}\n\nवापस जाने के लिए "menu" लिखें।`,
        packs: (list) => `🛒 *Recharge Packages*\n\n${list}\n\n👉 पेमेंट QR पाने के लिए package का नंबर (1-${waPackCount}) भेजें।\nरद्द करने के लिए "menu" लिखें।`,
        badPack: `⚠️ सही package नंबर भेजें, या "menu" लिखें।`,
        making: '⏳ आपका पेमेंट QR बन रहा है...',
        qrCaption: (amt, coins, min) => `💳 *₹${amt} पे करें* — *${coins} Coin${coins > 1 ? 's' : ''}*\n\nइस QR को किसी भी UPI app से स्कैन करें।\n⏱️ ${min} मिनट तक valid। पेमेंट के बाद coins अपने-आप जुड़ जाएंगे - कुछ भेजने की ज़रूरत नहीं।`,
        linkOnly: (amt, coins, url, min) => `💳 *₹${amt} पे करें* — *${coins} Coin${coins > 1 ? 's' : ''}*\n\nपेमेंट के लिए यह लिंक खोलें:\n${url}\n\n⏱️ ${min} मिनट तक valid। पेमेंट के बाद coins अपने-आप जुड़ जाएंगे।`,
        paid: (coins, bal) => `✅ *पेमेंट सफल!*\n+${coins} Coin${coins > 1 ? 's' : ''} जुड़ गए।\n🪙 JPW COIN: *${bal}*\n\nआगे बढ़ने के लिए "menu" लिखें।`,
        expired: '⌛ पेमेंट QR का समय खत्म हो गया और उसे हटा दिया गया। अगर आप पेमेंट कर चुके हैं तो coins थोड़ी देर में जुड़ जाएंगे। नहीं तो *pay* लिखकर दोबारा कोशिश करें।',
        noPending: 'ℹ️ कोई pending पेमेंट नहीं मिला। Recharge के लिए *pay* लिखें।',
        notYet: '⏳ पेमेंट अभी नहीं मिला। पेमेंट के बाद एक मिनट तक लग सकता है - थोड़ी देर बाद फिर *paid* लिखें।',
        payFail: '❌ अभी पेमेंट नहीं बन पाया। एक मिनट बाद दोबारा कोशिश करें।',
        orderChecking: '⏳ आपका balance जाँचकर ऑर्डर लगाया जा रहा है...',
        orderOk: (id, coins) => `✅ *ऑर्डर सफलतापूर्वक भेज दिया गया!*\n\n🎯 Target ID: \`${id}\`\n🪙 बचे हुए Coins: *${coins}*\n\nस्टेटस की जानकारी यहीं मिलती रहेगी।`,
        noBalance: '❌ *कोई Active Plan नहीं / Balance कम है!*\n\nआपके पास 0 Coins हैं। Package खरीदने के लिए *pay* लिखें।',
        orderFail: (m) => `⚠️ *Order Status:*\n${m}`,
        orderError: '⚠️ सर्वर से कनेक्शन में दिक्कत। दोबारा कोशिश करें।',
        help: 'विकल्प देखने के लिए *menu* लिखें।'
    }
};
const WA_LANG_ASK = `🌐 *Select your language / अपनी भाषा चुनें*\n\n1️⃣ English\n2️⃣ हिन्दी\n\n_Reply 1 or 2_`;

async function waGetUser(from, name) {
    const chatKey = `wa:${from}`;
    let user = await UserModel.findOne({ telegramChatId: chatKey });
    if (!user) {
        user = await UserModel.create({ telegramChatId: chatKey, name: name || 'Engineer', referralCode: await generateUniqueReferralCode() });
    }
    return user;
}

// ---- find the QR picture of the gateway checkout page and return it as an image Buffer (or null) ----
async function waFetchWithTimeout(url, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }); }
    finally { clearTimeout(timer); }
}
async function waQrFromValue(v, baseUrl) {
    if (!v || typeof v !== 'string') return null;
    v = v.trim().replace(/&amp;/g, '&');
    const QRCodeLib = require('qrcode');
    let m = v.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (m) return Buffer.from(m[1], 'base64');
    if (/^[A-Za-z0-9+/=]{200,}$/.test(v)) return Buffer.from(v, 'base64');       // bare base64 png
    if (/^upi:\/\//i.test(v)) return QRCodeLib.toBuffer(v, { margin: 2, width: 420 }); // UPI link -> draw QR ourselves
    if (/^(https?:\/\/|\/)/i.test(v) && /qr|\.png|\.jpe?g|\.webp/i.test(v)) {
        const r = await waFetchWithTimeout(new URL(v, baseUrl).toString());
        if (r.ok && /^image\//i.test(r.headers.get('content-type') || '')) return Buffer.from(await r.arrayBuffer());
    }
    return null;
}
async function waFetchQr(checkoutUrl, pgData) {
    try {
        // 1) the gateway's create-payment answer may already carry the QR / UPI link
        for (const k of ['qrCodeUrl', 'qr', 'qrImage', 'qr_image', 'qrCode', 'qr_code', 'upiUrl', 'upiLink', 'upi_link', 'upi', 'intent']) {
            const b = await waQrFromValue(pgData && pgData[k], checkoutUrl);
            if (b) return b;
        }
        // 2) open the checkout page and look for the QR in it
        const r = await waFetchWithTimeout(checkoutUrl);
        const ct = r.headers.get('content-type') || '';
        if (/^image\//i.test(ct)) return Buffer.from(await r.arrayBuffer());
        const html = await r.text();
        let m = html.match(/data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/i);
        if (m) { const b = await waQrFromValue(m[0], checkoutUrl); if (b) return b; }
        m = html.match(/upi:\/\/pay\?[^"'<>\s\\]+/i);
        if (m) { const b = await waQrFromValue(m[0], checkoutUrl); if (b) return b; }
        const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(x => x[1]);
        for (const src of imgs.sort((x, y) => (/qr/i.test(y) ? 1 : 0) - (/qr/i.test(x) ? 1 : 0))) {
            const b = await waQrFromValue(src, checkoutUrl);
            if (b) return b;
        }
        debugLog('WhatsApp', 'QR not found on checkout page - sending link instead.');
    } catch (e) { debugLog('WhatsApp', 'waFetchQr failed:', e.message); }
    return null;
}

// ---- create the payment (same rules/gateway as the website's /api/pay) and send the QR ----
async function getWaPacks() {
    const list = WEB_RECHARGE_PACKAGES.map(p => ({ ...p }));
    try {
        const offers = await OfferModel.find(offerLiveFilter()).sort({ createdAt: -1 }).select('name packages').lean();
        for (const o of offers) for (const q of (o.packages || [])) { if (list.length < 40) list.push({ amount: q.amount, coins: q.coins, offerName: o.name }); }
    } catch (e) {}
    return list;
}
async function waStartPayment({ from, jid, lang, pack }) {
    const T = WA_T[lang] || WA_T.en;
    const chatKey = `wa:${from}`;
    const orderId = `ORD_${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    await PaymentModel.create({ orderId, amount: pack.amount, coins: pack.coins, telegramChatId: chatKey, status: 'PENDING' });
    let pgData;
    try {
        const r = await fetch(PRIVATE_PG_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': PRIVATE_API_KEY },
            body: JSON.stringify({ amount: pack.amount, orderId })
        });
        pgData = await r.json();
    } catch (e) { debugLog('WhatsApp', 'gateway error:', e.message); }
    if (!pgData || !pgData.success || !pgData.checkoutUrl) {
        await PaymentModel.updateOne({ orderId }, { $set: { status: 'FAILED' } });
        return wa.reply(jid, T.payFail);
    }
    const qr = await waFetchQr(pgData.checkoutUrl, pgData);
    let qrKey = null;
    if (qr) {
        qrKey = await wa.sendImage(jid, qr, T.qrCaption(pack.amount, pack.coins, WA_QR_TTL_MIN));
    } else {
        await wa.reply(jid, T.linkOnly(pack.amount, pack.coins, pgData.checkoutUrl, WA_QR_TTL_MIN));
    }
    await WaPay.create({ orderId, from, jid, lang, amount: pack.amount, coins: pack.coins, qrKey });
}

// ---- same crediting rules as /api/verify-instant (never double-credits) ----
async function waCreditPayment(rec, askGateway = true) {
    const chatKey = `wa:${rec.from}`;
    const pay = await PaymentModel.findOne({ orderId: rec.orderId, telegramChatId: chatKey });
    if (!pay) return null;
    if (pay.status !== 'SUCCESS') {
        if (!askGateway) return null;                       // late-payment watch: the gateway updates the DB itself
        const gw = await checkGatewayPaymentStatus(rec.orderId);
        if (gw && gw.status === 'SUCCESS' && gw.amount === Number(pay.amount)) { pay.status = 'SUCCESS'; await pay.save(); }
        else return null;
    }
    if (!pay.coins || pay.coins <= 0) return null;
    try { await UsedUtrModel.create({ utrId: rec.orderId }); }
    catch (e) { if (e && e.code === 11000) return await UserModel.findOne({ telegramChatId: chatKey }); throw e; }   // already credited
    return await UserModel.findOneAndUpdate(
        { telegramChatId: chatKey },
        { $inc: { jpwCoins: pay.coins }, $set: { lastPackageCoins: pay.coins, activePackage: `₹${pay.amount} (${pay.coins} Coins)`, packageExpiryTime: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000) } },
        { new: true }
    );
}

// ---- every few seconds: paid -> add coins + DELETE the QR picture;  too old -> DELETE the QR picture ----
// The payment gateway uses the SAME database ("payments" collection) and checks Paytm emails every 15 s, so the status
// is read straight from the DB. If the gateway is asleep, one check-status call wakes it and re-checks immediately.
// After the QR is removed we keep watching for WA_LATE_PAY_HOURS: a customer who pays late still gets the coins.
let waSweeping = false;
async function waDeleteQr(rec) {
    if (!rec.qrKey) return;
    try { await wa.deleteMessage(rec.jid, rec.qrKey); } catch (e) { debugLog('WhatsApp', 'QR delete failed:', e.message); }
    await WaPay.updateOne({ _id: rec._id }, { $set: { qrKey: null } });
}
async function waFinishPaid(rec, user) {
    const T = WA_T[rec.lang] || WA_T.en;
    await WaPay.updateOne({ _id: rec._id }, { $set: { state: 'paid' } });
    await waDeleteQr(rec);   // payment done -> QR picture removed from the chat
    try { await wa.reply(rec.jid, T.paid(rec.coins, user.jpwCoins.toFixed(2))); } catch (e) {}
}
// Customer typed "paid" / "status": check the payment right now (database first, then the gateway).
async function waCheckNow(from, jid, lang) {
    const T = WA_T[lang] || WA_T.en;
    const rec = await WaPay.findOne({ from, state: { $in: ['pending', 'expired'] } }).sort({ createdAt: -1 });
    if (!rec) return wa.reply(jid, T.noPending);
    const user = await waCreditPayment(rec, true);
    if (user) return waFinishPaid(rec, user);
    return wa.reply(jid, T.notYet);
}

setInterval(async () => {
    if (waSweeping || !wa.isConnected() || mongoose.connection.readyState !== 1) return;
    waSweeping = true;
    try {
        const list = await WaPay.find({ state: { $in: ['pending', 'expired'] } }).limit(30);
        for (const rec of list) {
            const T = WA_T[rec.lang] || WA_T.en;
            const ageMin = (Date.now() - rec.createdAt.getTime()) / 60000;
            const gap = rec.state === 'pending' ? 6000 : 30000;
            if (rec.lastCheck && Date.now() - rec.lastCheck.getTime() < gap) continue;
            await WaPay.updateOne({ _id: rec._id }, { $set: { lastCheck: new Date() } });
            if (ageMin > WA_LATE_PAY_HOURS * 60) { await WaPay.updateOne({ _id: rec._id }, { $set: { state: 'closed' } }); continue; }

            let user = null;
            try { user = await waCreditPayment(rec, rec.state === 'pending'); } catch (e) { debugLog('WhatsApp', 'credit check failed:', e.message); }
            if (user) {
                await waFinishPaid(rec, user);
            } else if (rec.state === 'pending' && ageMin >= WA_QR_TTL_MIN) {
                await WaPay.updateOne({ _id: rec._id }, { $set: { state: 'expired' } });
                await waDeleteQr(rec);   // time is up -> QR picture removed from the chat
                try { await wa.reply(rec.jid, T.expired); } catch (e) {}
            }
        }
    } catch (e) { debugLog('WhatsApp', 'payment sweeper error:', e.message); }
    finally { waSweeping = false; }
}, 6000);


// Send a message to a WhatsApp customer by chat key "wa:<number>" (used for order replies, refunds, expiry notices).
// Telegram-style **bold** is turned into WhatsApp *bold*.
async function waNotify(chatKey, text) {
    try {
        const from = String(chatKey).replace(/^wa:/, '');
        const chat = await WaChat.findById(from).lean();
        const jid = (chat && chat.jid) || `${from}@s.whatsapp.net`;
        const msg = String(text || '').replace(/\*\*/g, '*');
        await wa.reply(jid, msg);
    } catch (e) { debugLog('WhatsApp', 'customer notify failed:', e.message); }
}

async function waSubmitOrder({ from, jid, lang, targetId, targetPass }) {
    const T = WA_T[lang] || WA_T.en;
    await wa.reply(jid, T.orderChecking);
    let result;
    try { result = await placeOrder({ telegramChatId: `wa:${from}`, targetId, targetPass }); }
    catch (e) { debugLog('WhatsApp', 'placeOrder failed:', e.message); return wa.reply(jid, T.orderError); }
    if (result.success && result.selected) return wa.reply(jid, lang === 'hi' ? `✅ *ऑर्डर सफलतापूर्वक भेज दिया गया!*\n\n🎯 Target ID: \`${targetId}\`\n\nस्टेटस की जानकारी यहीं मिलती रहेगी।` : `✅ *Order submitted successfully!*\n\n🎯 Target ID: \`${targetId}\`\n\nYou will get the status updates here.`);
    if (result.success) return wa.reply(jid, T.orderOk(targetId, Number(result.remainingCoins || 0).toFixed(2)));
    const m = String(result.message || '');
    if (/insufficient|coin/i.test(m) && !/refund/i.test(m)) return wa.reply(jid, T.noBalance);
    return wa.reply(jid, T.orderFail(m));
}

wa.onMessage(async ({ from, jid, text, hasMedia, pushName }) => {
    const now = Date.now();
    if (now - (waLastReply.get(from) || 0) < 3000) return;
    waLastReply.set(from, now);
    if (waLastReply.size > 5000) waLastReply.clear();
    if (mongoose.connection.readyState !== 1) return;

    const msg = String(text || '').trim();
    const low = msg.toLowerCase();

    // secret admin code (see WA_ADMIN_CODE_HASH) and admin-only words
    if (/^JPW-ADM-/i.test(msg.replace(/\s+/g, ''))) {
        const r = await waTryAdminCode(from, jid, msg);
        if (r === 'ok') return wa.reply(jid, '✅ *Admin registered.* This number will now receive the nightly backup.\nWords: *backup* (send backup now), *admin off* (remove this number).');
        if (r === 'blocked') return;
        return wa.reply(jid, '❌ Wrong code.');
    }
    const waAdmins = await waGetAdmins();
    if (waAdmins.some(a => a.number === from)) {
        if (/^backup$/i.test(low)) {
            await wa.reply(jid, '⏳ Building the full backup...');
            const r = await runBackup('requested on WhatsApp');
            return wa.reply(jid, r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
        }
        if (/^admin\s+off$/i.test(low)) { await waSaveAdmins(waAdmins.filter(a => a.number !== from)); return wa.reply(jid, '✅ This number is no longer an admin.'); }
    }
    const chat = await WaChat.findById(from).lean();
    const send = (m) => wa.reply(jid, m);
    await WaChat.updateOne({ _id: from }, { $set: { lastSeen: new Date(), jid } }, { upsert: true });

    // 1) language not chosen yet -> ask (any first message: hi / hello / anything)
    if (!chat || !chat.lang) {
        let pick = null;
        if (chat && /^(1|english|en)$/i.test(low)) pick = 'en';
        if (chat && /^(2|hindi|हिन्दी|हिंदी)$/i.test(low)) pick = 'hi';
        if (!pick) return send(WA_LANG_ASK);
        await WaChat.updateOne({ _id: from }, { $set: { lang: pick, state: null } });
        const user = await waGetUser(from, pushName);
        const T = WA_T[pick];
        return send(T.langSet + '\n\n' + T.menu(from, user.jpwCoins.toFixed(2)));
    }

    const T = WA_T[chat.lang] || WA_T.en;
    const user = await waGetUser(from, pushName);
    const setState = (s) => WaChat.updateOne({ _id: from }, { $set: { state: s } });

    if (/^(menu|start|hi|hello|hey|hii+|namaste|0)$/i.test(low)) { await setState(null); return send(T.menu(from, user.jpwCoins.toFixed(2))); }

    // 2) waiting for a package number
    if (chat.state === 'choose_pack') {
        const n = /^\d+$/.test(low) ? parseInt(low, 10) : 0;
        const pack = (await getWaPacks())[n - 1];
        if (!pack) return send(T.badPack);
        await setState(null);
        await send(T.making);
        return waStartPayment({ from, jid, lang: chat.lang, pack });
    }

    if (/^(paid|status|check|done|payment)$/i.test(low)) return waCheckNow(from, jid, chat.lang);
    if (/^(lang|3|language)$/i.test(low)) { await WaChat.updateOne({ _id: from }, { $set: { lang: null } }); return send(WA_LANG_ASK); }
    if (/^(balance|2|bal)$/i.test(low)) return send(T.balance(user.jpwCoins.toFixed(2), user.activePackage || 'No active package'));
    if (/^(pay|1|recharge|packages?)$/i.test(low)) {
        const packs = await getWaPacks();
        waPackCount = packs.length;
        const list = packs.map((p, i) => `${i + 1}️⃣ ₹${p.amount} → ${p.coins} Coin${p.coins > 1 ? 's' : ''}${p.offerName ? ' 🎁 ' + p.offerName : ''}`).join('\n');
        await setState('choose_pack');
        return send(T.packs(list));
    }
    // "TargetID Password" in one message
    const parts = msg.split(/\s+/);
    // WhatsApp is also used for normal chatting, so only treat it as an order when the first word looks like a Tech ID
    // (4-20 letters/digits with at least one digit). Otherwise "i want to pay" would burn a coin.
    if (parts.length >= 2 && /^[A-Za-z0-9_-]{4,20}$/.test(parts[0]) && /\d/.test(parts[0])) {
        return waSubmitOrder({ from, jid, lang: chat.lang, targetId: parts[0].trim(), targetPass: parts.slice(1).join(' ').trim() });
    }
    return send(T.help);
});

// =====================================================================================================
// 🛡️ SAFETY NET 1: every 1 hour, find payments that were really paid (gateway says SUCCESS) but coins were never added
//    (payment still shows PENDING/FAILED, or SUCCESS but not credited) and add the coins automatically.
// 🛡️ SAFETY NET 2: every night at 12:00 AM (IST) the COMPLETE MongoDB is exported, locked with a password and sent to the
//    admin (Telegram + the WhatsApp number(s) registered with the admin code).
// =====================================================================================================
const RECONCILE_EVERY_MS = 60 * 60 * 1000;          // every hour: fetch the complete payment list from the gateway and fix anything missed
const RECONCILE_WINDOW_MS = 72 * 60 * 60 * 1000;   // look at payments created in the last 72 hours
const RECONCILE_MIN_AGE_MS = 30 * 60 * 1000;       // newer ones are still being handled live (QR sweeper / website)

// same crediting rule as /api/verify-instant: the UsedUtr claim guarantees a payment is credited only ONCE, whoever gets there first
async function creditPaymentRecord(pay) {
    try { await UsedUtrModel.create({ utrId: pay.orderId }); }
    catch (e) { if (e && e.code === 11000) return null; throw e; }
    const user = await UserModel.findOneAndUpdate(
        { telegramChatId: pay.telegramChatId },
        { $inc: { jpwCoins: pay.coins }, $set: { lastPackageCoins: pay.coins, activePackage: `₹${pay.amount} (${pay.coins} Coins)`, packageExpiryTime: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000) } },
        { new: true }
    );
    if (!user) { await UsedUtrModel.deleteOne({ utrId: pay.orderId }).catch(() => {}); return null; }   // user not found: undo the claim
    sendLogToGoogleSheet({ logType: 'PAYMENT', actionType: 'AUTO_RECOVERED_PAYMENT', identifier: pay.telegramChatId, subDetails: `Name: ${user.name}`, amountOrCoins: `${pay.coins} Coins (₹${pay.amount})`, utrId: pay.orderId });
    return user;
}

async function reconcilePayments(tag = 'run') {
    const result = { checked: 0, recovered: 0, notPaid: 0, lines: [] };
    if (mongoose.connection.readyState !== 1) return result;
    const from = new Date(Date.now() - RECONCILE_WINDOW_MS), to = new Date(Date.now() - RECONCILE_MIN_AGE_MS);
    const recs = await PaymentModel.find({ createdAt: { $gte: from, $lte: to }, coins: { $gt: 0 } }).sort({ createdAt: 1 }).limit(300);
    if (!recs.length) { rlog(tag, { result: 'RUN', note: 'Check karne ke liye koi payment nahi mila (pichle 72 ghante).' }); return result; }
    const done = new Set((await UsedUtrModel.find({ utrId: { $in: recs.map(r => r.orderId) } }).select('utrId').lean()).map(x => x.utrId));
    let gwCalls = 0;
    for (const pay of recs) {
        if (done.has(pay.orderId)) continue;                          // already credited
        result.checked++;
        const base = { orderId: pay.orderId, chatId: String(pay.telegramChatId), amount: pay.amount, coins: pay.coins };
        if (pay.status !== 'SUCCESS') {
            if (gwCalls >= 40) { rlog(tag, { ...base, result: 'SKIPPED', note: 'Gateway limit (40 checks) poori hui - agli run me check hoga.' }); continue; }   // be gentle with the gateway (it limits calls per minute)
            gwCalls++;
            const gw = await checkGatewayPaymentStatus(pay.orderId);
            await new Promise(r => setTimeout(r, 1500));
            if (!gw) { rlog(tag, { ...base, result: 'GATEWAY_ERROR', note: 'Gateway ne jawab nahi diya (band ya slow).' }); continue; }
            if (gw.status !== 'SUCCESS') { result.notPaid++; rlog(tag, { ...base, result: 'NOT_PAID', note: `Gateway status: ${gw.status || 'unknown'} - paisa abhi tak nahi aaya.` }); continue; }
            if (gw.amount !== Number(pay.amount)) { rlog(tag, { ...base, result: 'AMOUNT_MISMATCH', note: `Gateway amount ₹${gw.amount} aur order amount ₹${pay.amount} match nahi hua - coins nahi diye.` }); continue; }
            pay.status = 'SUCCESS'; await pay.save();                 // the DB now shows the truth
        }
        const user = await creditPaymentRecord(pay);
        if (!user) { rlog(tag, { ...base, result: 'SKIPPED', note: 'Pehle se credit ho chuka ya customer nahi mila.' }); continue; }
        result.recovered++;
        rlog(tag, { ...base, result: 'RECOVERED', note: `${pay.coins} coin(s) customer ke account me add kiye.` });
        result.lines.push(`• ${pay.orderId} - ₹${pay.amount} → ${pay.coins} coin(s) → ${pay.telegramChatId}`);
        debugLog('Reconcile', `Recovered payment ${pay.orderId} (${pay.coins} coins) for ${pay.telegramChatId}`);
        // tell the customer
        try {
            const key = String(pay.telegramChatId);
            const msg = `✅ **Payment received!**\n+${pay.coins} Coin${pay.coins > 1 ? 's' : ''} added to your account.\n🪙 JPW COIN: **${user.jpwCoins.toFixed(2)}**`;
            if (key.startsWith('wa:')) await waNotify(key, msg);
            else if (!key.startsWith('WEB_') && CUSTOMER_BOT_TOKEN) await new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false }).sendMessage(key, msg, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (e) {}
    }
    rlog(tag, { result: 'RUN', note: `Checked: ${result.checked} | Recovered: ${result.recovered} | Paisa nahi aaya: ${result.notPaid}` });
    if (result.recovered && ADMIN_BOT_TOKEN && ADMIN_CHAT_ID) {
        new TelegramBot(ADMIN_BOT_TOKEN, { polling: false }).sendMessage(ADMIN_CHAT_ID, `🔁 Auto-recovery: ${result.recovered} paid order(s) were missing coins and have been fixed.\n\n${result.lines.join('\n')}`).catch(() => {});
    }
    return result;
}
let reconcileRunning = false;
const reconcileState = { running: false, tag: '', startedAt: null, finishedAt: null, checked: 0, recovered: 0 };
async function runReconcile(tag) {
    if (reconcileRunning) return null;
    reconcileRunning = true;
    Object.assign(reconcileState, { running: true, tag, startedAt: new Date(), finishedAt: null });
    try {
        const r = await reconcilePayments(tag);
        Object.assign(reconcileState, { checked: r.checked, recovered: r.recovered });
        debugLog('Reconcile', `${tag}: checked ${r.checked}, recovered ${r.recovered}`);
        return r;
    }
    catch (e) { debugLog('Reconcile', 'failed:', e.message); rlog(tag, { result: 'ERROR', note: 'Recovery fail hui: ' + e.message }); return null; }
    finally { reconcileRunning = false; reconcileState.running = false; reconcileState.finishedAt = new Date(); }
}
setInterval(() => { runReconcile('1-hour run'); }, RECONCILE_EVERY_MS);
setTimeout(() => { runReconcile('startup run'); }, 3 * 60 * 1000);   // also shortly after every restart

// ---------------- WhatsApp admin registration (secret code) ----------------
// .env / Render variable WA_ADMIN_CODE_HASH holds only the SHA-256 of the secret code (the code itself is never stored).
// Send the code from a WhatsApp number once -> that number becomes an admin (receives backups, can type "backup").
const WA_ADMIN_HASH_ENV = String(process.env.WA_ADMIN_CODE_HASH || '').trim().toLowerCase();
async function getSettingValue(key) { try { const s = await SettingModel.findOne({ key }).lean(); return s && s.value ? String(s.value) : ''; } catch (e) { return ''; } }
async function setSettingValue(key, value) { await SettingModel.findOneAndUpdate({ key }, { value, updatedAt: new Date() }, { upsert: true }); }
// the code set from the Admin Panel wins; the environment variable is only the fallback
async function getWaAdminHash() { return ((await getSettingValue('wa_admin_code_hash')) || WA_ADMIN_HASH_ENV).trim().toLowerCase(); }
async function getBackupPasswordInfo() {
    const fromPanel = await getSettingValue('backup_password');
    if (fromPanel) return { value: fromPanel, source: 'panel' };
    if (process.env.BACKUP_PASSWORD) return { value: String(process.env.BACKUP_PASSWORD), source: 'env' };
    if (process.env.ADMIN_SECRET_PASS) return { value: String(process.env.ADMIN_SECRET_PASS), source: 'admin-pass' };
    return { value: '', source: 'none' };
}
const waCodeHash = (s) => crypto.createHash('sha256').update(String(s).toUpperCase().replace(/\s+/g, '')).digest('hex');
const waAdminFails = new Map();   // from -> { n, until }
async function waGetAdmins() {
    try { const s = await SettingModel.findOne({ key: 'wa_admins' }).lean(); return s && s.value ? JSON.parse(s.value) : []; } catch (e) { return []; }
}
async function waSaveAdmins(list) {
    await SettingModel.findOneAndUpdate({ key: 'wa_admins' }, { value: JSON.stringify(list), updatedAt: new Date() }, { upsert: true });
}
async function waTryAdminCode(from, jid, msg) {
    const f = waAdminFails.get(from) || { n: 0, until: 0 };
    if (f.until > Date.now()) return 'blocked';
    const hashNow = await getWaAdminHash();
    const ok = /^[0-9a-f]{64}$/.test(hashNow)
        && crypto.timingSafeEqual(Buffer.from(waCodeHash(msg), 'hex'), Buffer.from(hashNow, 'hex'));
    if (!ok) {
        f.n++;
        if (f.n >= 5) { f.until = Date.now() + 60 * 60 * 1000; f.n = 0; }   // 5 wrong tries -> locked for 1 hour
        waAdminFails.set(from, f);
        return 'wrong';
    }
    waAdminFails.delete(from);
    const list = (await waGetAdmins()).filter(a => a.number !== from);
    list.push({ number: from, jid, at: new Date().toISOString() });
    await waSaveAdmins(list);
    debugLog('WhatsApp', `Admin registered: +${from}`);
    return 'ok';
}

// ---------------- nightly full backup ----------------
async function buildBackupFile() {
    const db = mongoose.connection.db;
    const { EJSON } = (mongoose.mongo && mongoose.mongo.BSON) || {};
    const ser = (d) => EJSON ? EJSON.stringify(d, { relaxed: false }) : JSON.stringify(d);
    const gz = zlib.createGzip({ level: 6 });
    const chunks = [];
    gz.on('data', c => chunks.push(c));
    const finished = new Promise((res, rej) => { gz.on('end', res); gz.on('error', rej); });
    const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort();
    gz.write(`{"app":"jpw","createdAt":${JSON.stringify(new Date().toISOString())},"database":${JSON.stringify(db.databaseName)},"collections":{`);
    const counts = {};
    let firstCol = true;
    for (const name of cols) {
        gz.write(`${firstCol ? '' : ','}${JSON.stringify(name)}:[`);
        firstCol = false;
        let n = 0;
        const filter = name === 'settings' ? { key: { $nin: ['backup_password'] } } : {};   // the password is never stored inside the file it locks
        for await (const doc of db.collection(name).find(filter)) { gz.write((n ? ',' : '') + ser(doc)); n++; }
        gz.write(']');
        counts[name] = n;
    }
    gz.write('}}');
    gz.end();
    await finished;
    const plain = Buffer.concat(chunks);
    // lock it (AES-256-GCM, key from password) - Telegram/WhatsApp store files on their servers
    const pass = (await getBackupPasswordInfo()).value;
    if (!pass) throw new Error('Set the backup password in the Admin Panel (Security & Backup card) so the backup can be locked.');
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(pass, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const file = Buffer.concat([Buffer.from('JPWBK1'), salt, iv, cipher.getAuthTag(), enc]);
    return { file, counts, plainSize: plain.length };
}
function istDateStr() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

let backupRunning = false;
async function runBackup(reason) {
    if (backupRunning) return { ok: false, message: 'Backup already running.' };
    backupRunning = true;
    try {
        if (mongoose.connection.readyState !== 1) return { ok: false, message: 'Database not connected.' };
        const day = istDateStr();
        const { file, counts, plainSize } = await buildBackupFile();
        const MAX = 45 * 1024 * 1024;                        // Telegram bots can send files up to 50 MB
        const parts = Math.max(1, Math.ceil(file.length / MAX));
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const mb = (file.length / 1048576).toFixed(2);
        const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
        let sentTo = [];
        for (let i = 0; i < parts; i++) {
            const buf = file.subarray(i * MAX, (i + 1) * MAX);
            const name = `jpw-backup-${day}.json.gz.enc` + (parts > 1 ? `.part${i + 1}of${parts}` : '');
            const cap = `🗄️ JPW full backup ${day} (${reason})\n${total} records, ${mb} MB${parts > 1 ? `\nPart ${i + 1}/${parts}` : ''}`;
            if (ADMIN_BOT_TOKEN && ADMIN_CHAT_ID) {
                try { await new TelegramBot(ADMIN_BOT_TOKEN, { polling: false }).sendDocument(ADMIN_CHAT_ID, buf, { caption: cap }, { filename: name, contentType: 'application/octet-stream' }); if (!sentTo.includes('Telegram')) sentTo.push('Telegram'); }
                catch (e) { debugLog('Backup', 'Telegram send failed:', e.message); }
            }
        }
        // WhatsApp: smaller pieces (12 MB), sent one by one with a short gap and one retry. Big single files are the usual reason
        // a backup shows "Waiting for this message" on the phone.
        if (wa.isConnected()) {
            const WA_MAX = 12 * 1024 * 1024;
            const waParts = Math.max(1, Math.ceil(file.length / WA_MAX));
            for (const a of await waGetAdmins()) {
                const jid = a.jid || `${a.number}@s.whatsapp.net`;
                for (let i = 0; i < waParts; i++) {
                    const buf = file.subarray(i * WA_MAX, (i + 1) * WA_MAX);
                    const name = `jpw-backup-${day}.json.gz.enc` + (waParts > 1 ? `.part${i + 1}of${waParts}` : '');
                    const cap = `🗄️ JPW full backup ${day} (${reason})\n${total} records, ${mb} MB${waParts > 1 ? `\nPart ${i + 1}/${waParts} - join all parts in order` : ''}`;
                    let ok = false;
                    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
                        try { await wa.sendDocument(jid, buf, name, cap); ok = true; if (!sentTo.includes('WhatsApp')) sentTo.push('WhatsApp'); }
                        catch (e) { debugLog('Backup', `WhatsApp send to +${a.number} part ${i + 1} failed (try ${attempt}):`, e.message); if (attempt < 2) await new Promise(r => setTimeout(r, 4000)); }
                    }
                    if (i < waParts - 1) await new Promise(r => setTimeout(r, 2500));
                }
            }
        }
        if (!sentTo.length) return { ok: false, message: 'Backup was built but could not be sent (no admin Telegram / WhatsApp reachable).' };
        await SettingModel.findOneAndUpdate({ key: 'lastBackupDay' }, { value: day, updatedAt: new Date() }, { upsert: true });
        debugLog('Backup', `Sent ${mb} MB (${total} records) to ${sentTo.join(' + ')}`);
        return { ok: true, message: `Backup sent to ${sentTo.join(' + ')} (${total} records, ${mb} MB).`, summary };
    } catch (e) {
        debugLog('Backup', 'failed:', e.message);
        if (ADMIN_BOT_TOKEN && ADMIN_CHAT_ID) new TelegramBot(ADMIN_BOT_TOKEN, { polling: false }).sendMessage(ADMIN_CHAT_ID, `⚠️ Nightly backup FAILED: ${e.message}`).catch(() => {});
        return { ok: false, message: e.message };
    } finally { backupRunning = false; }
}
// Once per IST day, at/after 12:00 AM (if the server was asleep at midnight it runs as soon as it wakes up).
setInterval(async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const day = istDateStr();
        const last = await SettingModel.findOne({ key: 'lastBackupDay' }).lean();
        if (last && last.value === day) return;
        await runBackup('nightly');
    } catch (e) { debugLog('Backup', 'scheduler error:', e.message); }
}, 60 * 1000);

app.get('/api/admin/security', requireAdminAuth, async (req, res) => {
    const pw = await getBackupPasswordInfo();
    const hasPanelCode = !!(await getSettingValue('wa_admin_code_hash'));
    res.json({
        success: true,
        backupPassword: { set: !!pw.value, source: pw.source },
        adminCode: { set: hasPanelCode || /^[0-9a-f]{64}$/.test(WA_ADMIN_HASH_ENV), source: hasPanelCode ? 'panel' : (WA_ADMIN_HASH_ENV ? 'env' : 'none') },
        lastBackupDay: await getSettingValue('lastBackupDay'),
        admins: (await waGetAdmins()).map(a => ({ number: a.number, at: a.at, via: a.via || 'code' })),
        telegramAdmin: !!(ADMIN_BOT_TOKEN && ADMIN_CHAT_ID),
        whatsapp: wa.getStatus().state
    });
});
app.post('/api/admin/security/backup-password', requireAdminAuth, async (req, res) => {
    const pw = String(req.body?.password || '');
    if (pw.length < 8 || pw.length > 100) return res.json({ success: false, message: 'Password kam se kam 8 akshar ka hona chahiye.' });
    await setSettingValue('backup_password', pw);
    res.json({ success: true, message: '✅ Backup password save ho gaya. Is date ke baad ke backups isi password se khulenge (purane backups purane password se).' });
});
app.post('/api/admin/security/wa-admin-code', requireAdminAuth, async (req, res) => {
    let code = String(req.body?.code || '').toUpperCase().replace(/\s+/g, '');
    if (code) {
        if (!code.startsWith('JPW-ADM-')) code = 'JPW-ADM-' + code;
        if (code.length < 16 || code.length > 60 || !/^[A-Z0-9-]+$/.test(code)) return res.json({ success: false, message: 'Code me kam se kam 8 akshar/number (A-Z, 0-9, -) hone chahiye.' });
    } else {
        const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const grp = () => Array.from(crypto.randomBytes(4), b => A[b % A.length]).join('');
        code = `JPW-ADM-${grp()}-${grp()}-${grp()}-${grp()}`;
    }
    await setSettingValue('wa_admin_code_hash', waCodeHash(code));
    res.json({ success: true, code, message: 'Naya code ban gaya. Ise abhi copy kar lein - ye dobara dikhaya nahi jaata. Purana code ab kaam nahi karega.' });
});
app.post('/api/admin/security/admins/add', requireAdminAuth, async (req, res) => {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    if (number.length < 10 || number.length > 15) return res.json({ success: false, message: 'Number galat hai. Country code ke saath likhiye, e.g. 919876543210.' });
    const list = (await waGetAdmins()).filter(a => a.number !== number);
    list.push({ number, jid: `${number}@s.whatsapp.net`, at: new Date().toISOString(), via: 'panel' });
    await waSaveAdmins(list);
    res.json({ success: true, message: `✅ +${number} ab backup receive karega.` });
});
app.post('/api/admin/security/admins/remove', requireAdminAuth, async (req, res) => {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    await waSaveAdmins((await waGetAdmins()).filter(a => a.number !== number));
    res.json({ success: true, message: 'Removed.' });
});
app.post('/api/admin/backup-now', requireAdminAuth, async (req, res) => { res.json(await runBackup('manual')); });
// Starts the recovery in the background and answers at once (a full run can take over a minute, which made the browser get an empty reply).
app.post('/api/admin/reconcile-now', requireAdminAuth, (req, res) => {
    if (reconcileRunning) return res.json({ success: false, running: true, message: 'Recovery pehle se chal rahi hai - logs me dekhein.' });
    runReconcile('manual run');
    res.json({ success: true, started: true, message: 'Recovery shuru ho gayi. Neeche logs me live dikhega.' });
});

// IST day helpers (IST = UTC+5:30, no daylight saving)
function istDayRange(dateStr) {
    const IST = 330 * 60000;
    let start;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) start = Date.parse(dateStr + 'T00:00:00+05:30');
    if (!start || isNaN(start)) start = Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST;
    return { start: new Date(start), end: new Date(start + 86400000), label: new Date(start + IST).toISOString().slice(0, 10) };
}
const payChannel = id => (String(id).startsWith('wa:') ? 'WhatsApp' : (String(id).startsWith('WEB_') ? 'Web / App' : 'Telegram'));

// Payments overview for one day (default: today, IST): how many payment requests, paid, still waiting, failed/cancelled
app.get('/api/admin/payments/summary', requireAdminAuth, async (req, res) => {
    try {
        const { start, end, label } = istDayRange(req.query.date);
        const filter = { createdAt: { $gte: start, $lt: end } };
        const [groups, customers, list] = await Promise.all([
            PaymentModel.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 }, amt: { $sum: '$amount' } } }]),
            PaymentModel.distinct('telegramChatId', filter),
            PaymentModel.find(filter).sort({ createdAt: -1 }).limit(100).lean()
        ]);
        const g = {}; groups.forEach(x => { g[x._id] = x; });
        const n = k => (g[k] ? g[k].n : 0), amt = k => (g[k] ? g[k].amt : 0);
        const total = groups.reduce((a, x) => a + x.n, 0);
        const successIds = (await PaymentModel.find({ ...filter, status: 'SUCCESS' }).select('orderId').limit(1000).lean()).map(x => x.orderId);
        const creditedSet = new Set((await UsedUtrModel.find({ utrId: { $in: list.map(x => x.orderId).concat(successIds) } }).select('utrId').lean()).map(x => x.utrId));
        const paidNotCredited = successIds.filter(id => !creditedSet.has(id)).length;
        const names = {};
        (await UserModel.find({ telegramChatId: { $in: [...new Set(list.map(x => String(x.telegramChatId)))] } }).select('telegramChatId name').lean()).forEach(u => { names[u.telegramChatId] = u.name; });
        const failed = total - n('SUCCESS') - n('PENDING');
        res.json({
            success: true, date: label,
            totals: { requests: total, customers: customers.length, success: n('SUCCESS'), pending: n('PENDING'), failed, paidNotCredited, amountReceived: amt('SUCCESS'), amountPending: amt('PENDING') },
            payments: list.map(x => ({
                orderId: x.orderId, at: x.createdAt, amount: x.amount, coins: x.coins, status: x.status,
                customerId: String(x.telegramChatId), name: names[String(x.telegramChatId)] || '', channel: payChannel(x.telegramChatId),
                credited: creditedSet.has(x.orderId)
            }))
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Auto Payment Recovery logs (newest first) + whether a run is going on right now
app.get('/api/admin/reconcile-logs', requireAdminAuth, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 500);
        const logs = await ReconcileLogModel.find({}).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({
            success: true,
            state: { running: reconcileState.running, tag: reconcileState.tag, startedAt: reconcileState.startedAt, finishedAt: reconcileState.finishedAt, everyHours: RECONCILE_EVERY_MS / 3600000 },
            logs: logs.map(l => ({ at: l.createdAt, tag: l.tag, result: l.result, orderId: l.orderId || '', chatId: l.chatId || '', amount: l.amount, coins: l.coins, note: l.note || '' }))
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.get('/api/admin/wa/admins', requireAdminAuth, async (req, res) => res.json({ success: true, admins: (await waGetAdmins()).map(a => ({ number: a.number, at: a.at })) }));


// ================= ⚡ INSTANT PAYMENT APPROVE (Admin Panel > Payments) =================
// Credits the coins of ONE payment right now, without waiting for the hourly check. The UsedUtr claim inside
// creditPaymentRecord() guarantees the same payment can never be credited twice.
async function notifyPaymentCredited(pay, user) {
    try {
        const key = String(pay.telegramChatId);
        const msg = `✅ **Payment received!**\n+${pay.coins} Coin${pay.coins > 1 ? 's' : ''} added to your account.\n🪙 JPW COIN: **${user.jpwCoins.toFixed(2)}**`;
        if (key.startsWith('wa:')) await waNotify(key, msg);
        else if (!key.startsWith('WEB_') && CUSTOMER_BOT_TOKEN) await new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false }).sendMessage(key, msg, { parse_mode: 'Markdown' }).catch(() => {});
    } catch (e) {}
}
app.post('/api/admin/payments/approve', requireAdminAuth, async (req, res) => {
    try {
        const orderId = String(req.body?.orderId || '').trim();
        if (!orderId) return res.json({ success: false, message: 'Order ID missing.' });
        const pay = await PaymentModel.findOne({ orderId });
        if (!pay) return res.json({ success: false, message: 'Payment record nahi mila.' });
        if (!(pay.coins > 0)) return res.json({ success: false, message: 'Is payment me coins 0 hain - approve nahi ho sakta.' });
        if (await UsedUtrModel.exists({ utrId: orderId })) return res.json({ success: false, message: 'Ye payment pehle hi approve / credit ho chuka hai.' });
        const prevStatus = pay.status;
        pay.status = 'SUCCESS'; await pay.save();
        const user = await creditPaymentRecord(pay);
        if (!user) {
            pay.status = prevStatus; await pay.save().catch(() => {});
            return res.json({ success: false, message: 'Coins add nahi hue: customer nahi mila ya payment pehle se credit hai.' });
        }
        rlog('admin approve', { orderId, chatId: String(pay.telegramChatId), amount: pay.amount, coins: pay.coins, result: 'RECOVERED', note: `Admin ne instant approve kiya (pehle status: ${prevStatus}). ${pay.coins} coin(s) add hue.` });
        debugLog('Admin', `Instant approve: ${orderId} (${pay.coins} coins) -> ${pay.telegramChatId}`);
        notifyPaymentCredited(pay, user);
        res.json({ success: true, message: `✅ Approved: ${pay.coins} coin(s) customer ke account me add ho gaye.`, coins: user.jpwCoins });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ================= 📊 GOOGLE SHEET SETTING (Admin Panel > Connections) =================
const maskUrl = (u) => { u = String(u || ''); return u.length > 40 ? u.slice(0, 28) + '…' + u.slice(-10) : u; };
app.get('/api/admin/sheet-settings', requireAdminAuth, async (req, res) => {
    const panel = await getSettingValue('google_sheet_script_url');
    const env = process.env.GOOGLE_SHEET_SCRIPT_URL || '';
    res.json({ success: true, set: !!(panel || env), source: panel ? 'panel' : (env ? 'env' : 'none'), preview: maskUrl(panel || env) });
});
app.post('/api/admin/sheet-settings', requireAdminAuth, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (url) {
        let u; try { u = new URL(url); } catch (e) { return res.json({ success: false, message: 'URL sahi nahi hai. Poora link daaliye (https://script.google.com/macros/s/.../exec).' }); }
        if (u.protocol !== 'https:') return res.json({ success: false, message: 'Sirf https:// link chalega.' });
    }
    await setSettingValue('google_sheet_script_url', url);
    sheetUrlFromPanel = url;
    debugLog('Sheet', url ? 'Google Sheet URL updated from Admin Panel.' : 'Google Sheet URL cleared from Admin Panel (environment variable is used if present).');
    res.json({ success: true, message: url ? '✅ Google Sheet URL save ho gaya. Ab se naye logs isi sheet me jayenge.' : 'Panel wala URL hata diya gaya.' });
});
app.post('/api/admin/sheet-settings/test', requireAdminAuth, (req, res) => {
    if (!getSheetScriptUrl()) return res.json({ success: false, message: 'Pehle Google Sheet URL save karein.' });
    sendLogToGoogleSheet({ logType: 'TEST', type: 'ADMIN_TEST', details: 'Test row from Admin Panel', status: 'OK', at: new Date().toISOString() }, (err, code, body) => {
        if (err) return res.json({ success: false, message: 'Sheet tak nahi pahunch paya: ' + err.message });
        res.json({ success: code >= 200 && code < 400, message: code >= 200 && code < 400 ? `✅ Test row bhej di gayi (HTTP ${code}). Sheet me check karein.` : `Sheet ne HTTP ${code} diya. URL / deployment check karein.` });
    });
});

// ================= 📜 COMPLETE SERVER LOG (Admin Panel > Logs) =================
app.get('/api/admin/server-log/full', requireAdminAuth, (req, res) => {
    const n = Math.min(Math.max(parseInt(req.query.lines, 10) || 500, 20), 5000);
    res.json({ success: true, log: getAllLogs(n, req.query.level === 'error' ? 'error' : ''), uptimeSec: Math.round(process.uptime()) });
});
app.get('/api/admin/server-log/download', requireAdminAuth, (req, res) => {
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="server-log-${istDayRange().label}.txt"`, 'Cache-Control': 'no-store' });
    res.send(getAllLogs(5000));
});

// ================= 📥 CUSTOMER DATA EXCEL (Admin Panel > Customer page) =================
// mode=total -> everything since the customer's ID was created (+ a day-wise sheet)
// mode=daily&date=YYYY-MM-DD -> that one IST day (12:00 AM to 11:59 PM)
const fmtIst = (d) => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '';
const istDayKey = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);
const isCancelledStatus = (st) => st === 'Rejected' || String(st || '').includes('Cancelled');
const isPendingStatus = (st) => ['Pending', 'Accepted', 'In Progress'].includes(st);
app.get('/api/admin/customer/:id/export', requireAdminAuth, async (req, res) => {
    try {
        const user = await findCustomerByAnyId(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Customer not found.' });
        const chat = user.telegramChatId;
        const daily = req.query.mode === 'daily';
        const range = daily ? istDayRange(req.query.date) : null;
        const timeFilter = daily ? { createdAt: { $gte: range.start, $lt: range.end } } : {};
        const [orders, calls, pays] = await Promise.all([
            OrderModel.find({ telegramChatId: chat, isTest: { $ne: true }, ...timeFilter }).sort({ createdAt: 1 }).lean(),
            CallCompleteModel.find({ telegramChatId: chat, ...timeFilter }).sort({ createdAt: 1 }).lean(),
            PaymentModel.find({ telegramChatId: chat, ...timeFilter }).sort({ createdAt: 1 }).lean()
        ]);
        const credited = new Set((await UsedUtrModel.find({ utrId: { $in: pays.map(p => p.orderId) } }).select('utrId').lean()).map(x => x.utrId));
        const approved = orders.filter(o => o.status === 'Completed').length;
        const cancelled = orders.filter(o => isCancelledStatus(o.status)).length;
        const pending = orders.filter(o => isPendingStatus(o.status)).length;
        const paidPays = pays.filter(p => /^(SUCCESS|PAID|COMPLETED)$/i.test(p.status));
        const periodLabel = daily ? `${range.label} (12:00 AM - 11:59 PM IST)` : `Since ID created (${fmtIst(user.createdAt)}) till now`;

        const summary = [
            ['Detail', 'Value'],
            ['Report type', daily ? 'DAILY' : 'TOTAL (full history)'],
            ['Period', periodLabel],
            ['Downloaded at (IST)', fmtIst(new Date())],
            ['Customer name', user.name || ''],
            ['Login ID', user.customId || ''],
            ['Chat ID', String(chat)],
            ['Channel', custChannel(user)],
            ['ID created on (IST)', fmtIst(user.createdAt)],
            ['Current coins', Number(user.jpwCoins || 0)],
            ['', ''],
            ['Total orders', orders.length],
            ['Approved / Completed', approved],
            ['Cancelled / Rejected', cancelled],
            ['Pending / In progress', pending],
            ['Other status', orders.length - approved - cancelled - pending],
            ['Call-complete requests', calls.length],
            ['Payment requests', pays.length],
            ['Paid payments', paidPays.length],
            ['Paid amount (Rs)', paidPays.reduce((n, p) => n + (p.amount || 0), 0)],
            ['Coins bought (paid)', paidPays.reduce((n, p) => n + (p.coins || 0), 0)]
        ];
        const orderRows = [['#', 'Order time (IST)', 'Tech ID', 'Work order ID', 'Status', 'Message sent to customer', 'Last update (IST)', 'Priority']]
            .concat(orders.map((o, i) => [i + 1, fmtIst(o.createdAt), o.targetId || '', o.workOrderId || '', o.status || '', o.adminReply || '', fmtIst(o.updatedAt || o.createdAt), o.isPriority ? 'Yes' : '']));
        const payRows = [['#', 'Time (IST)', 'Order ID', 'Amount (Rs)', 'Coins', 'Status', 'Coins credited']]
            .concat(pays.map((p, i) => [i + 1, fmtIst(p.createdAt), p.orderId, Number(p.amount || 0), Number(p.coins || 0), p.status, credited.has(p.orderId) ? 'Yes' : 'No']));
        const callRows = [['#', 'Time (IST)', 'Tech ID', 'Work order ID', 'Engineer mobile', 'Call type', 'Coin cost', 'Status']]
            .concat(calls.map((c, i) => [i + 1, fmtIst(c.createdAt), c.targetId || '', c.workOrderId || '', c.engineerMobile || '', c.callType, Number(c.coinCost || 0), c.status]));

        const sheets = [
            { name: 'Summary', rows: summary, widths: [28, 48], boldFirstCol: true },
            { name: 'Orders', rows: orderRows, widths: [6, 24, 16, 18, 20, 70, 24, 10], freezeHeader: true },
            { name: 'Payments', rows: payRows, widths: [6, 24, 30, 12, 8, 14, 14], freezeHeader: true },
            { name: 'Call Complete', rows: callRows, widths: [6, 24, 16, 18, 16, 14, 10, 14], freezeHeader: true }
        ];
        if (!daily) {
            const days = {};
            const day = (k) => (days[k] = days[k] || { ordered: 0, approved: 0, cancelled: 0, pending: 0, paidAmt: 0, coins: 0 });
            orders.forEach(o => { const d = day(istDayKey(o.createdAt)); d.ordered++; if (o.status === 'Completed') d.approved++; else if (isCancelledStatus(o.status)) d.cancelled++; else if (isPendingStatus(o.status)) d.pending++; });
            paidPays.forEach(p => { const d = day(istDayKey(p.createdAt)); d.paidAmt += p.amount || 0; d.coins += p.coins || 0; });
            const dayRows = [['Date (IST)', 'Ordered', 'Approved', 'Cancelled', 'Pending', 'Paid amount (Rs)', 'Coins bought']]
                .concat(Object.keys(days).sort().map(k => [k, days[k].ordered, days[k].approved, days[k].cancelled, days[k].pending, days[k].paidAmt, days[k].coins]));
            sheets.splice(1, 0, { name: 'Day-wise', rows: dayRows, widths: [14, 10, 10, 10, 10, 18, 14], freezeHeader: true });
        }
        const safe = String(user.customId || user.name || chat).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 30) || 'customer';
        const fname = `${safe}_${daily ? 'daily_' + range.label : 'total_' + istDayRange().label}.xlsx`;
        res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fname}"`, 'Cache-Control': 'no-store' });
        res.send(buildXlsx(sheets));
        debugLog('Admin', `Customer data Excel downloaded (${daily ? 'daily ' + range.label : 'total'}) for ${user.customId || chat}`);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// ================= 🎁 OFFERS =================
const OFFER_IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
function sniffImageMime(buf) {
    if (buf.length > 12 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
    if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    return '';
}
function parseOfferTimes(startRaw, endRaw) {
    const one = (v, label) => { if (!v) return null; const d = new Date(v); if (isNaN(d.getTime())) throw new Error(label + ' ki tareekh sahi nahi hai.'); return d; };
    const startAt = one(startRaw, 'Start'), endAt = one(endRaw, 'End');
    if (endAt && endAt <= new Date()) throw new Error('End time guzar chuka hai - aage ka time chuniye.');
    if (startAt && endAt && endAt <= startAt) throw new Error('End time, start time ke baad ka hona chahiye.');
    return { startAt, endAt };
}
function cleanOfferPackages(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('Kam se kam ek amount / coins wala package daaliye.');
    if (list.length > 20) throw new Error('Ek offer me maximum 20 packages ho sakte hain.');
    const seen = new Set();
    return list.map((x, i) => {
        const amount = Number(x && x.amount), coins = Number(x && x.coins);
        if (!Number.isInteger(amount) || amount < 1 || amount > 100000) throw new Error(`Package ${i + 1}: amount 1 se 100000 ke beech poora number hona chahiye.`);
        if (!isFinite(coins) || coins <= 0 || coins > 100000) throw new Error(`Package ${i + 1}: coins 0 se bade hone chahiye.`);
        const key = amount + '|' + coins;
        if (seen.has(key)) throw new Error(`Package ${i + 1}: ₹${amount} / ${coins} coins do baar likha hai.`);
        seen.add(key);
        return { amount, coins: Math.round(coins * 100) / 100 };
    });
}
function offerStatus(o, now = new Date()) {
    if (o.active === false) return 'hidden';
    if (o.startAt && new Date(o.startAt) > now) return 'upcoming';
    if (o.endAt && new Date(o.endAt) <= now) return 'ended';
    return 'live';
}
const offerPublic = (o) => ({ id: String(o._id), name: o.name, text: o.text || '', packages: o.packages || [], startAt: o.startAt || null, endAt: o.endAt || null, status: offerStatus(o), hasImage: !!o.imageSize, imageUrl: o.imageSize ? `/api/offers/${o._id}/image?v=${o.imageSize}` : '', popup: o.popup !== false, createdAt: o.createdAt });

// public: live offers for the web portal (popup + Offers section)
app.get('/api/offers', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const now = new Date();
        const list = await OfferModel.find({ active: true, $or: [{ endAt: null }, { endAt: { $gt: now } }] }).sort({ createdAt: -1 }).limit(10).lean();
        res.json({ success: true, now: now.toISOString(), offers: list.map(offerPublic) });
    } catch (e) { res.json({ success: true, offers: [] }); }
});
app.get('/api/offers/:id/image', async (req, res) => {
    try {
        if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).end();
        const o = await OfferModel.findById(req.params.id).select('+imageData imageMime');
        if (!o || !o.imageData) return res.status(404).end();
        res.set({ 'Content-Type': o.imageMime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.send(Buffer.from(o.imageData));
    } catch (e) { res.status(404).end(); }
});

// ---- sending to everyone (background, one offer at a time) ----
const offerStop = new Set();
let offerSendChain = Promise.resolve();
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
function offerMessage(o, forWa) {
    const lines = (o.packages || []).map(p => `• ₹${p.amount} → ${p.coins} Coin${p.coins > 1 ? 's' : ''}`).join('\n');
    const how = forWa ? 'Kharidne ke liye yahan "pay" likhein aur package ka number bhejein.' : 'Neeche ke button se portal kholkar kharidein.';
    const when = (o.startAt ? `📅 Starts: ${fmtOfferIst(o.startAt)}\n` : '') + (o.endAt ? `⏳ Ends: ${fmtOfferIst(o.endAt)}\n` : '');
    return `🎁 ${o.name}\n\n${o.text ? o.text + '\n\n' : ''}💰 Offer packages:\n${lines}\n\n${when ? when + '\n' : ''}👉 ${how}`;
}
async function deliverOffer(offerId, mode) {
    const o = await OfferModel.findById(offerId).select('+imageData');
    if (!o) return;
    const D = o.delivery || {};
    const wantTg = !!D.telegram, wantWa = !!D.whatsapp;
    const img = o.imageData && o.imageData.length ? Buffer.from(o.imageData) : null;
    const ext = OFFER_IMG_TYPES[o.imageMime] || 'jpg';
    const tokens = [...new Set([CUSTOMER_BOT_TOKEN, process.env.BOT_TOKEN].filter(Boolean))];
    const bots = tokens.map(t => ({ bot: new TelegramBot(t, { polling: false }), fileId: null }));
    const portalUrl = publicBase();
    let users = await UserModel.find({}).select('telegramChatId').lean();
    users = users.filter(u => { const k = String(u.telegramChatId); if (k.startsWith('WEB_')) return false; if (k.startsWith('wa:')) return wantWa; return wantTg; });
    let skip = new Set();
    if (mode !== 'all') skip = new Set((await OfferSendModel.find({ offerId: String(o._id) }).select('chatKey').lean()).map(x => x.chatKey));
    else await OfferSendModel.deleteMany({ offerId: String(o._id) });
    const todo = users.filter(u => !skip.has(String(u.telegramChatId)));
    const st = { tgSent: mode === 'all' ? 0 : (D.tgSent || 0), tgFailed: 0, waSent: mode === 'all' ? 0 : (D.waSent || 0), waFailed: 0 };
    await OfferModel.updateOne({ _id: o._id }, { $set: { 'delivery.status': 'sending', 'delivery.total': todo.length, 'delivery.tgSent': st.tgSent, 'delivery.tgFailed': 0, 'delivery.waSent': st.waSent, 'delivery.waFailed': 0, 'delivery.startedAt': new Date(), 'delivery.finishedAt': null, 'delivery.note': '' } });
    debugLog('Offer', `"${o.name}": sending to ${todo.length} customer(s) (Telegram ${wantTg ? 'ON' : 'off'}, WhatsApp ${wantWa ? 'ON' : 'off'})`);
    const tgText = offerMessage(o, false), waText = offerMessage(o, true);
    const tgKeyboard = { inline_keyboard: [[{ text: '🛒 Open Portal & Buy', web_app: { url: portalUrl } }]] };
    let n = 0, stopped = false, note = '';
    for (const u of todo) {
        if (offerStop.has(String(o._id))) { stopped = true; break; }
        const key = String(u.telegramChatId);
        let ok = false;
        if (key.startsWith('wa:')) {
            try {
                if (!wa.isConnected()) throw new Error('WhatsApp connected nahi hai');
                const from = key.replace(/^wa:/, '');
                const chat = await WaChat.findById(from).lean();
                const jid = (chat && chat.jid) || `${from}@s.whatsapp.net`;
                if (img) await wa.sendImage(jid, img, waText); else await wa.reply(jid, waText);
                ok = true; st.waSent++;
            } catch (e) { st.waFailed++; if (/connected/i.test(e.message)) note = 'WhatsApp connected nahi tha - kuch WhatsApp users ko nahi gaya.'; }
            await sleepMs(2500 + Math.floor(Math.random() * 2500));      // WhatsApp: slow and human-like, to protect the number from a ban
        } else {
            for (const b of bots) {
                for (let attempt = 0; attempt < 2 && !ok; attempt++) {
                    try {
                        const long = tgText.length > 1000;
                        if (img) {
                            const media = b.fileId || img;
                            const m = await b.bot.sendPhoto(key, media, { caption: long ? ('🎁 ' + o.name) : tgText, reply_markup: long ? undefined : tgKeyboard }, { filename: `offer.${ext}`, contentType: o.imageMime || 'image/jpeg' });
                            if (!b.fileId && m && m.photo && m.photo.length) b.fileId = m.photo[m.photo.length - 1].file_id;
                            if (long) await b.bot.sendMessage(key, tgText, { reply_markup: tgKeyboard });
                        } else await b.bot.sendMessage(key, tgText, { reply_markup: tgKeyboard });
                        ok = true; st.tgSent++;
                    } catch (e) {
                        const wait = e && e.response && e.response.body && e.response.body.parameters && e.response.body.parameters.retry_after;
                        if (wait && attempt === 0) { await sleepMs((wait + 1) * 1000); continue; }
                        break;
                    }
                }
                if (ok) break;
            }
            if (!ok) st.tgFailed++;
            await sleepMs(70);
        }
        if (ok) await OfferSendModel.updateOne({ offerId: String(o._id), chatKey: key }, { $setOnInsert: { offerId: String(o._id), chatKey: key } }, { upsert: true }).catch(() => {});
        n++;
        if (n % 15 === 0) await OfferModel.updateOne({ _id: o._id }, { $set: { 'delivery.tgSent': st.tgSent, 'delivery.tgFailed': st.tgFailed, 'delivery.waSent': st.waSent, 'delivery.waFailed': st.waFailed } }).catch(() => {});
    }
    offerStop.delete(String(o._id));
    await OfferModel.updateOne({ _id: o._id }, { $set: { 'delivery.status': stopped ? 'stopped' : 'done', 'delivery.tgSent': st.tgSent, 'delivery.tgFailed': st.tgFailed, 'delivery.waSent': st.waSent, 'delivery.waFailed': st.waFailed, 'delivery.finishedAt': new Date(), 'delivery.note': note } }).catch(() => {});
    debugLog('Offer', `"${o.name}": ${stopped ? 'stopped' : 'finished'} - Telegram ${st.tgSent} ok / ${st.tgFailed} failed, WhatsApp ${st.waSent} ok / ${st.waFailed} failed`);
}
function queueOfferDelivery(offerId, mode) {
    offerSendChain = offerSendChain.then(() => deliverOffer(offerId, mode)).catch(e => debugLog('Offer', 'delivery failed:', e.message));
}

// ---- admin ----
app.get('/api/admin/offers', requireAdminAuth, async (req, res) => {
    try {
        const list = await OfferModel.find({}).sort({ createdAt: -1 }).limit(100).lean();
        res.json({ success: true, maxImageKb: MAX_OFFER_IMAGE_KB, offers: list.map(o => ({ ...offerPublic(o), active: o.active !== false, delivery: o.delivery || {} })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/api/admin/offers', requireAdminAuth, async (req, res) => {
    try {
        const b = req.body || {};
        const name = String(b.name || '').trim().slice(0, 80);
        if (!name) return res.json({ success: false, message: 'Offer ka naam likhiye.' });
        const text = String(b.text || '').trim().slice(0, 1500);
        const packages = cleanOfferPackages(b.packages);
        let imageData, imageMime = '';
        if (b.imageBase64) {
            imageData = Buffer.from(String(b.imageBase64).replace(/^data:[^,]*,/, ''), 'base64');
            if (imageData.length > MAX_OFFER_IMAGE_KB * 1024) return res.json({ success: false, message: `Image bahut badi hai. Maximum ${MAX_OFFER_IMAGE_KB} KB (1 MB) allowed hai.` });
            imageMime = sniffImageMime(imageData);
            if (!imageMime) return res.json({ success: false, message: 'Sirf JPG, PNG ya WEBP image chalegi.' });
        }
        const { startAt, endAt } = parseOfferTimes(b.startAt, b.endAt);
        const sendTg = b.sendTelegram !== false, sendWa = b.sendWhatsapp !== false;
        const offer = await OfferModel.create({
            name, text, packages, popup: b.popup !== false, startAt, endAt,
            ...(imageData ? { imageData, imageMime, imageSize: imageData.length } : {}),
            delivery: { status: (sendTg || sendWa) ? 'sending' : 'idle', telegram: sendTg, whatsapp: sendWa }
        });
        debugLog('Admin', `Offer created: "${name}" (${packages.length} package(s), image: ${imageData ? Math.round(imageData.length / 1024) + ' KB' : 'no'})`);
        if (sendTg || sendWa) queueOfferDelivery(offer._id, 'all');
        res.json({ success: true, message: (sendTg || sendWa) ? '✅ Offer ban gaya. Sabko bhejna shuru ho gaya - neeche progress dikhega.' : '✅ Offer ban gaya (sirf web portal par dikhega).', id: String(offer._id) });
    } catch (e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/admin/offers/toggle', requireAdminAuth, async (req, res) => {
    try {
        const o = await OfferModel.findByIdAndUpdate(req.body?.id, { $set: { active: !!req.body?.active } }, { new: true }).select('name active');
        if (!o) return res.json({ success: false, message: 'Offer nahi mila.' });
        res.json({ success: true, message: o.active ? 'Offer portal par live hai.' : 'Offer chhupa diya - ab koi kharid nahi sakta.' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/admin/offers/resend', requireAdminAuth, async (req, res) => {
    try {
        const o = await OfferModel.findById(req.body?.id).select('delivery name');
        if (!o) return res.json({ success: false, message: 'Offer nahi mila.' });
        if (o.delivery && o.delivery.status === 'sending') return res.json({ success: false, message: 'Abhi bhej raha hai - poora hone dein.' });
        const tg = req.body?.telegram !== false, waOn = req.body?.whatsapp !== false;
        await OfferModel.updateOne({ _id: o._id }, { $set: { 'delivery.telegram': tg, 'delivery.whatsapp': waOn, 'delivery.status': 'sending' } });
        queueOfferDelivery(o._id, req.body?.mode === 'all' ? 'all' : 'remaining');
        res.json({ success: true, message: req.body?.mode === 'all' ? 'Sabko dobara bhejna shuru.' : 'Jinko nahi gaya unhe bhejna shuru.' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/admin/offers/schedule', requireAdminAuth, async (req, res) => {
    try {
        const { startAt, endAt } = parseOfferTimes(req.body?.startAt, req.body?.endAt);
        const o = await OfferModel.findByIdAndUpdate(req.body?.id, { $set: { startAt, endAt } }, { new: true }).select('name');
        if (!o) return res.json({ success: false, message: 'Offer nahi mila.' });
        res.json({ success: true, message: 'Offer ka time badal diya. (Customers ko naya time alag se nahi bheja jaata - chahein to "Send to all again" dabayein.)' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/admin/offers/stop', requireAdminAuth, (req, res) => {
    if (req.body?.id) offerStop.add(String(req.body.id));
    res.json({ success: true, message: 'Bhejna rok rahe hain...' });
});
app.post('/api/admin/offers/delete', requireAdminAuth, async (req, res) => {
    try {
        const id = String(req.body?.id || '');
        offerStop.add(id);
        await OfferModel.findByIdAndDelete(id);
        await OfferSendModel.deleteMany({ offerId: id });
        res.json({ success: true, message: 'Offer delete ho gaya.' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});


function initAllBots() {
    if (CUSTOMER_BOT_TOKEN) startCustomerBot(CUSTOMER_BOT_TOKEN);
    if (ADMIN_BOT_TOKEN) startAdminBot(ADMIN_BOT_TOKEN);
}

function startAdminBot(token) {
    try {
        const bot = new TelegramBot(token, { polling: true });
        bot.on('polling_error', (err) => {
            // 409 Conflict just means another instance is polling with the same token — expected during redeploys
            if (err.code !== 'ETELEGRAM' || !err.message.includes('409 Conflict')) {
                debugLog('AdminBot', 'Polling error:', err.message);
            }
        });
    } catch (e) {
        debugLog('AdminBot', 'Failed to start:', e.message);
    }
}

function startCustomerBot(token) {
    try {
        const bot = new TelegramBot(token, { polling: true });
        bot.on('polling_error', (err) => {
            if (err.code !== 'ETELEGRAM' || !err.message.includes('409 Conflict')) {
                console.error('Polling error:', err.message);
            }
        });
        bot.on('message', async (msg) => {
            if (!msg || !msg.chat || !msg.text) return;
            const chatId = String(msg.chat.id);
            if (chatId === ADMIN_CHAT_ID) return;
            if (maintenance.enabled) { bot.sendMessage(chatId, maintMessage()).catch(() => {}); return; }
            const text = msg.text.trim();
            const portalUrl = publicBase();
            if (text.startsWith('/start') || text.toLowerCase() === 'menu') {
                let user = await UserModel.findOne({ telegramChatId: chatId });
                if (!user) { 
                    const uniqueCode = await generateUniqueReferralCode();
                    user = await UserModel.create({ telegramChatId: chatId, name: msg.from.first_name || 'Engineer', jpwCoins: 0, referralCode: uniqueCode }); 
                    
                    sendLogToGoogleSheet({
                        logType: 'PAYMENT',
                        actionType: 'REGISTER',
                        identifier: chatId,
                        subDetails: `Name: ${msg.from.first_name || 'Engineer'}, Code:${uniqueCode}`,
                        amountOrCoins: '0 Coins',
                        utrId: 'TELEGRAM_START'
                    });
                }
                if (!user.referralCode) {
                    user.referralCode = await generateUniqueReferralCode();
                    await user.save();
                }
                const keyboard = { reply_markup: { inline_keyboard: [
                    [{ text: "🚀 Open Mini App Portal", web_app: { url: portalUrl } }],
                    [{ text: "⚡ Regular Reach Service", callback_data: "bot_menu_reach" }, { text: "📞 Call Complete (Coming Soon)", callback_data: "bot_menu_call" }],
                    [{ text: "🪙 Check Balance", callback_data: "bot_menu_balance" }, { text: "🎁 Daily Bonus", callback_data: "bot_menu_bonus" }],
                    [{ text: "📦 Buy Coins Packages", callback_data: "bot_menu_packages" }, { text: "💬 WhatsApp Support", url: "https://wa.me/919382856020" }]
                ]}};
                await bot.sendMessage(chatId, `✨ **Welcome to JPW Engineer Portal!** 🚀\n\n🆔 Chat ID: \`${chatId}\`\n🪙 Coins: *${user.jpwCoins.toFixed(2)}*`, { parse_mode: 'Markdown', ...keyboard });
            }
        });
        bot.on('callback_query', async (query) => {
            const chatId = String(query.message.chat.id);
            if (chatId === ADMIN_CHAT_ID) return;
            if (maintenance.enabled) { bot.answerCallbackQuery(query.id, { text: '🛠️ System is in Maintenance Mode. Please try again later.', show_alert: true }).catch(() => {}); return; }
            const data = query.data;
            const portalUrl = publicBase();
            let user = await UserModel.findOne({ telegramChatId: chatId });
            if (data === 'bot_menu_reach' || data === 'bot_menu_packages') {
                bot.answerCallbackQuery(query.id);
                bot.sendMessage(chatId, `🚀 Open Mini App: ${portalUrl}`, { parse_mode: 'Markdown' });
            } else if (data === 'bot_menu_call') {
                bot.answerCallbackQuery(query.id, { text: "⚠️ Call Complete Service is Coming Soon!", show_alert: true });
            } else if (data === 'bot_menu_balance') {
                bot.answerCallbackQuery(query.id);
                bot.sendMessage(chatId, `🪙 Your balance: *${user ? user.jpwCoins.toFixed(2) : 0} Coins*`, { parse_mode: 'Markdown' });
            }
        });
    } catch(e) {}
}

// --- EXTERNAL BOT API ROUTES ---
app.get('/api/external/v1/user-status', requireInternalAuth, async (req, res) => {
    try {
        const { chatId } = req.query;
        if (!chatId) return res.json({ success: false, message: 'Chat ID required' });

        let user = await UserModel.findOne({ telegramChatId: String(chatId) });
        if (!user) {
            const defaultRefCode = await generateUniqueReferralCode();
            user = await UserModel.create({
                telegramChatId: String(chatId),
                name: 'Engineer',
                jpwCoins: 0,
                commissionBalance: 0.00,
                referralCode: defaultRefCode
            });

            sendLogToGoogleSheet({
                logType: 'PAYMENT',
                actionType: 'REGISTER',
                identifier: String(chatId),
                subDetails: `Name: Engineer, Code: ${defaultRefCode}`,
                amountOrCoins: '0 Coins',
                utrId: 'API_REGISTER'
            });
        }
        if (!user.referralCode) {
            user.referralCode = await generateUniqueReferralCode();
            await user.save();
        }

        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/external/v1/register-referral', requireInternalAuth, async (req, res) => {
    try {
        let { telegramChatId, name, referralCode } = req.body;
        if (!telegramChatId) return res.json({ success: false, message: 'Chat ID required' });

        telegramChatId = String(telegramChatId).trim();
        let user = await UserModel.findOne({ telegramChatId });
        const myGeneratedCode = await generateUniqueReferralCode();
        const formattedRefName = `REF_${telegramChatId}`;

        if (!user) {
            user = await UserModel.create({
                telegramChatId: telegramChatId,
                name: formattedRefName,
                jpwCoins: 0,
                commissionBalance: 0.00,
                referralCode: myGeneratedCode
            });
        }

        if (user.referralCode === referralCode) {
            return res.json({ success: false, message: 'आप खुद का रेफरल कोड इस्तेमाल नहीं कर सकते।' });
        }

        if (user.referredBy && user.referredBy !== 'ADMIN_DIRECT') {
            return res.json({ success: false, message: 'आप पहले ही किसी के रेफरल से जुड़ चुके हैं।' });
        }

        if (referralCode && referralCode !== 'ADMIN_DIRECT') {
            const referrer = await UserModel.findOne({ referralCode });
            if (referrer) {
                if (referrer.telegramChatId === telegramChatId) {
                    return res.json({ success: false, message: 'आप खुद को रेफर नहीं कर सकते।' });
                }

                user.referredBy = referralCode;
                await user.save();
                
                referrer.totalReferrals = (referrer.totalReferrals || 0) + 1;
                await referrer.save();
                return res.json({ success: true, message: 'Referral registered successfully!' });
            } else {
                return res.json({ success: false, message: 'अमान्य रेफरल कोड।' });
            }
        }

        res.json({ success: false, message: 'Invalid code.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/external/v1/packages', (req, res) => {
    res.json({ success: true, packages: BOT_RECHARGE_PACKAGES });
});

app.post('/api/external/v1/approve-payment', requireInternalAuth, async (req, res) => {
    try {
        const { telegramChatId, coins } = req.body;
        let user = await UserModel.findOne({ telegramChatId: String(telegramChatId) });
        if (!user) return res.json({ success: false, message: 'User not found' });

        // Daily Bonus coins do NOT count as an active plan — only unused package coins do
        if (packageCoinsOf(user) >= 1) {
            return res.json({ success: false, message: '⚠️ Active plan exists! You cannot purchase until existing package coins are consumed.' });
        }

        const expiryDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
        user.jpwCoins = round2(user.jpwCoins + parseFloat(coins));
        user.lastPackageCoins = parseFloat(coins);
        user.packageExpiryTime = expiryDate;
        await user.save();

        sendLogToGoogleSheet({
            logType: 'PAYMENT',
            actionType: 'APPROVE_PAYMENT_BOT',
            identifier: String(telegramChatId),
            subDetails: `Name: ${user.name}`,
            amountOrCoins: `${coins} Coins`,
            utrId: `BOT_APPROVE_${Date.now()}`
        });

        res.json({ success: true, user, message: 'Payment approved & coins added successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/external/v1/update-commission', requireInternalAuth, async (req, res) => {
    try {
        const { telegramChatId, amount, action } = req.body;
        let user = await UserModel.findOne({ telegramChatId: String(telegramChatId) });
        if (!user) return res.json({ success: false, message: 'User not found' });

        const amt = parseFloat(amount) || 0;
        if (action === 'deduct') {
            user.commissionBalance = Math.max(0, (user.commissionBalance || 0) - amt);
        } else if (action === 'refund') {
            user.commissionBalance = (user.commissionBalance || 0) + amt;
        }
        await user.save();

        res.json({ success: true, commissionBalance: user.commissionBalance });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/app', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'mobile_app.html')); });

app.post('/api/admin/login', (req, res) => {
    const key = `adm|${req.ip}`;
    if (isBlocked(key, 10)) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again in 15 minutes.' });
    const { password } = req.body || {};
    if (ADMIN_SECRET_PASS && password && safeEqual(password, ADMIN_SECRET_PASS)) { clearFails(key); res.json({ success: true }); }
    else { addFail(key, 15 * 60 * 1000); res.json({ success: false, message: 'Incorrect password' }); }
});

app.get('/api/admin/data', requireAdminAuth, async (req, res) => {
    try {
        const orders = await OrderModel.find().sort({ createdAt: -1 });
        const callOrders = await CallCompleteModel.find().sort({ createdAt: -1 });
        const users = await UserModel.find().select('-password');
        res.json({ success: true, orders, srOrders: callOrders, users });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ================= 👥 CUSTOMERS (Admin Panel: list, search, one page per customer, edit) =================
const custChannel = (u) => { const k = String(u.telegramChatId || ''); return k.startsWith('wa:') ? 'WhatsApp' : k.startsWith('WEB_') ? 'Web / App' : 'Telegram'; };
const escRx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function findCustomerByAnyId(raw) {
    const id = String(raw || '').trim();
    if (!id) return null;
    if (/^[a-f0-9]{24}$/i.test(id)) { const u = await UserModel.findById(id); if (u) return u; }
    return (await UserModel.findOne({ customId: id })) || (await UserModel.findOne({ telegramChatId: id })) || (await UserModel.findOne({ referralCode: id }));
}

app.get('/api/admin/customers', requireAdminAuth, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 60);
        let filter = {};
        if (q) {
            const rx = new RegExp(escRx(q), 'i');
            const byOrder = await OrderModel.find({ $or: [{ targetId: rx }, { workOrderId: rx }] }).select('telegramChatId').limit(200).lean();
            const chatIds = [...new Set(byOrder.map(o => o.telegramChatId).filter(Boolean))];
            filter = { $or: [{ customId: rx }, { name: rx }, { telegramChatId: rx }, { referralCode: rx }, ...(chatIds.length ? [{ telegramChatId: { $in: chatIds } }] : [])] };
        }
        const users = await UserModel.find(filter).select('-password').sort({ createdAt: -1 }).limit(q ? 100 : 300).lean();
        const keys = users.map(u => u.telegramChatId);
        const agg = await OrderModel.aggregate([
            { $match: { telegramChatId: { $in: keys }, isTest: { $ne: true } } },
            { $group: { _id: '$telegramChatId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } } } }
        ]);
        const cnt = {}; agg.forEach(a => { cnt[a._id] = a; });
        const out = users.map(u => ({
            _id: u._id, name: u.name, customId: u.customId || '', telegramChatId: u.telegramChatId, channel: custChannel(u),
            jpwCoins: u.jpwCoins || 0, commissionBalance: u.commissionBalance || 0, activePackage: u.activePackage || '',
            orders: (cnt[u.telegramChatId] || {}).total || 0, completed: (cnt[u.telegramChatId] || {}).done || 0, createdAt: u.createdAt
        }));
        res.json({ success: true, total: await UserModel.countDocuments(), customers: out });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/customer/:id', requireAdminAuth, async (req, res) => {
    try {
        const user = await findCustomerByAnyId(req.params.id);
        if (!user) return res.json({ success: false, message: 'Customer not found.' });
        const chat = user.telegramChatId;
        const [orders, payments, team, referrer] = await Promise.all([
            OrderModel.find({ telegramChatId: chat }).sort({ createdAt: -1 }).limit(100).lean(),
            PaymentModel.find({ telegramChatId: chat }).sort({ createdAt: -1 }).limit(50).lean(),
            user.referralCode ? UserModel.find({ referredBy: user.referralCode }).select('name customId telegramChatId createdAt').lean() : [],
            user.referredBy && user.referredBy !== 'ADMIN_DIRECT' ? UserModel.findOne({ referralCode: user.referredBy }).select('name customId telegramChatId').lean() : null
        ]);
        // The numbers must cover this customer's WHOLE history. (The order / payment lists above are only the latest rows for display;
        // counting from them is what made this page show 82 while the full total was higher.) Same rule as the customers list: real orders only, no test orders.
        const byStatus = await OrderModel.aggregate([{ $match: { telegramChatId: chat, isTest: { $ne: true } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
        const paidAgg = await PaymentModel.aggregate([{ $match: { telegramChatId: chat, status: { $regex: '^(SUCCESS|PAID|COMPLETED)$', $options: 'i' } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]);
        const stats = { orders: 0, completed: 0, active: 0, rejected: 0, paid: (paidAgg[0] && paidAgg[0].sum) || 0 };
        for (const g of byStatus) {
            stats.orders += g.n;
            if (g._id === 'Completed') stats.completed += g.n;
            else if (['Pending', 'Accepted', 'In Progress'].includes(g._id)) stats.active += g.n;
            else if (g._id === 'Rejected' || String(g._id).includes('Cancelled')) stats.rejected += g.n;
        }
        res.json({ success: true, customer: Object.assign(user.toJSON(), { channel: custChannel(user), hasPassword: !!user.password }), orders, payments, team, referrer, stats });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/customer/update', requireAdminAuth, async (req, res) => {
    try {
        const { userId } = req.body || {};
        const f = (req.body && req.body.fields) || {};
        const user = await UserModel.findById(userId);
        if (!user) return res.json({ success: false, message: 'Customer not found.' });
        const num = (v, label) => { const n = Number(v); if (!isFinite(n) || n < 0) throw new Error(`${label} must be a number (0 or more).`); return round2(n); };
        if (f.name !== undefined) { const n = String(f.name).trim().slice(0, 60); if (!n) throw new Error('Name cannot be empty.'); user.name = n; }
        if (f.jpwCoins !== undefined) user.jpwCoins = num(f.jpwCoins, 'Coins');
        if (f.bonusCoins !== undefined) user.bonusCoins = num(f.bonusCoins, 'Bonus coins');
        if (f.commissionBalance !== undefined) user.commissionBalance = num(f.commissionBalance, 'Commission');
        if (f.lastPackageCoins !== undefined) user.lastPackageCoins = Math.floor(num(f.lastPackageCoins, 'Package coins'));
        if (f.activePackage !== undefined) user.activePackage = String(f.activePackage).trim().slice(0, 80) || 'No active package';
        if (f.packageExpiryTime !== undefined) {
            if (!f.packageExpiryTime) user.packageExpiryTime = null;
            else { const d = new Date(f.packageExpiryTime); if (isNaN(d.getTime())) throw new Error('Package expiry date is not valid.'); user.packageExpiryTime = d; }
        }
        if (f.referredBy !== undefined) user.referredBy = String(f.referredBy).trim() || null;
        if (f.customId !== undefined && user.customId) {
            const cid = String(f.customId).trim();
            if (cid.length < 3 || cid.length > 30) throw new Error('Login ID must be 3-30 characters.');
            if (cid !== user.customId && await UserModel.findOne({ customId: cid })) throw new Error('This login ID is already used by another customer.');
            user.customId = cid;
        }
        if ((user.bonusCoins || 0) > user.jpwCoins) user.bonusCoins = user.jpwCoins;
        await user.save();
        debugLog('Admin', `Customer ${user.customId || user.telegramChatId} edited from panel`);
        res.json({ success: true, message: 'Customer saved.', customer: Object.assign(user.toJSON(), { channel: custChannel(user), hasPassword: !!user.password }) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/admin/update-reaches', requireAdminAuth, async (req, res) => {
    try {
        const { userId, action, count } = req.body;
        let user = await UserModel.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found' });
        if (action === 'add') user.jpwCoins = round2(user.jpwCoins + parseFloat(count));
        else if (action === 'deduct') user.jpwCoins = Math.max(0, round2(user.jpwCoins - parseFloat(count)));
        if ((user.bonusCoins || 0) > user.jpwCoins) user.bonusCoins = user.jpwCoins;
        await user.save();
        res.json({ success: true, user });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/delete-user', requireAdminAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        await UserModel.findByIdAndDelete(userId);
        res.json({ success: true, message: 'User deleted successfully!' });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/change-user-password', requireAdminAuth, async (req, res) => {
    try {
        const userId = String(req.body?.userId || '').trim();
        const newPassword = String(req.body?.newPassword || '').trim();
        if (!userId) return res.json({ success: false, message: 'User is required' });
        if (newPassword.length < 4) return res.json({ success: false, message: 'Password must be at least 4 characters' });
        const user = await UserModel.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found!' });
        // Only ID + Password (web/app) accounts have a password; Telegram accounts log in with OTP
        if (!user.customId) return res.json({ success: false, message: 'This is a Telegram (OTP) account - it has no ID/password login.' });
        user.password = await hashPassword(newPassword);
        await user.save();
        debugLog('Admin', `Password changed for user ${user.customId}`);
        res.json({ success: true, message: `Password updated for ${user.customId}` });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/broadcast', requireAdminAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.json({ success: false, message: 'Message required' });

        await AnnouncementModel.deleteMany({});
        await AnnouncementModel.create({ message });

        const users = await UserModel.find();
        if (CUSTOMER_BOT_TOKEN) {
            const tempBot = new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false });
            for (let u of users) {
                try { await tempBot.sendMessage(u.telegramChatId, `📢 **Announcement:**\n\n${message}`, { parse_mode: 'Markdown' }); } catch(e) {}
            }
        }
        res.json({ success: true, message: 'Broadcast completed' });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/announcement', async (req, res) => {
    try {
        const latest = await AnnouncementModel.findOne().sort({ updatedAt: -1 });
        res.json({ success: true, message: latest ? latest.message : "📌 काम शुरू करने से पहले वर्कआर्डर और मैप ज़रूर खुला रखें।" });
    } catch (err) {
        res.status(500).json({ success: false, message: "System operational." });
    }
});

app.get('/api/service-hours', (req, res) => {
    try {
        res.json({
            success: true,
            enabled: serviceHours.enabled,
            open: serviceHours.open,
            close: serviceHours.close,
            isOpenNow: isServiceOpen(),
            label: serviceHours.enabled ? describeServiceHours() : '24 Hours'
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/service-hours', requireAdminAuth, async (req, res) => {
    try {
        const { open, close } = req.body || {};
        const enabled = req.body?.enabled !== false && req.body?.enabled !== 'false';
        if (!isValidHHMM(open) || !isValidHHMM(close)) {
            return res.json({ success: false, message: 'Time format galat hai. Use HH:MM (e.g. 08:00 and 22:00).' });
        }
        const next = { enabled, open, close };
        await SettingModel.findOneAndUpdate(
            { key: 'service_hours' },
            { value: JSON.stringify(next), updatedAt: new Date() },
            { upsert: true, new: true }
        );
        serviceHours = next;
        debugLog('ServiceHours', `Admin updated: ${enabled ? describeServiceHours() : 'Always open'}`);
        res.json({
            success: true,
            message: enabled ? `✅ Service time saved: ${describeServiceHours()}` : '✅ Time limit OFF — service is open 24 hours.',
            enabled, open, close, isOpenNow: isServiceOpen()
        });
    } catch (err) {
        debugLog('ServiceHours', 'Save failed:', err.message);
        res.status(500).json({ success: false, message: 'Save failed: ' + err.message });
    }
});

app.post('/api/admin/clear-database', requireAdminAuth, async (req, res) => {
    try {
        await OrderModel.deleteMany({});
        await CallCompleteModel.deleteMany({});
        await UsedUtrModel.deleteMany({});
        await AnnouncementModel.deleteMany({});
        await PaymentModel.deleteMany({});
        res.json({ success: true, message: 'Database cleared successfully!' });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/update-order-status', requireAdminAuth, async (req, res) => {
    try {
        const { orderId, status } = req.body;
        let order = await OrderModel.findById(orderId);
        if (!order) return res.json({ success: false, message: 'Order not found!' });

        order.status = status;
        await order.save();

        if (status === 'Rejected' || status.includes('Cancelled')) {
            await refundCoinTo(order.telegramChatId);
        }

        res.json({ success: true, message: 'Order status updated successfully!', order });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    try {
        const regKey = `reg|${req.ip}`;
        if (isBlocked(regKey, 20)) return res.status(429).json({ success: false, message: 'Too many registrations from this network. Try again later.' });
        addFail(regKey, 60 * 60 * 1000);
        let { customId, password, name } = req.body || {};
        customId = String(customId || '').trim();
        password = String(password || '').trim();
        name = String(name || '').trim();
        if (!customId || !password) return res.json({ success: false, message: 'ID and password are required' });
        if (customId.length < 3 || customId.length > 30) return res.json({ success: false, message: 'ID must be 3-30 characters' });
        if (password.length < 4) return res.json({ success: false, message: 'Password must be at least 4 characters' });
        if (await UserModel.findOne({ customId })) {
            return res.json({ success: false, message: 'ID already exists!' });
        }
        // 🔒 hash the password before storing it — never store plaintext passwords
        const hashedPassword = await hashPassword(password);

        // referralCode is unique: retry if the random code is already taken
        let user = null;
        for (let attempt = 0; attempt < 5 && !user; attempt++) {
            const uniqueCode = await generateUniqueReferralCode();
            try {
                user = await UserModel.create({
                    customId,
                    password: hashedPassword,
                    name: name || 'Engineer',
                    telegramChatId: `WEB_${customId}`,
                    jpwCoins: 0,
                    commissionBalance: 0.00,
                    referralCode: uniqueCode
                });
            } catch (e) {
                if (e && e.code === 11000) {
                    if (e.keyPattern && e.keyPattern.referralCode) continue; // try another code
                    return res.json({ success: false, message: 'ID already exists!' });
                }
                throw e;
            }
        }
        if (!user) return res.json({ success: false, message: 'Could not generate a referral code. Please try again.' });

        sendLogToGoogleSheet({
            logType: 'PAYMENT',
            actionType: 'WEB_REGISTER',
            identifier: `WEB_${customId}`,
            subDetails: `Name: ${name || 'Engineer'}`,
            amountOrCoins: '0 Coins',
            utrId: `REG_${customId}`
        });

        const userObj = user.toObject();
        delete userObj.password;
        res.json({ success: true, user: userObj, message: 'Registration successful!' });
    } catch (err) {
        debugLog('Register', 'failed:', err.message);
        res.status(500).json({ success: false, message: 'Registration failed: ' + err.message, error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        let { customId, password } = req.body || {};
        customId = String(customId || '').trim();
        password = String(password || '').trim();
        if (!customId || !password) return res.json({ success: false, message: 'ID and password are required' });
        const loginKey = `login|${req.ip}|${customId.toLowerCase()}`;
        if (isBlocked(loginKey, 10)) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again in 15 minutes.' });
        const user = await UserModel.findOne({ customId });
        let ok = false;
        if (user && user.password) {
            const result = await verifyPassword(password, user.password);
            ok = result.ok;
            if (ok && result.needsUpgrade) {
                user.password = await hashPassword(password);
                await user.save();
            }
        }
        if (ok) {
            clearFails(loginKey);
            const userObj = user.toObject();
            delete userObj.password;
            res.json({ success: true, user: userObj, token: issueToken(user.telegramChatId) });
        } else {
            addFail(loginKey, 15 * 60 * 1000);
            res.json({ success: false, message: 'Invalid ID or Password' });
        }
    } catch (err) {
        debugLog('Login', 'failed:', err.message);
        res.status(500).json({ success: false, message: 'Login failed: ' + err.message, error: err.message });
    }
});

app.post('/api/auth/check-user-type', async (req, res) => {
    try {
        const { identifier } = req.body;
        const user = await UserModel.findOne({ $or: [{ customId: identifier }, { telegramChatId: identifier }] });
        if(user) {
            res.json({ success: true, telegramChatId: user.telegramChatId, authType: user.password ? 'PASSWORD' : 'OTP' });
        } else {
            res.json({ success: false, message: 'User not found!' });
        }
    } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/send-otp', async (req, res) => {
    try {
        let { telegramChatId } = req.body || {};
        telegramChatId = String(telegramChatId || '').trim();
        if (!telegramChatId) return res.json({ success: false, message: 'Chat ID is required' });
        let user = await UserModel.findOne({ telegramChatId });
        if (!user) return res.json({ success: false, message: 'User not registered!' });

        // Accounts created from the web/app form (ID + password) have no real Telegram chat, so no OTP can be sent
        if (telegramChatId.startsWith('WEB_')) {
            return res.json({ success: false, message: 'This account uses ID + Password. Please login from the App page (/app).' });
        }
        if (!CUSTOMER_BOT_TOKEN) return res.json({ success: false, message: 'OTP service is not configured.' });

        const prev = otpStorage[telegramChatId];
        if (prev && prev.sentAt && Date.now() - prev.sentAt < 30 * 1000) {
            return res.json({ success: false, message: 'OTP was just sent. Please wait 30 seconds before requesting again.' });
        }
        const otp = crypto.randomInt(100000, 1000000).toString();
        otpStorage[telegramChatId] = { otp, expires: Date.now() + 5 * 60 * 1000, sentAt: Date.now(), attempts: 0 };

        try {
            const tempBot = new TelegramBot(CUSTOMER_BOT_TOKEN, { polling: false });
            await tempBot.sendMessage(telegramChatId, `🔐 **Portal Login OTP:** \`${otp}\``, { parse_mode: 'Markdown' });
        } catch (sendErr) {
            delete otpStorage[telegramChatId];
            debugLog('OTP', 'Telegram sendMessage failed:', sendErr.message);
            return res.json({ success: false, message: 'Could not send OTP. Please open the Telegram bot, press /start once, and try again.' });
        }
        res.json({ success: true, message: 'OTP sent successfully!' });
    } catch(err) { res.status(500).json({ success: false, message: err.message, error: err.message }); }
});

app.post('/api/verify-otp', async (req, res) => {
    try {
        let { telegramChatId, otp } = req.body;
        telegramChatId = String(telegramChatId).trim();

        // 🔒 SECURITY FIX: OTP is now always required — previously, omitting it skipped verification entirely
        if (!otp) return res.json({ success: false, message: 'OTP is required' });

        const record = otpStorage[telegramChatId];
        if (!record || record.expires < Date.now()) {
            return res.json({ success: false, message: 'Invalid or expired OTP!' });
        }
        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5) {
            delete otpStorage[telegramChatId];
            return res.json({ success: false, message: 'Too many wrong attempts. Please request a new OTP.' });
        }
        if (!safeEqual(record.otp, String(otp).trim())) {
            return res.json({ success: false, message: 'Invalid or expired OTP!' });
        }
        delete otpStorage[telegramChatId];

        let user = await UserModel.findOne({ telegramChatId }).select('-password');
        if (user) res.json({ success: true, user, token: issueToken(telegramChatId) });
        else res.json({ success: false, message: 'User not found!' });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// Read-only user status for the web portal / mini app (the /api/external/v1/* routes need the internal secret,
// which must never be shipped inside browser code).
app.post('/api/user/status', requireUser, async (req, res) => {
    try {
        const telegramChatId = String(req.body?.telegramChatId || '').trim();
        if (!telegramChatId) return res.json({ success: false, message: 'Chat ID required' });
        const user = await UserModel.findOne({ telegramChatId }).select('-password');
        if (!user) return res.json({ success: false, message: 'User not found!' });
        res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/app/check-status', requireUser, async (req, res) => {
    try {
        const { telegramChatId } = req.body;
        if (!telegramChatId) return res.json({ success: false, message: 'Chat ID required' });
        const regularOrders = await OrderModel.find({ telegramChatId: String(telegramChatId) }).select('-targetPass').sort({ createdAt: -1 });
        const callOrders = await CallCompleteModel.find({ telegramChatId: String(telegramChatId) }).select('-targetPass').sort({ createdAt: -1 });
        res.json({ success: true, regularOrders, srOrders: callOrders });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/user/passbook', requireUser, async (req, res) => {
    try {
        const { telegramChatId } = req.body;
        if (!telegramChatId) return res.json({ success: false, statement: [] });

        const orders = await OrderModel.find({ telegramChatId: String(telegramChatId) }).select('-targetPass').sort({ createdAt: -1 });
        let statement = [];

        orders.forEach(o => {
            let type = 'DEBIT';
            let title = 'Reach Order';
            let desc = `Target ID: ${o.targetId}`;
            let status = o.status;
            let statusColor = 'text-amber-400';

            if (status === 'Completed') {
                statusColor = 'text-emerald-400';
            } else if (status === 'Rejected' || status.includes('Cancelled')) {
                type = 'CREDIT';
                title = 'Refund / Cancelled';
                desc = `Refunded for Target ID: ${o.targetId}`;
                statusColor = 'text-rose-400';
            }

            statement.push({ type, title, description: desc, amount: '1.00', status, statusColor, date: new Date(o.createdAt).toLocaleString() });
        });

        res.json({ success: true, statement });
    } catch (err) { res.status(500).json({ success: false, statement: [] }); }
});

app.get('/api/packages', (req, res) => {
    res.json({ success: true, packages: WEB_RECHARGE_PACKAGES });
});

app.post('/api/pay', requireUser, async (req, res) => {
    try {
        const { telegramChatId, amount, coins } = req.body;

        // 🔒 SECURITY FIX: never trust amount/coins from the client — verify against the known package list
        const validPackage = await findValidPackage(amount, coins);
        if (!validPackage) {
            return res.json({ success: false, message: 'Invalid package selected (this offer may have ended).' });
        }

        let user = await UserModel.findOne({ telegramChatId: String(telegramChatId) });
        let orderId = `ORD_${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`; // random suffix: two payments in the same millisecond can no longer clash

        if (user) {
            user.activePackage = `₹${validPackage.amount} (${validPackage.coins} Coins)`;
            user.lastPackageCoins = validPackage.coins;
            await user.save();
        }

        await PaymentModel.create({
            orderId: orderId,
            amount: validPackage.amount,
            coins: validPackage.coins,
            telegramChatId: String(telegramChatId),
            status: 'PENDING'
        });

        // Send /app (ID + password) users back to /app, everyone else to the portal home page
        const returnPath = req.body.source === 'app' ? '/app' : '/';
        const mySuccessUrl = `${publicBase(req)}${returnPath}?payment=success&telegramChatId=${encodeURIComponent(telegramChatId)}&coins=${validPackage.coins}&order_id=${orderId}`;

        const pgResponse = await fetch(PRIVATE_PG_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': PRIVATE_API_KEY
            },
            body: JSON.stringify({
                amount: validPackage.amount,
                orderId: orderId
            })
        });

        const pgData = await pgResponse.json();

        if (pgData.success && pgData.checkoutUrl) {
            const finalCheckoutUrl = `${pgData.checkoutUrl}&redirectUrl=${encodeURIComponent(mySuccessUrl)}`;
            res.json({ success: true, checkoutUrl: finalCheckoutUrl, orderId });
        } else {
            res.json({ success: false, message: pgData.message || 'Payment Gateway Error' });
        }

    } catch(err) { 
        res.status(500).json({ success: false, error: err.message }); 
    }
});

// 🔒 NEW: Payment gateway webhook — this is the only place that should ever
// flip a PaymentModel record from PENDING to SUCCESS. The private payment gateway
// must be configured to call this URL (server-to-server) when a payment completes.
// Protect it with the same PRIVATE_API_KEY used when creating the payment.
app.post('/api/payment-webhook', async (req, res) => {
    try {
        const providedKey = req.headers['x-api-key'];
        if (!providedKey || providedKey !== PRIVATE_API_KEY) {
            return res.status(401).json({ success: false, message: 'Unauthorized webhook call' });
        }

        const { orderId, status } = req.body;
        if (!orderId || !status) return res.status(400).json({ success: false, message: 'orderId and status are required' });

        const paymentRecord = await PaymentModel.findOne({ orderId });
        if (!paymentRecord) return res.status(404).json({ success: false, message: 'Order not found' });

        paymentRecord.status = status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
        await paymentRecord.save();

        res.json({ success: true, message: 'Webhook processed' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/verify-db-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const paymentRecord = await PaymentModel.findOne({ orderId: orderId });
        
        if (!paymentRecord) {
            return res.status(404).json({
                success: false,
                message: 'Order not found in database.'
            });
        }

        if (paymentRecord.status === 'SUCCESS') {
            return res.json({
                success: true,
                status: 'SUCCESS',
                message: 'Payment is marked as SUCCESS in the database.',
                amount: paymentRecord.amount,
                orderId: paymentRecord.orderId,
                paidAt: paymentRecord.createdAt
            });
        } else {
            return res.json({
                success: true,
                status: 'PENDING',
                message: 'Payment is still pending in the database.',
                amount: paymentRecord.amount,
                orderId: paymentRecord.orderId
            });
        }

    } catch (error) {
        console.error('Database Fetch Error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching from database.'
        });
    }
});

// Asks the payment gateway directly whether an order is paid (used when the gateway webhook was missed).
// Gateway base URL is taken from PRIVATE_PG_URL (e.g. https://pg.example.com/api/create-payment).
async function checkGatewayPaymentStatus(orderId) {
    try {
        const base = new URL(PRIVATE_PG_URL).origin;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(`${base}/api/check-status/${encodeURIComponent(orderId)}`, { signal: ctrl.signal });
        clearTimeout(timer);
        const d = await r.json();
        return d && d.success ? { status: d.status, amount: Number(d.amount) } : null;
    } catch (e) {
        debugLog('Payment', `Gateway status check failed for ${orderId}:`, e.message);
        return null;
    }
}

app.post('/api/verify-instant', async (req, res) => {
    try {
        const { telegramChatId, order_id } = req.body;
        let user = await UserModel.findOne({ telegramChatId: String(telegramChatId) });
        if (!user) return res.json({ success: false, message: 'User not found' });

        if (!order_id) return res.json({ success: false, message: 'Order ID required' });
        const transactionId = order_id;

        const existingUtr = await UsedUtrModel.findOne({ utrId: transactionId });
        if (existingUtr) return res.json({ success: false, message: 'Already credited' });

        // 🔒 SECURITY FIX: never trust coins from the client — only credit coins that were
        // recorded server-side when the payment was created, and only if the gateway/db
        // actually marked the payment record as SUCCESS.
        const paymentRecord = await PaymentModel.findOne({ orderId: transactionId, telegramChatId: String(telegramChatId) });
        if (!paymentRecord) return res.json({ success: false, message: 'Payment record not found' });
        if (paymentRecord.status !== 'SUCCESS') {
            // Webhook may have been missed: ask the gateway itself before giving up
            const gw = await checkGatewayPaymentStatus(transactionId);
            if (gw && gw.status === 'SUCCESS' && gw.amount === Number(paymentRecord.amount)) {
                paymentRecord.status = 'SUCCESS';
                await paymentRecord.save();
                debugLog('Payment', `Order ${transactionId} confirmed via gateway status check (webhook was missing).`);
            } else {
                return res.json({ success: false, message: 'Payment not confirmed yet' });
            }
        }

        const coinsToCredit = paymentRecord.coins;
        if (!coinsToCredit || coinsToCredit <= 0) {
            return res.json({ success: false, message: 'Invalid payment record' });
        }

        const expiryDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
        // claim the order first: a second parallel call hits the unique index and stops here (no double credit, no 500)
        try { await UsedUtrModel.create({ utrId: transactionId }); }
        catch (e) { if (e && e.code === 11000) return res.json({ success: false, message: 'Already credited' }); throw e; }
        user = await UserModel.findOneAndUpdate(
            { telegramChatId: String(telegramChatId) },
            { $inc: { jpwCoins: coinsToCredit }, $set: { lastPackageCoins: coinsToCredit, packageExpiryTime: expiryDate } },
            { new: true }
        );

        sendLogToGoogleSheet({
            logType: 'PAYMENT',
            actionType: 'WEB_PAYMENT_SUCCESS',
            identifier: String(telegramChatId),
            subDetails: `Name: ${user.name}`,
            amountOrCoins: `${coinsToCredit} Coins (₹${paymentRecord.amount})`,
            utrId: transactionId
        });

        res.json({ success: true, user });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/claim-daily-bonus', requireUser, async (req, res) => {
    try {
        const telegramChatId = String(req.body?.telegramChatId || '').trim();
        if (!telegramChatId) return res.json({ success: false, message: 'Chat ID required' });
        const exists = await UserModel.exists({ telegramChatId });
        if (!exists) return res.json({ success: false, message: 'User not found!' });

        // Start of "today" in IST, as a UTC Date
        const IST = 5.5 * 60 * 60 * 1000;
        const istMidnight = new Date(Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST);

        const randomBonus = round2(Math.random() * 0.5 + 0.1);
        // Atomic: the filter only matches if the bonus was NOT already claimed today, so double-taps can't pay twice
        const user = await UserModel.findOneAndUpdate(
            { telegramChatId, $or: [{ lastBonusTime: null }, { lastBonusTime: { $lt: istMidnight } }] },
            [{ $set: {
                jpwCoins: { $round: [{ $add: ['$jpwCoins', randomBonus] }, 2] },
                bonusCoins: { $round: [{ $add: [{ $ifNull: ['$bonusCoins', 0] }, randomBonus] }, 2] },
                lastBonusTime: new Date()
            } }],
            { new: true }
        );
        if (!user) return res.json({ success: false, message: 'Already claimed today!' });

        res.json({ success: true, randomBonus, user });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

const orderLocks = new Set();
const ACTIVE_ORDER_STATUSES = ['Pending', 'Accepted', 'In Progress'];
// One Tech ID can run only ONE order in the whole server (any user, selected or normal, any channel).
// The first one to send it wins; later ones are stopped with "Already in server" and nothing is charged.
// The ID is compared ignoring upper/lower case. (Password does not matter - same ID = same order.)
const escapeRegex = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function findRunningOrderForId(targetId) {
    return OrderModel.findOne({ targetId: { $regex: '^' + escapeRegex(String(targetId).trim()) + '$', $options: 'i' }, status: { $in: ACTIVE_ORDER_STATUSES } }).select('_id telegramChatId isTest').lean();
}
const ALREADY_IN_SERVER_MSG = '⚠️ Already in server: an order for this ID is already running. Please wait until it is completed. Nothing was charged for this request.';
// One place that places an order (used by the web/Telegram route below AND by the WhatsApp bot).
// Returns the same object the route sends as JSON: { success, message, remainingCoins }.
async function placeOrder({ telegramChatId, targetId, targetPass, isPriority }) {
    let lockKey = null;
    try {
        if (!isServiceOpen()) return { success: false, message: `⛔ सेवा का समय समाप्त। सेवा का समय: ${describeServiceHours()}` };
        if (!targetId || !targetPass) return { success: false, message: 'Target ID and password are required' };
        const cleanId = String(targetId).trim();
        const cleanPass = String(targetPass).trim();

        // 🔧 FIX: one active order per Tech ID - a new one is allowed only after the previous is Completed/Rejected/Cancelled.
        lockKey = cleanId.toLowerCase();
        if (orderLocks.has(lockKey)) { lockKey = null; return { success: false, message: ALREADY_IN_SERVER_MSG }; }
        orderLocks.add(lockKey);
        const running = await findRunningOrderForId(cleanId);
        if (running) { debugLog('Order', `Duplicate blocked: ${cleanId} is already running (asked by ${telegramChatId}).`); return { success: false, message: ALREADY_IN_SERVER_MSG }; }

        const selInfo = selectedInfo(telegramChatId);
        if (selInfo && selInfo.locked) return { success: false, message: '🔒 Your ID is locked because the daily payment is pending. It opens automatically once the payment is done.' };
        const user = await spendOrFree(telegramChatId);
        if (!user) return { success: false, message: 'Insufficient Coins!' };

        const newOrder = await OrderModel.create({ telegramChatId: String(telegramChatId), targetId: cleanId, targetPass: cleanPass, isPriority: !!isPriority });
        await notifyAdminAndUser(newOrder, `🌐 **New Reach Order**\n🆔 ID: \`${newOrder._id}\`\n🎯 Target: \`${cleanId}\``);

        sendLogToGoogleSheet({
            logType: 'ORDER',
            type: 'REACH_ORDER_SUBMITTED',
            telegramChatId: String(telegramChatId),
            details: `Target ID: ${cleanId}`,
            status: 'Pending'
        });

        const sent = await forwardOrderToTargetBot(cleanId, cleanPass);
        if (!sent) {
            await refundCoinTo(String(telegramChatId));
            newOrder.status = 'Rejected';
            newOrder.adminReply = '❌ Service unreachable. 1 Coin refunded.';
            await newOrder.save();
            if (selInfo) return { success: false, message: '⚠️ Service is not reachable right now. Please try again in a moment.', remainingCoins: user.jpwCoins, selected: true };
            return { success: false, message: '⚠️ Bot unreachable. Coin refunded.', remainingCoins: round2(user.jpwCoins + 1) };
        }
        // 🔧 FIX: the order was handed to the service, so it must not keep showing "Pending".
        // Only set this if no reply has already arrived and moved it further.
        await OrderModel.updateOne({ _id: newOrder._id, status: 'Pending' }, { $set: { status: 'In Progress', adminReply: plainText(buildCustomerMessage('received', { targetId: cleanId })) } });
        return { success: true, message: 'Order submitted!', remainingCoins: user.jpwCoins, selected: !!selInfo };   // selected users never see coins
    } finally { if (lockKey) orderLocks.delete(lockKey); }
}
app.post('/api/order', requireUser, async (req, res) => {
    try {
        const { telegramChatId, targetId, targetPass, isPriority } = req.body;
        res.json(await placeOrder({ telegramChatId, targetId, targetPass, isPriority }));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post(['/api/call-complete-submit', '/api/sr-submit'], async (req, res) => {
    res.json({ success: false, message: '🚧 Call Complete Service is Coming Soon! Orders are currently disabled.' });
});

// Telegram Mini App login (signed initData) - or, for the reseller page, an already logged-in token
app.post('/api/mini-app/auth', async (req, res) => {
    try {
        let telegramChatId = null;
        const initData = String(req.body?.initData || '');
        if (initData) {
            if (!CUSTOMER_BOT_TOKEN) return res.json({ success: false, message: 'Telegram login is not configured.' });
            const tgUser = verifyTelegramInitData(initData, CUSTOMER_BOT_TOKEN);
            if (!tgUser || !tgUser.id) return res.json({ success: false, message: 'Telegram verification failed. Please reopen from the bot.' });
            telegramChatId = String(tgUser.id);
        } else {
            telegramChatId = readToken(tokenFromReq(req));
            if (!telegramChatId) return res.status(401).json({ success: false, authExpired: true, message: 'Session expired. Please login again.' });
        }
        const user = await UserModel.findOne({ telegramChatId }).select('-password');
        if (!user) return res.json({ success: false, message: 'User not found! Press /start in the Telegram bot first.' });
        res.json({ success: true, user, token: issueToken(telegramChatId) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/reseller/orders-status', requireUser, async (req, res) => {
    try {
        const orders = await OrderModel.find({ telegramChatId: String(req.body.telegramChatId) }).select('-targetPass').sort({ createdAt: -1 }).lean();
        const completed = [], inProgress = [], failed = [];
        for (const o of orders) {
            if (o.status === 'Completed') completed.push(o);
            else if (o.status === 'Rejected' || String(o.status).includes('Cancelled')) failed.push(o);
            else inProgress.push(o);
        }
        res.json({ success: true, completed, inProgress, failed });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Coin transfer between users. Package coins are spent first, Daily-Bonus coins last (same rule as orders).
async function spendCoins(telegramChatId, amount) {
    return UserModel.findOneAndUpdate(
        { telegramChatId: String(telegramChatId), jpwCoins: { $gte: amount - 0.0001 } },
        [{ $set: {
            bonusCoins: { $round: [{ $max: [0, { $subtract: [
                { $ifNull: ['$bonusCoins', 0] },
                { $max: [0, { $subtract: [amount, { $subtract: ['$jpwCoins', { $ifNull: ['$bonusCoins', 0] }] }] }] }
            ] }] }, 2] },
            jpwCoins: { $round: [{ $max: [0, { $subtract: ['$jpwCoins', amount] }] }, 2] }
        } }],
        { new: true }
    );
}
app.post('/api/transfer-coins', requireUser, async (req, res) => {
    try {
        const senderChatId = String(req.body?.senderChatId || '').trim();
        const receiverChatId = String(req.body?.receiverChatId || '').trim();
        const amount = round2(parseFloat(req.body?.amount));
        if (!senderChatId || !receiverChatId) return res.json({ success: false, message: 'Sender and receiver are required' });
        if (!Number.isFinite(amount) || amount < 0.01) return res.json({ success: false, message: 'Enter a valid amount' });
        if (senderChatId === receiverChatId) return res.json({ success: false, message: 'You cannot transfer coins to yourself' });
        if (!(await UserModel.exists({ telegramChatId: receiverChatId }))) return res.json({ success: false, message: 'Receiver not found! Check the Chat ID.' });

        const sender = await spendCoins(senderChatId, amount);
        if (!sender) return res.json({ success: false, message: 'Insufficient Coins!' });
        const receiver = await UserModel.findOneAndUpdate({ telegramChatId: receiverChatId }, { $inc: { jpwCoins: amount } }, { new: true });
        if (!receiver) { // receiver deleted in the meantime -> give the coins back
            await UserModel.updateOne({ telegramChatId: senderChatId }, { $inc: { jpwCoins: amount } });
            return res.json({ success: false, message: 'Receiver not found! Coins were not deducted.' });
        }
        sendLogToGoogleSheet({
            logType: 'PAYMENT', actionType: 'COIN_TRANSFER', identifier: senderChatId,
            subDetails: `To: ${receiverChatId}`, amountOrCoins: `${amount} Coins`, utrId: `TRF_${Date.now()}`
        });
        const senderObj = sender.toObject(); delete senderObj.password;
        res.json({ success: true, message: 'Transfer successful', sender: senderObj });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});



// ============================================================
// 🔐 TELEGRAM USERBOT LOGIN (Phone number + OTP) — Admin only
// The generated session string is saved in MongoDB (survives Render restarts)
// and is never sent back to the browser.
// ============================================================
let pendingTgLogin = null; // { client, phone, phoneCodeHash, createdAt }
let lastTgCodeRequestAt = 0;

async function clearPendingTgLogin() {
    if (pendingTgLogin && pendingTgLogin.client) {
        try { await pendingTgLogin.client.disconnect(); } catch (e) {}
    }
    pendingTgLogin = null;
}

function tgErrorMessage(err) {
    const code = err?.errorMessage || err?.message || 'UNKNOWN_ERROR';
    const map = {
        PHONE_NUMBER_INVALID: 'Invalid phone number. Use international format, e.g. +919876543210.',
        PHONE_CODE_INVALID: 'Wrong OTP. Please check and try again.',
        PHONE_CODE_EMPTY: 'Please enter the OTP.',
        PHONE_CODE_EXPIRED: 'OTP expired. Please request a new code.',
        PASSWORD_HASH_INVALID: 'Wrong 2-step verification password.',
        PHONE_NUMBER_BANNED: 'This phone number is banned by Telegram.',
        API_ID_INVALID: 'TELEGRAM_API_ID / TELEGRAM_API_HASH is invalid. Check your environment variables.'
    };
    if (err?.seconds) return `Too many attempts. Telegram says wait ${err.seconds} seconds.`;
    return map[code] || code;
}

app.post('/api/admin/tg-login/send-code', requireAdminAuth, async (req, res) => {
    try {
        const phone = String(req.body?.phone || '').replace(/[\s()-]/g, '');
        if (!/^\+\d{8,15}$/.test(phone)) {
            return res.json({ success: false, message: 'Enter phone in international format, e.g. +919876543210' });
        }
        if (Date.now() - lastTgCodeRequestAt < 30 * 1000) {
            return res.json({ success: false, message: 'Please wait 30 seconds before requesting another code.' });
        }
        lastTgCodeRequestAt = Date.now();

        await clearPendingTgLogin();
        const client = new TelegramClient(new StringSession(''), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 3 });
        await client.connect();
        const result = await client.sendCode({ apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH }, phone);
        pendingTgLogin = { client, phone, phoneCodeHash: result.phoneCodeHash, createdAt: Date.now() };
        debugLog('TgLogin', `OTP requested for ${phone.slice(0, 4)}******`);
        res.json({ success: true, message: 'OTP sent! Check your Telegram app (or SMS).' });
    } catch (err) {
        await clearPendingTgLogin();
        debugLog('TgLogin', 'send-code failed:', err.message);
        res.json({ success: false, message: tgErrorMessage(err) });
    }
});

app.post('/api/admin/tg-login/verify', requireAdminAuth, async (req, res) => {
    try {
        if (!pendingTgLogin || Date.now() - pendingTgLogin.createdAt > 10 * 60 * 1000) {
            await clearPendingTgLogin();
            return res.json({ success: false, message: 'Login session expired. Please request a new OTP.' });
        }
        const code = String(req.body?.code || '').replace(/\D/g, '');
        const password = req.body?.password ? String(req.body.password) : '';
        const { client, phone, phoneCodeHash } = pendingTgLogin;

        let needsPassword = false;
        try {
            const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
            if (result && result.className === 'auth.AuthorizationSignUpRequired') {
                await clearPendingTgLogin();
                return res.json({ success: false, message: 'This number is not registered on Telegram.' });
            }
        } catch (err) {
            if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                needsPassword = true;
            } else {
                if (err?.errorMessage === 'PHONE_CODE_EXPIRED') await clearPendingTgLogin();
                throw err;
            }
        }

        if (needsPassword) {
            if (!password) {
                return res.json({ success: false, needsPassword: true, message: '2-step verification is ON. Enter your Telegram cloud password.' });
            }
            let lastErr = null;
            try {
                await client.signInWithPassword(
                    { apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH },
                    { password: async () => password, onError: async (e) => { lastErr = e; return true; } }
                );
            } catch (e) {
                throw lastErr || e;
            }
        }

        const sessionString = client.session.save();
        await SettingModel.findOneAndUpdate(
            { key: 'tg_session' },
            { value: sessionString, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        await clearPendingTgLogin();
        debugLog('TgLogin', '✅ Telegram login successful. Session saved to database.');

        // Start the userbot bridge with the new session right away (no restart needed)
        if (userbotReconnectTimer) { clearTimeout(userbotReconnectTimer); userbotReconnectTimer = null; }
        userbotReconnectAttempts = 0;
        initUserbotBridge();

        res.json({ success: true, message: '✅ Login successful! Session saved and userbot is starting.' });
    } catch (err) {
        debugLog('TgLogin', 'verify failed:', err.message);
        res.json({ success: false, message: tgErrorMessage(err) });
    }
});

app.get('/api/admin/tg-login/status', requireAdminAuth, async (req, res) => {
    let account = null;
    if (userbotClient && userbotClient.connected) {
        try {
            const me = await userbotClient.getMe();
            account = { name: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username || '', phone: me.phone ? `+${String(me.phone).slice(0, 2)}******${String(me.phone).slice(-2)}` : '' };
        } catch (e) {}
    }
    res.json({
        success: true,
        connected: !!(userbotClient && userbotClient.connected),
        source: userbotSessionSource,
        awaitingOtp: !!pendingTgLogin,
        account
    });
});

app.post('/api/admin/tg-login/logout', requireAdminAuth, async (req, res) => {
    try {
        await clearPendingTgLogin();
        if (userbotClient) { try { await userbotClient.invoke(new Api.auth.LogOut()); } catch (e) {} }
        await SettingModel.deleteOne({ key: 'tg_session' });
        if (userbotReconnectTimer) { clearTimeout(userbotReconnectTimer); userbotReconnectTimer = null; }
        await initUserbotBridge(); // falls back to env session if one exists, otherwise waits for login
        res.json({ success: true, message: 'Logged out. Saved session removed.' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '0.0.0.0', () => {
    debugLog('Server', `🚀 Portal live on port ${PORT}`);
    startKeepAlive({ port: PORT, path: '/health', log: debugLog });
});
