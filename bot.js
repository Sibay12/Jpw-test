require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

const REQUIRED_ENV_VARS = ['BOT_TOKEN', 'ADMIN_CHAT_ID', 'INTERNAL_API_SECRET'];
const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
    console.error('Please create a .env file based on .env.example before starting the bot.');
    process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
// When bot.js runs inside server.js it talks to the server locally (BOT_API_BASE); standalone it uses the public URL
const MAIN_SERVER_URL = process.env.BOT_API_BASE || process.env.SERVER_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://cashtree.space';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Your Admin Chat ID
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '919382856020'; // Your WhatsApp Number
// 🔐 Sent as a header on every internal server call so protected routes on server.js accept it
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// White-label message signature: pull the active site name from the server so Telegram
// notifications follow Admin > Branding without hard-coded product names.
let activeSiteBrand='JPW';
let brandRefreshAt=0;
const originalSendMessage=bot.sendMessage.bind(bot);
bot.sendMessage=async function(chatId,text,options){
    try{
        if(Date.now()-brandRefreshAt>60000){
            brandRefreshAt=Date.now();
            const response=await fetch(`${MAIN_SERVER_URL.replace(/\/$/,'')}/api/public/branding`);
            if(response.ok){const data=await response.json();if(data?.branding?.siteName)activeSiteBrand=String(data.branding.siteName).slice(0,60);}
        }
    }catch(e){}
    const body=String(text??'');
    const signature=`\\n\\n_${activeSiteBrand} · Powered by TEKNA TECHNOLOGY_`;
    const finalText=body.includes('Powered by TEKNA TECHNOLOGY')?body:body+signature;
    return originalSendMessage(chatId,finalText,options);
};


// temporary memory to track users currently entering their UPI ID for withdrawal
const pendingUpiInput = new Set();

// 📦 Updated Fallback Packages (Ref Pricing Chart)
const FALLBACK_PLANS = [
    { id: 'p1', name: 'Starter', reaches: 1, price: 20 },
    { id: 'p3', name: 'Basic', reaches: 3, price: 55 },
    { id: 'p7', name: 'Pro', reaches: 7, price: 105 },
    { id: 'p15', name: 'Advanced', reaches: 15, price: 210 }
];

// 🌅 Automatic Greetings System based on time of day
function getAutomaticGreeting(firstName) {
    const hour = new Date().getHours();
    let timeGreeting = "Hello";
    
    if (hour >= 4 && hour < 12) {
        timeGreeting = "Good Morning 🌅";
    } else if (hour >= 12 && hour < 17) {
        timeGreeting = "Good Afternoon ☀️";
    } else if (hour >= 17 && hour < 21) {
        timeGreeting = "Good Evening 🌇";
    } else {
        timeGreeting = "Hello 🌙";
    }
    return `${timeGreeting}, *${firstName}*!`;
}

// 🕒 Hourly report scheduler for admin
setInterval(async () => {
    try {
        let updateMsg = `📊 *Hourly Referral & Earnings Report*\n\n⏰ Time: ${new Date().toLocaleTimeString()}\nSystem running smoothly! 🚀`;
        bot.sendMessage(ADMIN_CHAT_ID, updateMsg, { parse_mode: 'Markdown' });
    } catch (e) {}
}, 60 * 60 * 1000);

