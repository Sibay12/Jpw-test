// Open a nightly backup:  node scripts/decrypt-backup.js jpw-backup-2026-10-04.json.gz.enc "YOUR_BACKUP_PASSWORD"
// If the backup came in parts: first join them (Linux/Mac: cat file.part1of2 file.part2of2 > full.enc ; Windows: copy /b part1+part2 full.enc)
// Result: <name>.json  (all collections, MongoDB Extended JSON - restore with mongoimport or your own script)
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto');
const [,, file, password] = process.argv;
if (!file || !password) { console.log('Usage: node scripts/decrypt-backup.js <backup.enc> "<password>"'); process.exit(1); }
const b = fs.readFileSync(file);
if (b.subarray(0, 6).toString() !== 'JPWBK1') { console.log('Not a JPW backup file (or parts are not joined).'); process.exit(1); }
const salt = b.subarray(6, 22), iv = b.subarray(22, 34), tag = b.subarray(34, 50), data = b.subarray(50);
try {
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(password, salt, 32), iv);
    d.setAuthTag(tag);
    const out = zlib.gunzipSync(Buffer.concat([d.update(data), d.final()]));
    const name = file.replace(/\.enc$/, '').replace(/\.gz$/, '');
    fs.writeFileSync(name, out);
    console.log('Done ->', name, `(${(out.length / 1048576).toFixed(2)} MB)`);
} catch (e) { console.log('Wrong password or damaged file.'); process.exit(1); }
