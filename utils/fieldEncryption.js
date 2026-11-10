'use strict';
const crypto = require('crypto');

function deriveKey(env = process.env) {
  const configured = String(env.DATA_ENCRYPTION_KEY || '').trim();
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  if (!configured && String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production. Generate a stable 32-byte key and keep it backed up.');
  }
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or Base64.');
  }
  const sessionSecret = env.SESSION_SECRET || crypto.createHash('sha256')
    .update('jpw-session:' + [env.INTERNAL_API_SECRET, env.ADMIN_SECRET_PASS, env.MONGO_URI].join('|')).digest('hex');
  return crypto.createHash('sha256').update('jpw-data-encryption-v1:' + sessionSecret).digest();
}
const KEY = deriveKey();
function encryptSensitive(value) {
  const plain = String(value == null ? '' : value);
  if (!plain || plain.startsWith('enc:v1:')) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function decryptSensitive(value) {
  const stored = String(value == null ? '' : value);
  if (!stored.startsWith('enc:v1:')) return stored; // legacy plaintext compatibility
  try {
    const packed = Buffer.from(stored.slice(7), 'base64');
    if (packed.length < 29) throw new Error('Invalid encrypted credential payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    throw new Error('Credential decryption failed. Check DATA_ENCRYPTION_KEY; do not overwrite the stored value.');
  }
}
module.exports = { encryptSensitive, decryptSensitive };