bot.on('message', async (msg) => {
    if (!msg || !msg.chat || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const firstName = msg.from.first_name || 'User';

    // 🛠️ Maintenance mode (switch in Admin Panel): everyone except the admin gets the maintenance message only
    const MAINT = global.__JPW_MAINTENANCE;
    if (MAINT && MAINT.enabled && chatId !== String(ADMIN_CHAT_ID)) {
        pendingUpiInput.delete(chatId);
        bot.sendMessage(chatId, `🛠️ Complete system is going into Maintenance Mode for now. Please try again later.\n\n🆘 Help (WhatsApp only): +${MAINT.whatsapp}`).catch(() => {});
        return;
    }

    // 💸 UPI ID INPUT LISTENER FOR WITHDRAWAL
    if (pendingUpiInput.has(chatId)) {
        pendingUpiInput.delete(chatId);
        let upiId = text;

        let commissionBalance = 0.00;
        try {
            const res = await fetch(`${MAIN_SERVER_URL}/api/external/v1/user-status?chatId=${chatId}`, { headers: { 'x-internal-secret': INTERNAL_API_SECRET } });
            const data = await res.json();
            if (data.success && data.user) {
                commissionBalance = data.user.commissionBalance || 0.00;
            }
        } catch (e) {}

        const adminWithdrawalKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Accept & Pay", callback_data: `wd_accept_${chatId}_${commissionBalance}` },
                        { text: "❌ Reject", callback_data: `wd_reject_${chatId}_${commissionBalance}` }
                    ]
                ]
            }
        };

        bot.sendMessage(ADMIN_CHAT_ID, `🔔 *New RS CASH Withdrawal Request!*\n\n👤 User ID: \`${chatId}\`\n💰 Amount: *₹${commissionBalance.toFixed(2)}*\n📱 UPI ID: \`${upiId}\`\n\nKripya verify karke action lein:`, { parse_mode: 'Markdown', ...adminWithdrawalKeyboard });
        bot.sendMessage(chatId, `✅ *Withdrawal Request Submitted!*\n\nYour UPI ID: \`${upiId}\` has been recorded. Admin will review and transfer your ₹${commissionBalance.toFixed(2)} shortly.`, { parse_mode: 'Markdown' });
        return;
    }

    // 👑 ADMIN START COMMAND
    if (chatId === ADMIN_CHAT_ID && text.startsWith('/start')) {
        sendAdminDashboard(chatId);
        return;
    }

    // 👤 NORMAL USER START COMMAND
    if (text.startsWith('/start')) {
        sendWelcomeMessage(chatId, firstName);
    }
    // 🔗 SECRET MANUAL REFERRAL & DASHBOARD COMMAND (/ref JPW1234 or /ref)
    else if (text.toLowerCase() === '/ref' || text.toLowerCase() === '/referral' || text.toLowerCase().startsWith('/ref ') || text.toLowerCase().startsWith('/referral ')) {
        const parts = text.split(/\s+/);
        
        // CASE 1: Agar sirf /ref ya /referral likha hai, toh secret dashboard dikhayein
        if (parts.length < 2) {
            showReferralDashboard(chatId, firstName);
            return;
        }

        // CASE 2: Agar user ne code likhkar bheja hai (jaise /ref JPW1234)
        const inputReferralCode = parts[1].trim();

        try {
            const response = await fetch(`${MAIN_SERVER_URL}/api/external/v1/register-referral`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
                body: JSON.stringify({ telegramChatId: chatId, name: `REF_${firstName}`, referralCode: inputReferralCode })
            });
            const result = await response.json();

            if (result.success) {
                bot.sendMessage(chatId, `🎉 **Referral Success!**\n\nआप सफलतापूर्वक रेफरल कोड \`${inputReferralCode}\` के साथ जुड़ गए हैं! ✅`, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `❌ **Referral Failed:** ${result.message || 'यह कोड अमान्य है या आप पहले ही जुड़ चुके हैं।'}`, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            bot.sendMessage(chatId, `⚠️ सर्वर से कनेक्ट करने में समस्या आ रही है। कृपया बाद में प्रयास करें।`);
        }
    }
    // 👑 Admin commands
    else if (chatId === ADMIN_CHAT_ID && (text.toLowerCase() === '/refstats' || text.toLowerCase() === '/admin')) {
        sendAdminDashboard(chatId);
    }
    else if (chatId === ADMIN_CHAT_ID && text.startsWith('/broadcast')) {
        const broadcastMsg = text.replace('/broadcast', '').trim();
        if (!broadcastMsg) return bot.sendMessage(chatId, '⚠️ Please provide a broadcast message.');
        bot.sendMessage(chatId, `✅ *Broadcast queued...*`);
    }
    else if (text === '/myplan') {
        sendWelcomeMessage(chatId, firstName, true);
    }
    else if (text === '/buy') {
        sendBuyPlans(chatId);
    }
    // Direct TECHID PASSWORD detection for order
    else if (!text.startsWith('/')) {
        const parts = text.split(/\s+/);
        if (parts.length >= 2 && chatId !== ADMIN_CHAT_ID) {
            const targetId = parts[0].trim();
            const targetPass = parts.slice(1).join(' ').trim();

            bot.sendMessage(chatId, `⏳ Checking your balance and processing order...`);

            try {
                const response = await fetch(`${MAIN_SERVER_URL}/api/order`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
                    body: JSON.stringify({ telegramChatId: chatId, targetId, targetPass })
                });
                const result = await response.json();

                if (result.success) {
                    bot.sendMessage(chatId, result.selected ? `✅ *Order submitted successfully!*\n\n🎯 Target ID: \`${targetId}\`` : `✅ *Order submitted successfully!*\n\n🎯 Target ID: \`${targetId}\`\n🪙 Remaining Coins: *${result.remainingCoins || 0}*`, { parse_mode: 'Markdown' });
                } else {
                    let errorMsg = result.message || 'Insufficient balance!';
                    if (errorMsg.toLowerCase().includes('insufficient') || errorMsg.toLowerCase().includes('coin') || errorMsg.toLowerCase().includes('reach')) {
                        const noBalanceKeyboard = {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: "📦 Purchase Your Package", callback_data: "menu_buy" }]
                                ]
                            }
                        };
                        bot.sendMessage(chatId, `❌ *No Active Plan / Insufficient Balance!*\n\nYour current account has **0 available Coins**. Please purchase a package to continue sending orders.\n\n👇 Click below to buy a package:`, { parse_mode: 'Markdown', ...noBalanceKeyboard });
                    } else {
                        bot.sendMessage(chatId, `⚠️ *Order Status:*\n${errorMsg}`, { parse_mode: 'Markdown' });
                    }
                }
            } catch (err) {
                bot.sendMessage(chatId, '⚠️ Connection error with the server.');
            }
        }
    }
});

