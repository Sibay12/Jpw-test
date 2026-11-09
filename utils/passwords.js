// Password hashing using Node's built-in crypto (scrypt) -> no external package needed,
// so "xxx is not defined" / "Cannot find module" can never break register/login.
// Old accounts that already have bcrypt hashes ($2a$/$2b$/$2y$) are still verified
// if bcryptjs is installed.
const crypto = require('crypto');

let bcryptjs = null;
try { bcryptjs = require('bcryptjs'); } catch (e) { /* optional */ }

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(String(password), salt, 64, (err, key) => {
            if (err) return reject(err);
            resolve(`scrypt$${salt}$${key.toString('hex')}`);
        });
    });
}

function verifyScrypt(password, stored) {
    return new Promise((resolve) => {
        const [, salt, hash] = stored.split('$');
        if (!salt || !hash) return resolve(false);
        crypto.scrypt(String(password), salt, 64, (err, key) => {
            if (err) return resolve(false);
            const a = Buffer.from(hash, 'hex');
            resolve(a.length === key.length && crypto.timingSafeEqual(a, key));
        });
    });
}

// returns { ok, needsUpgrade }
async function verifyPassword(password, stored) {
    if (!stored) return { ok: false, needsUpgrade: false };
    if (stored.startsWith('scrypt$')) return { ok: await verifyScrypt(password, stored), needsUpgrade: false };
    if (/^\$2[aby]\$/.test(stored)) {
        if (!bcryptjs) return { ok: false, needsUpgrade: false };
        const ok = await bcryptjs.compare(String(password), stored);
        return { ok, needsUpgrade: ok };
    }
    // very old plaintext account
    const ok = stored === String(password);
    return { ok, needsUpgrade: ok };
}

module.exports = { hashPassword, verifyPassword };
