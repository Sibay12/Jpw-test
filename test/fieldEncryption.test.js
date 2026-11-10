const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptSensitive, decryptSensitive } = require('../utils/fieldEncryption');

test('encrypts and decrypts sensitive credentials', () => {
  const encrypted = encryptSensitive('customer-secret-123');
  assert.match(encrypted, /^enc:v1:/);
  assert.notEqual(encrypted, 'customer-secret-123');
  assert.equal(decryptSensitive(encrypted), 'customer-secret-123');
});

test('keeps legacy plaintext records readable during migration', () => {
  assert.equal(decryptSensitive('legacy-password'), 'legacy-password');
});

test('does not double-encrypt an already encrypted value', () => {
  const first = encryptSensitive('same-value');
  assert.equal(encryptSensitive(first), first);
});