// 🕵️‍♂️ SECRET REFERRAL DASHBOARD FUNCTION
async function showReferralDashboard(chatId, firstName) {
    let userReferralCode = 'JPW1234';
    let commissionBalance = 0.00; 
    let totalReferrals = 0;

    try {
        const res = await fetch(`${MAIN_SERVER_URL}/api/external/v1/user-status?chatId=${chatId}`, { headers: { 'x-internal-secret': INTERNAL_API_SECRET } });
        const data = await res.json();
        if (data.success && data.user) {
            commissionBalance = data.user.commissionBalance !== undefined ? data.user.commissionBalance : 0.00;
            totalReferrals = data.user.totalReferrals !== undefined ? data.user.totalReferrals : 0;
            if (data.user.referralCode) {
                userReferralCode = data.user.referralCode;
            }
        }
    } catch (e) {}

    const refLink = `https://t.me/${(await bot.getMe()).username}?start=${userReferralCode}`;

    let messageBody = `👥 *Secret Referral & Commission Dashboard*\n\n` +
        `🔗 *Your Referral Link:*\n\`${refLink}\`\n\n` +
        `🏷️ *Your Referral ID:* \`${userReferralCode}\`\n` +
        `💡 *Manual Register Format:*\nType \`/ref ${userReferralCode}\` to join someone.\n\n` +
        `💰 *Total RS CASH Earned:* ₹${commissionBalance.toFixed(2)}\n` +
        `📊 *Total Referrals:* ${totalReferrals} users\n\n` +
        `You earn commission when your referred users complete orders!`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "💸 Withdraw RS CASH via UPI", callback_data: "request_withdrawal" }]
            ]
        }
    };

    bot.sendMessage(chatId, messageBody, { parse_mode: 'Markdown', ...keyboard });
}

// 👑 ADMIN DASHBOARD UI
function sendAdminDashboard(chatId) {
    let text = `👑 *JPW Admin Control Panel*\n\n` +
        `Welcome to the Admin Dashboard. Select an option below to manage bot operations.`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Referral Stats", callback_data: "admin_stats" }, { text: "💳 Withdrawals", callback_data: "admin_withdrawals" }],
                [{ text: "📢 Broadcast Info", callback_data: "admin_help_broadcast" }]
            ]
        }
    };
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...keyboard });
}

// 👤 WELCOME MESSAGE & ACTIVE/INACTIVE STATUS WITH EXPIRY DATE
async function sendWelcomeMessage(chatId, firstName, planOnly = false) {
    let userCoins = 0;
    let expiryText = 'No active package';
    
    try {
        const res = await fetch(`${MAIN_SERVER_URL}/api/external/v1/user-status?chatId=${chatId}`, { headers: { 'x-internal-secret': INTERNAL_API_SECRET } });
        const data = await res.json();
        if (data.success && data.user) {
            userCoins = data.user.jpwCoins !== undefined ? data.user.jpwCoins : 0;
            
            if (data.user.packageExpiryTime) {
                const expiryDate = new Date(data.user.packageExpiryTime);
                const now = new Date();
                const diffTime = expiryDate - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays > 0) {
                    expiryText = `${expiryDate.toLocaleDateString('en-IN')} (${diffDays} days left)`;
                } else {
                    expiryText = `Expired`;
                }
            }
        }
    } catch (e) {}

    const greeting = getAutomaticGreeting(firstName);
    let text = '';
    
    if (!planOnly) {
        text += `${greeting} Welcome to JPW Reach Service.\n\n` +
            `📌 *Before Sending ID & Pass:*\n` +
            `• ✅ Workorder must be assigned.\n` +
            `• 🗺️ Map must be open.\n` +
            `• 🔑 Do not send expired passwords.\n\n` +
            `📩 *Send in a single message:* \`TECHID PASSWORD\`\n\n` +
            `⏳ Wait for the duration specified by the bot. Do not log into JPW during this time.\n\n` +
            `🔒 *Safe • Secure • Fast • Trusted*\n\n`;
    }

    let accountStatus = userCoins > 0 ? `✅ *Active*` : `❌ *No Plan Active*`;

    text += `📦 *Your Current Account:*\n` +
        `• Available Coins: \`${userCoins}\`\n` +
        `• Status: ${accountStatus}\n` +
        `• ⏳ *Package Expiry:* \`${expiryText}\``;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📦 Buy Coins Plan", callback_data: "menu_buy" }, { text: "📑 Refresh My Plan", callback_data: "menu_myplan" }]
            ]
        }
    };
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...keyboard });
}

