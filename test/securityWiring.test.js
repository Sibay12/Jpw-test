const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('payment verification requires customer authentication', () => {
  assert.match(source, /app\.post\('\/api\/verify-instant', requireUser,/);
  assert.match(source, /app\.get\('\/api\/verify-db-status\/:orderId', requireUser,/);
});

test('webhook enforces payment method, amount and no-success-downgrade rule', () => {
  assert.match(source, /paymentRecord\.paymentMethod !== 'teknapay'/);
  assert.match(source, /Number\(paymentRecord\.amount\) !== amount/);
  assert.match(source, /if \(paymentRecord\.status === 'SUCCESS'\) return res\.json/);
});

test('tenant-owned collections install tenant isolation middleware', () => {
  assert.match(source, /applyTenantIsolation\(userSchema\)/);
  assert.match(source, /applyTenantIsolation\(orderSchema\)/);
  assert.match(source, /applyTenantIsolation\(paymentSchema\)/);
  assert.match(source, /applyTenantIsolation\(gatewayQueueSchema\)/);
  assert.match(source, /applyTenantIsolation\(usedUtrSchema\)/);
});
