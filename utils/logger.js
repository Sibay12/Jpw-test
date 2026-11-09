const fs = require('fs');
const path = require('path');

const logFilePath = path.join(__dirname, '../server_debug.log');
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // when the log file passes 5 MB, the old half is dropped
const RING_MAX = 5000;                    // last 5000 lines are also kept in memory for the Admin Panel "Logs" tab

// ---- in-memory ring buffer: EVERYTHING the server prints (console.log / warn / error + debugLog) ----
const ring = [];
function pushRing(level, text) {
    const lines = String(text).split('\n');
    const stamp = new Date().toISOString();
    for (const ln of lines) {
        if (!ln.trim()) continue;
        ring.push({ t: stamp, level, text: ln });
    }
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}
(function hookConsole() {
    if (console.__jpwHooked) return;
    console.__jpwHooked = true;
    for (const level of ['log', 'info', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            try {
                pushRing(level, args.map(a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : JSON.stringify(a)))).join(' '));
            } catch (e) {}
            orig(...args);
        };
    }
})();

function trimFileIfBig() {
    try {
        const st = fs.statSync(logFilePath);
        if (st.size > MAX_FILE_BYTES) {
            const buf = fs.readFileSync(logFilePath);
            fs.writeFileSync(logFilePath, buf.slice(buf.length - Math.floor(MAX_FILE_BYTES / 2)));
        }
    } catch (e) {}
}

function debugLog(moduleName, message, data = '') {
    const timestamp = new Date().toLocaleString();
    let dataStr = '';
    try { dataStr = data ? (typeof data === 'string' ? JSON.stringify(data) : JSON.stringify(data)) : ''; } catch (e) { dataStr = String(data); }
    const logMessage = `[${timestamp}] [${moduleName.toUpperCase()}] ${message} ${dataStr}\n`;

    console.log(logMessage.trim());   // also lands in the ring buffer through the console hook
    try {
        fs.appendFileSync(logFilePath, logMessage);
        if (Math.random() < 0.01) trimFileIfBig();
    } catch (e) {
        console.error('❌ Failed to write log:', e.message);
    }
}

function getRecentLogs() {
    try {
        if (!fs.existsSync(logFilePath)) return 'Abhi koi log record nahi hua hai.';
        const data = fs.readFileSync(logFilePath, 'utf8');
        const lines = data.trim().split('\n');
        return lines.slice(-50).join('\n');
    } catch (e) {
        return 'Error reading log file: ' + e.message;
    }
}

// Complete server log for the Admin Panel: newest `n` lines (everything printed since the server started, max 5000 lines)
function getAllLogs(n = 500, level = '') {
    let list = ring;
    if (level === 'error') list = ring.filter(r => r.level === 'error' || /❌|error|fail|exception|crash/i.test(r.text));
    const slice = list.slice(-Math.max(1, Math.min(n, RING_MAX)));
    return slice.map(r => `${new Date(r.t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} ${r.level === 'error' ? '[ERR] ' : (r.level === 'warn' ? '[WARN] ' : '')}${r.text}`).join('\n');
}
function getLogFilePath() { return logFilePath; }

module.exports = { debugLog, getRecentLogs, getAllLogs, getLogFilePath };
