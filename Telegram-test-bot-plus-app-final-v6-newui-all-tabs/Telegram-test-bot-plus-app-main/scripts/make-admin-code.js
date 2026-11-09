// Make a NEW WhatsApp admin code:  node scripts/make-admin-code.js
// Put the printed HASH in WA_ADMIN_CODE_HASH (.env / Render). Send the printed CODE from your WhatsApp to the bot once.
const crypto = require('crypto');
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const g = () => Array.from(crypto.randomBytes(4), b => A[b % A.length]).join('');
const code = `JPW-ADM-${g()}-${g()}-${g()}-${g()}`;
console.log('CODE (send this on WhatsApp):', code);
console.log('HASH (put in WA_ADMIN_CODE_HASH):', crypto.createHash('sha256').update(code).digest('hex'));