// 🛒 DYNAMIC PACKAGE FETCHER (Updated Chart)
async function sendBuyPlans(chatId) {
    let activePlans = FALLBACK_PLANS;
    
    try {
        const res = await fetch(`${MAIN_SERVER_URL}/api/external/v1/packages`, { headers: { 'x-internal-secret': INTERNAL_API_SECRET } });
        const data = await res.json();
        if (data.success && data.packages) {
            activePlans = data.packages;
        }
    } catch (e) {}

    let planText = `🛒 *JPW Reach — Buy Coins Plan*\n\nChoose a plan below. All payments are done via WhatsApp.\n📱 *WhatsApp:* +${WHATSAPP_NUMBER}\n\n*Available Plans:*\n`;
    let inlineKeyboard = [];
    
    activePlans.forEach(p => {
        let coins = p.coins !== undefined ? p.coins : p.reaches;
        let price = p.amount !== undefined ? p.amount : p.price;
        planText += `🪙 ₹${price} → ${coins} Coins\n`;
        inlineKeyboard.push([{ text: `₹${price} — ${coins} Coins`, callback_data: `buy_plan_${price}_${coins}_Coins` }]);
    });

    bot.sendMessage(chatId, planText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const messageId = query.message.message_id;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    const MAINT = global.__JPW_MAINTENANCE;
    if (MAINT && MAINT.enabled && chatId !== String(ADMIN_CHAT_ID)) {
        bot.sendMessage(chatId, `🛠️ Complete system is going into Maintenance Mode for now. Please try again later.\n\n🆘 Help (WhatsApp only): +${MAINT.whatsapp}`).catch(() => {});
        return;
    }

    if (data === 'menu_buy') {
        sendBuyPlans(chatId);
    } 
    else if (data === 'menu_myplan') {
        sendWelcomeMessage(chatId, query.from.first_name, true);
    }
    // 💸 WITHDRAWAL REQUEST FLOW (UPI ID Prompt)
    else if (data === 'request_withdrawal') {
        pendingUpiInput.add(chatId);
        bot.sendMessage(chatId, `📲 *Enter Your UPI ID*\n\nPlease reply with your UPI ID (e.g., \`user@oksbi\` or \`paytmnumber@paytm\`) where you want to receive your RS CASH withdrawal:`, { parse_mode: 'Markdown' });
    }
    else if (chatId === ADMIN_CHAT_ID && data === 'admin_stats') {
        bot.sendMessage(chatId, `📊 *Admin Stats:*\nFetching live stats from server...`, { parse_mode: 'Markdown' });
    }
    else if (chatId === ADMIN_CHAT_ID && data === 'admin_help_broadcast') {
        bot.sendMessage(chatId, `📢 *How to Broadcast:*\nSimply type \`/broadcast your message here\` to send to all users.`, { parse_mode: 'Markdown' });
    }
    // 💳 एडमिन पेमेंट अप्रूवल (Accept / Reject)
    else if (chatId === ADMIN_CHAT_ID && data.startsWith('pay_')) {
        const parts = data.split('_');
        const action = parts[1];
        const targetUserChatId = parts[2];
        const price = parts[3];
        const coins = parts[4];
        const planName = parts.slice(5).join(' ');

        if (action === 'accept') {
            try {
                await fetch(`${MAIN_SERVER_URL}/api/external/v1/approve-payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
                    body: JSON.stringify({ telegramChatId: targetUserChatId, coins })
                });
            } catch (e) {}

            bot.sendMessage(targetUserChatId, `🎉 *Payment Successful & Plan Activated!*\nAapka ₹${price} ka payment admin dwara *Accept* kar liya gaya hai aur aapke account mein ${coins} Coins add kar diye gaye hain.`);
            
            bot.editMessageText(`✅ *Payment Successful & Accepted*\n\n👤 User ID: \`${targetUserChatId}\`\n💰 Amount: *₹${price}*\nCoins Added: *+${coins}* 🟢`, { 
                chat_id: chatId, 
                message_id: messageId, 
                parse_mode: 'Markdown' 
            });
        } else {
            bot.sendMessage(targetUserChatId, `❌ *Payment Rejected*\nAapka ₹${price} ka payment verify nahi ho paya, isliye cancel kar diya gaya hai.`);
            
            bot.editMessageText(`❌ *Payment Rejected / Cancelled*\n\n👤 User ID: \`${targetUserChatId}\`\n💰 Amount: *₹${price}*\nStatus: Rejected 🔴`, { 
                chat_id: chatId, 
                message_id: messageId, 
                parse_mode: 'Markdown' 
            });
        }
    }
    // 💳 ADMIN WITHDRAWAL ACTION HANDLER (Auto Deduct / Refund Balance)
    else if (chatId === ADMIN_CHAT_ID && data.startsWith('wd_')) {
        const parts = data.split('_');
        const action = parts[1];
        const targetUserChatId = parts[2];
        const amount = parseFloat(parts[3]);

        if (action === 'accept') {
            // Deduct / Finalize withdrawal amount from user's commission balance
            try {
                await fetch(`${MAIN_SERVER_URL}/api/external/v1/update-commission`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
                    body: JSON.stringify({ telegramChatId: targetUserChatId, amount: amount, action: 'deduct' })
                });
            } catch (e) {}

            bot.sendMessage(targetUserChatId, `🎉 *Withdrawal Approved!*\nYour RS CASH withdrawal request for ₹${amount} has been *Accepted* and transferred by the admin.`);
            bot.editMessageText(`✅ *Withdrawal Accepted & Paid* (₹${amount} paid to \`${targetUserChatId}\`)`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        } else {
            // Reject / Cancel -> Refund amount back to user's commission wallet
            try {
                await fetch(`${MAIN_SERVER_URL}/api/external/v1/update-commission`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
                    body: JSON.stringify({ telegramChatId: targetUserChatId, amount: amount, action: 'refund' })
                });
            } catch (e) {}

            bot.sendMessage(targetUserChatId, `❌ *Withdrawal Cancelled & Refunded*\nYour RS CASH withdrawal request for ₹${amount} was rejected by the admin, and the amount has been *refunded back* to your commission wallet.`);
            bot.editMessageText(`❌ *Withdrawal Cancelled & Refunded* (₹${amount} returned to \`${targetUserChatId}\`)`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        }
    }
    else if (data.startsWith('buy_plan_')) {
        const parts = data.split('_');
        if (parts.length < 4) return;
        
        const price = parts[2];
        const coins = parts[3];
        const planName = `${coins} Coins Plan`;

        const adminKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Accept Payment", callback_data: `pay_accept_${chatId}_${price}_${coins}_${planName}` },
                        { text: "❌ Reject", callback_data: `pay_reject_${chatId}_${price}_${coins}_${planName}` }
                    ]
                ]
            }
        };
        bot.sendMessage(ADMIN_CHAT_ID, `🔔 *New Purchase Order / Payment Request!*\n\n👤 User ID: \`${chatId}\`\n📦 Plan: *${planName}* (${coins} coins)\n💰 Amount: *₹${price}*\n\nKripya verify karke action lein:`, { parse_mode: 'Markdown', ...adminKeyboard });

        let messageBody = `📞 *${planName} — Pay via WhatsApp*\n\n` +
            `💰 *Amount: ₹${price}*\n` +
            `📦 *Plan:* ${coins} Coins\n` +
            `🆔 *Your Telegram ID:* \`${chatId}\`\n\n` +
            `⬇️ *Tap below to contact WhatsApp:*\n` +
            `\`Buy coins-${coins} - ${chatId}\`\n\n` +
            `⏰ *Order expires in 24 hours.*\n` +
            `⚡ *Once paid, your coins will be activated manually.*`;

        let waText = encodeURIComponent(`Buy coins-${coins} - ${chatId}`);
        let waLink = `https://wa.me/${WHATSAPP_NUMBER}?text=${waText}`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "💬 Contact WhatsApp", url: waLink }],
                    [{ text: "« Back to Plans", callback_data: "menu_buy" }]
                ]
            }
        };

        try {
            await bot.editMessageText(messageBody, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
        } catch (e) {
            bot.sendMessage(chatId, messageBody, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        }
    }
});
