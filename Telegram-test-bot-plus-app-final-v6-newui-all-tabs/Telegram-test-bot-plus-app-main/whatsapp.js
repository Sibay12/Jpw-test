// WhatsApp link (Baileys / "WhatsApp Web" protocol).
// - Login by scanning a QR code from the Admin Panel (WhatsApp > Linked devices > Link a device).
// - The login session is stored in MongoDB (collection "waauths"), so it survives Render restarts / redeploys.
// - This file only handles the connection. What the WhatsApp bot DOES (replies, packages, orders) is added later
//   through onMessage(handler) and sendText(to, text).
//
// The libraries are loaded lazily, so if they are not installed the rest of the server still runs
// and the Admin Panel just shows "library not installed".

// `name` lets the server run more than one WhatsApp number side by side. The default ('wa') is the normal customer
// number and keeps its old collections, so nothing changes for it. Another name (e.g. 'sel') gets its own session,
// its own lock and its own log list.
module.exports = function createWhatsApp({ mongoose, debugLog: baseLog, name = 'wa', label = 'WhatsApp' }) {
    const isMain = name === 'wa';
    const sfx = isMain ? '' : name.charAt(0).toUpperCase() + name.slice(1);
    const LOCK_ID = name;
    const dlogs = [];   // recent log lines of THIS number (shown in the Admin Panel)
    const dlog = (...a) => {
        try { dlogs.push({ t: new Date().toISOString(), text: a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 400) }); if (dlogs.length > 80) dlogs.shift(); } catch (e) {}
        baseLog(label, ...a);
    };
    const debugLog = (tag, ...a) => dlog(...a);   // keeps every old debugLog('WhatsApp', ...) line working
    const AuthModel = mongoose.models['WaAuth' + sfx]
        || mongoose.model('WaAuth' + sfx, new mongoose.Schema({ _id: String, data: String }, { versionKey: false }), isMain ? undefined : 'waauths_' + name);

    // One-owner lock in MongoDB: during a Render redeploy the old and the new server run side by side for a while.
    // If both open the same WhatsApp login, WhatsApp kicks one of them out again and again ("connection replaced").
    // Only the instance holding this lock opens the WhatsApp socket; the lock is released on shutdown.
    const LockModel = mongoose.models.WaLock
        || mongoose.model('WaLock', new mongoose.Schema({ _id: String, owner: String, until: Date }, { versionKey: false }));
    const INSTANCE = require('crypto').randomBytes(6).toString('hex');
    const LEASE_MS = 90 * 1000;

    const st = {
        state: 'idle',        // idle | connecting | qr | connected | reconnecting | logged_out | replaced | unavailable
        qrDataUrl: null,
        account: null,        // { number, name }
        since: null,
        lastError: '',
        inbox: [],            // last few incoming 1:1 text messages (for the Admin Panel check only)
        history: []           // last disconnect reasons (so we can see WHY it dropped)
    };
    let sock = null;
    let starting = false;
    let reconnectTimer = null;
    let attempts = 0;
    let replacedTries = 0;
    let wantOn = false;        // true once a phone is linked: the watchdog keeps it connected until logout
    let connectingSince = 0;
    let watchdog = null;
    let lockTimer = null;
        let manualOff = false;     // true only after an explicit logout (or the phone logging this device out)
    let holding = false;       // this instance owns the WhatsApp lock
    let probeFails = 0;
    const handlers = [];
    // --- fix for "Waiting for this message" on the customer's phone ---
    // When a phone cannot open a message it asks us to send it again. To do that WhatsApp needs the original message back
    // (getMessage). Without it the retry fails and the phone shows "Waiting for this message". So we keep the last sent
    // messages in memory and hand them back on request, and we count retries so a bad session cannot loop forever.
    const sentStore = new Map();
    function rememberSent(r) {
        try {
            if (r && r.key && r.key.id && r.message) {
                sentStore.set(r.key.id, r.message);
                if (sentStore.size > 1500) sentStore.delete(sentStore.keys().next().value);
            }
        } catch (e) {}
        return r;
    }
    const retryStore = new Map();
    const msgRetryCounterCache = {
        get: (k) => { const e = retryStore.get(k); return e && e.exp > Date.now() ? e.v : undefined; },
        set: (k, v) => { retryStore.set(k, { v, exp: Date.now() + 10 * 60 * 1000 }); if (retryStore.size > 3000) retryStore.delete(retryStore.keys().next().value); },
        del: (k) => { retryStore.delete(k); },
        flushAll: () => { retryStore.clear(); }
    };
    async function sendRaw(jid, content) { return rememberSent(await sock.sendMessage(jid, content)); }
    // Every message we send gets a fresh random code at the bottom (8-10 characters), so no two messages are identical.
    // This helps WhatsApp treat each one as a new message (fewer "Waiting for this message" / repeat-spam problems).
    const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function refCode() {
        const len = 8 + (require('crypto').randomBytes(1)[0] % 3);          // 8, 9 or 10
        const b = require('crypto').randomBytes(len);
        let out = ''; for (let i = 0; i < len; i++) out += REF_CHARS[b[i] % REF_CHARS.length];
        return out;
    }
    const withRef = (t) => `${String(t == null ? '' : t)}\n\nRef: ${refCode()}`;
    const seen = new Set();   // recent message ids (duplicate guard)

    // ---------- session storage in MongoDB (same idea as Baileys' multi-file auth state) ----------
    async function useMongoAuthState(B) {
        const { BufferJSON, initAuthCreds, proto } = B;
        const write = (id, obj) => AuthModel.updateOne({ _id: id }, { $set: { data: JSON.stringify(obj, BufferJSON.replacer) } }, { upsert: true });
        const read = async (id) => {
            const d = await AuthModel.findById(id).lean();
            return d && d.data ? JSON.parse(d.data, BufferJSON.reviver) : null;
        };
        const creds = (await read('creds')) || initAuthCreds();
        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const out = {};
                        await Promise.all(ids.map(async (id) => {
                            let v = await read(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
                            out[id] = v;
                        }));
                        return out;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const cat of Object.keys(data)) {
                            for (const id of Object.keys(data[cat])) {
                                const v = data[cat][id];
                                tasks.push(v ? write(`${cat}-${id}`, v) : AuthModel.deleteOne({ _id: `${cat}-${id}` }));
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds: () => write('creds', creds)
        };
    }

    async function clearAuth() {
        try { await AuthModel.deleteMany({}); } catch (e) { debugLog('WhatsApp', 'clearAuth failed:', e.message); }
    }

    // ---------- single-owner lock ----------
    async function acquireLock() {
        const now = new Date();
        try {
            const r = await LockModel.findOneAndUpdate(
                { _id: LOCK_ID, $or: [{ owner: INSTANCE }, { until: { $lt: now } }] },
                { $set: { owner: INSTANCE, until: new Date(now.getTime() + LEASE_MS) } },
                { upsert: true, new: true }
            );
            return !!r && r.owner === INSTANCE;
        } catch (e) {
            if (e && e.code === 11000) return false;   // somebody else holds a live lock
            debugLog('WhatsApp', 'lock check failed (continuing anyway):', e.message);
            return true;                               // DB hiccup: never stay dead because of the lock itself
        }
    }
    async function releaseLock() {
        holding = false;
        try { await LockModel.updateOne({ _id: LOCK_ID, owner: INSTANCE }, { $set: { until: new Date(0) } }); } catch (e) {}
    }
    function startLockTimer() {
        if (lockTimer) return;
        lockTimer = setInterval(async () => {
            if (!holding) return;
            const ok = await acquireLock();
            if (!ok) {
                holding = false;
                debugLog('WhatsApp', 'Lost the WhatsApp lock to another instance - stepping aside.');
                dropSocket();
                st.state = 'reconnecting';
                st.lastError = 'Another server instance took over WhatsApp (redeploy?) - waiting.';
                if (wantOn) scheduleReconnect(15000);
            }
        }, 30 * 1000);
    }

    function noteDisconnect(code, note) {
        st.history.push({ t: new Date().toISOString(), code: String(code), note });
        if (st.history.length > 12) st.history.shift();
    }

    function scheduleReconnect(delayMs) {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => { reconnectTimer = null; start().catch(() => {}); }, delayMs);
    }

    function dropSocket() {
        if (!sock) return;
        try { sock.ev.removeAllListeners('connection.update'); } catch (e) {}
        try { sock.ev.removeAllListeners('messages.upsert'); } catch (e) {}
        try { sock.end(undefined); } catch (e) {}
        sock = null;
    }

    // ---------- connect (shows a QR while the phone is not linked yet) ----------
    async function start() {
        if (starting) return;
        starting = true;
        manualOff = false;
        startWatchdog();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try {
            let B, pino, QRCode;
            try {
                B = require('@whiskeysockets/baileys');
                pino = require('pino');
                QRCode = require('qrcode');
            } catch (e) {
                st.state = 'unavailable';
                st.lastError = 'WhatsApp libraries are not installed on the server (npm install @whiskeysockets/baileys qrcode pino). ' + e.message;
                debugLog('WhatsApp', st.lastError);
                return;
            }
            if (!(await acquireLock())) {
                st.state = 'reconnecting';
                st.lastError = 'Another server instance is using this WhatsApp link (usually an old copy during a redeploy) - waiting for it to finish.';
                debugLog('WhatsApp', 'Lock is held by another instance - will retry in 15s.');
                if (wantOn) scheduleReconnect(15000);
                return;
            }
            holding = true;
            startLockTimer();
            const makeWASocket = B.default || B.makeWASocket;
            const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = B;
            const logger = pino({ level: 'silent' });

            dropSocket();
            const { state, saveCreds } = await useMongoAuthState(B);
            let version;
            try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { version = undefined; }

            const s = makeWASocket({
                version,
                logger,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
                printQRInTerminal: false,
                browser: ['JPW Portal', 'Chrome', '1.0.0'],
                markOnlineOnConnect: false,   // the phone keeps getting its own notifications
                syncFullHistory: false,
                keepAliveIntervalMs: 20000,   // ping often so hosting proxies / idle timeouts don't drop the socket
                connectTimeoutMs: 60000,
                retryRequestDelayMs: 500,
                msgRetryCounterCache,
                getMessage: async (key) => (key && key.id && sentStore.get(key.id)) || undefined,
                generateHighQualityLinkPreview: false
            });
            sock = s;
            st.state = 'connecting';
            connectingSince = Date.now();
            st.lastError = '';

            s.ev.on('creds.update', () => { saveCreds().catch(e => debugLog('WhatsApp', 'saveCreds failed:', e.message)); });

            s.ev.on('connection.update', async (u) => {
                if (s !== sock) return; // an old socket - ignore
                const { connection, lastDisconnect, qr } = u;
                try {
                    if (qr) {
                        st.state = 'qr';
                        try { st.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); }
                        catch (e) { st.qrDataUrl = null; st.lastError = 'Could not draw QR: ' + e.message; }
                    }
                    if (connection === 'open') {
                        attempts = 0; replacedTries = 0; wantOn = true; probeFails = 0;
                        st.state = 'connected';
                        st.lastError = '';
                        st.qrDataUrl = null;
                        st.since = new Date().toISOString();
                        const id = String((s.user && s.user.id) || '');
                        st.account = { number: id.split(':')[0].split('@')[0], name: (s.user && s.user.name) || '' };
                        debugLog('WhatsApp', `✅ Connected as +${st.account.number}`);
                    }
                    if (connection === 'close') {
                        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                        st.qrDataUrl = null;
                        st.account = null;
                        debugLog('WhatsApp', `Connection closed (code ${code})`);
                        noteDisconnect(code, (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || '');
                        if (code === DisconnectReason.loggedOut) {
                            await clearAuth();
                            await releaseLock();
                            wantOn = false; manualOff = true;
                            st.state = 'logged_out';
                            st.lastError = 'This device was logged out from the phone. Press Connect to scan a new QR.';
                            return;
                        }
                        if (code === DisconnectReason.connectionReplaced) {
                            // Another copy opened the same login. Never give up (a stopped link = lost customers): retry with a growing pause.
                            replacedTries++;
                            const wait = Math.min(30000 * replacedTries, 10 * 60 * 1000);
                            st.state = 'reconnecting';
                            st.lastError = `Login was opened somewhere else (try ${replacedTries}) - retrying in ${Math.round(wait / 1000)}s. If this repeats, close WhatsApp Web / the other server using this login.`;
                            scheduleReconnect(wait);
                            return;
                        }
                        if (code === DisconnectReason.restartRequired) { // normal right after scanning the QR
                            st.state = 'connecting';
                            scheduleReconnect(500);
                            return;
                        }
                        if (!(state.creds.registered || state.creds.me)) { // QR was never scanned and expired (a linked phone always has creds.me)
                            wantOn = false;
                            await releaseLock();
                            st.state = 'idle';
                            st.lastError = 'QR expired before it was scanned. Press Connect to get a new one.';
                            return;
                        }
                        attempts++;
                        st.state = 'reconnecting';
                        st.lastError = `Disconnected (code ${code || 'unknown'}) - reconnecting automatically.`;
                        scheduleReconnect(Math.min(3000 * attempts, 30000));
                    }
                } catch (e) { debugLog('WhatsApp', 'connection.update error:', e.message); }
            });

            s.ev.on('messages.upsert', ({ messages, type }) => {
                if (type !== 'notify') return;
                for (const m of messages || []) {
                    try {
                        if (!m.message || (m.key && m.key.fromMe)) continue;
                        const jid = (m.key && m.key.remoteJid) || '';
                        // 1:1 chats only. Newer accounts arrive as @lid, older as @s.whatsapp.net (no groups / status).
                        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
                        const id = m.key && m.key.id;
                        if (id) { // same message can be delivered twice - answer once
                            if (seen.has(id)) continue;
                            seen.add(id);
                            if (seen.size > 500) seen.delete(seen.values().next().value);
                        }
                        const msg = m.message;
                        const text = msg.conversation
                            || (msg.extendedTextMessage && msg.extendedTextMessage.text)
                            || (msg.imageMessage && msg.imageMessage.caption)
                            || (msg.videoMessage && msg.videoMessage.caption)
                            || '';
                        const hasMedia = !!(msg.imageMessage || msg.videoMessage || msg.documentMessage || msg.audioMessage);
                        if (!text && !hasMedia) continue;
                        // real phone number when WhatsApp gives it (needed for @lid chats)
                        const phoneJid = (m.key && (m.key.remoteJidAlt || m.key.senderPn)) || (jid.endsWith('@s.whatsapp.net') ? jid : '');
                        const from = (phoneJid || jid).split('@')[0].split(':')[0];
                        const shown = /^\s*JPW-ADM-/i.test(text || '') ? '[admin code]' : String(text || '[media]').slice(0, 300);   // never keep the admin code in the panel inbox
                        const item = { t: new Date().toISOString(), from, text: shown };
                        st.inbox.push(item);
                        if (st.inbox.length > 30) st.inbox.shift();
                        for (const h of handlers) { Promise.resolve().then(() => h({ from, jid, text: String(text), hasMedia, pushName: m.pushName || '', raw: m, sock: s })).catch(e => debugLog('WhatsApp', 'handler error:', e.message)); }
                    } catch (e) { debugLog('WhatsApp', 'messages.upsert error:', e.message); }
                }
            });
        } catch (e) {
            st.lastError = 'Start failed: ' + e.message;
            debugLog('WhatsApp', st.lastError);
            if (wantOn) { attempts++; st.state = 'reconnecting'; scheduleReconnect(Math.min(3000 * attempts, 30000)); } // e.g. DB hiccup - never stay dead
            else st.state = 'idle';
        } finally {
            starting = false;
        }
    }

    // Watchdog: if the link is supposed to be on but is dead (stuck, silently closed socket, failed restart), bring it back.
    async function hasSavedSession() {
        try {
            const d = await AuthModel.findById('creds').lean();
            if (!d || !d.data) return false;
            const c = JSON.parse(d.data);
            return !!(c.registered || c.me);
        } catch (e) { return false; }
    }

    function startWatchdog() {
        if (watchdog) return;
        watchdog = setInterval(async () => {
            try {
                if (starting || reconnectTimer) return;
                // Link is off but nobody switched it off on purpose and a phone is still linked -> bring it back.
                if (!wantOn) {
                    if (!manualOff && (st.state === 'idle' || st.state === 'reconnecting' || st.state === 'connecting') && !sock && await hasSavedSession()) {
                        debugLog('WhatsApp', 'Watchdog: link was off but a phone is still linked - reconnecting.');
                        wantOn = true;
                        noteDisconnect('watchdog', 'link was off unexpectedly - revived');
                        start().catch(() => {});
                    }
                    return;
                }
                if (st.state === 'connected') {
                    const ws = sock && sock.ws;
                    const dead = !sock || (ws && (ws.isClosed === true || ws.isClosing === true));
                    if (dead) { debugLog('WhatsApp', 'Watchdog: socket is closed but state says connected - reconnecting.'); st.state = 'reconnecting'; dropSocket(); start().catch(() => {}); }
                    return;
                }
                if (st.state === 'connecting' && Date.now() - connectingSince > 120000) {
                    debugLog('WhatsApp', 'Watchdog: stuck connecting - restarting.'); dropSocket(); start().catch(() => {}); return;
                }
                if (st.state === 'reconnecting' || st.state === 'idle' || st.state === 'unavailable') {
                    debugLog('WhatsApp', `Watchdog: state is ${st.state} - reconnecting.`); start().catch(() => {});
                }
            } catch (e) { debugLog('WhatsApp', 'watchdog error:', e.message); }
        }, 20 * 1000);
    }

    // On server start: reconnect only if a phone was already linked before (no QR spam otherwise).
    async function autoStart() {
        try {
            const d = await AuthModel.findById('creds').lean();
            if (d && d.data && (() => { const c = JSON.parse(d.data); return c.registered || c.me; })()) {
                debugLog('WhatsApp', 'Saved session found - reconnecting.');
                wantOn = true;
                startWatchdog();
                await start();
            } else {
                debugLog('WhatsApp', 'No linked WhatsApp yet. Link it from the Admin Panel (QR).');
            }
        } catch (e) { debugLog('WhatsApp', 'autoStart failed:', e.message); }
    }

    async function logout() {
        wantOn = false; manualOff = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        const s = sock;
        if (s) { try { await s.logout(); } catch (e) { /* phone may already be offline */ } }
        dropSocket();
        await clearAuth();
        await releaseLock();
        attempts = 0;
        st.state = 'idle';
        st.qrDataUrl = null;
        st.account = null;
        st.since = null;
        st.lastError = '';
        st.inbox = [];
    }

    async function sendText(to, text) {
        if (!sock || st.state !== 'connected') throw new Error('WhatsApp is not connected.');
        const digits = String(to || '').replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) throw new Error('Number galat hai - country code ke saath likhiye (e.g. 919876543210).');
        const jid = `${digits}@s.whatsapp.net`;
        try {
            const r = await sock.onWhatsApp(jid);
            if (r && r[0] && r[0].exists === false) throw new Error('This number is not on WhatsApp.');
        } catch (e) { if (/not on WhatsApp/.test(e.message)) throw e; /* lookup failed - try sending anyway */ }
        await sendRaw(jid, { text: withRef(text) });
    }

    // Reply inside an existing chat (works for @lid and @s.whatsapp.net). Shows "typing..." and waits a moment - looks human, lowers ban risk.
    async function reply(jid, text) {
        if (!sock || st.state !== 'connected') throw new Error('WhatsApp is not connected.');
        try { await sock.presenceSubscribe(jid); await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
        await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 1200)));
        await sendRaw(jid, { text: withRef(text) });
        try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
    }

    // Send a picture (e.g. payment QR). Returns the message key so the message can be deleted later.
    async function sendImage(jid, buffer, caption) {
        if (!sock || st.state !== 'connected') throw new Error('WhatsApp is not connected.');
        const r = await sendRaw(jid, { image: buffer, caption: withRef(caption || '') });
        return r && r.key ? { remoteJid: r.key.remoteJid, fromMe: true, id: r.key.id } : null;
    }

    // Send a file (e.g. nightly backup).
    async function sendDocument(jid, buffer, fileName, caption, mimetype) {
        if (!sock || st.state !== 'connected') throw new Error('WhatsApp is not connected.');
        await sendRaw(jid, { document: buffer, fileName: String(fileName), mimetype: mimetype || 'application/octet-stream', caption: withRef(caption || '') });
    }

    // Delete one of OUR sent messages for everyone in that chat.
    async function deleteMessage(jid, key) {
        if (!sock || st.state !== 'connected') throw new Error('WhatsApp is not connected.');
        if (!key) return;
        await sock.sendMessage(jid, { delete: key });
    }

    function getStatus() {
        return {
            state: st.state,
            qr: st.state === 'qr' ? st.qrDataUrl : null,
            account: st.account,
            since: st.since,
            lastError: st.lastError,
            inbox: st.inbox.slice(-15).reverse(),
            history: st.history.slice(-8).reverse(),
            logs: dlogs.slice(-60).reverse()
        };
    }

    // Render stops the old server on every redeploy: close the socket quietly (NOT logout) and free the lock,
    // so the new server can take over WhatsApp immediately instead of fighting the old one.
    let shuttingDown = false;
    const gracefulStop = (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        wantOn = false;
        debugLog('WhatsApp', `${sig} received - releasing WhatsApp lock.`);
        const done = () => { if (isMain) process.exit(0); };
        if (isMain) setTimeout(done, 4000).unref();
        Promise.resolve().then(async () => { try { dropSocket(); } catch (e) {} await releaseLock(); }).then(done, done);
    };
    process.once('SIGTERM', () => gracefulStop('SIGTERM'));
    process.once('SIGINT', () => gracefulStop('SIGINT'));

    return { start, autoStart, logout, sendText, reply, sendImage, sendDocument, deleteMessage, isConnected: () => st.state === 'connected', getStatus, onMessage: (fn) => handlers.push(fn) };
};
