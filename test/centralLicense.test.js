const test = require('node:test');
const assert = require('node:assert/strict');
const license = require('../utils/centralLicense');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('central license uses the registered JPW product code by default', () => {
  assert.equal(license.PRODUCT_CODE, 'JPW');
});
test('domain normalization matches the central portal contract', () => {
  assert.equal(license.normalizeDomain('WWW.Example.com:443'), 'example.com');
});
test('license lock exposes only health and activation recovery routes', () => {
  assert.match(source, /app\.get\('\/license'/);
  assert.match(source, /app\.post\('\/api\/license\/activate'/);
  assert.match(source, /app\.post\('\/api\/license\/verify'/);
  assert.match(source, /app\.use\(centralLicense\.licenseGate/);
});
test('background bots and queue are started only after successful license check', () => {
  assert.match(source, /global\.__JPW_LICENSE_ACTIVE !== true/);
  assert.match(source, /Central license verification failed; application remains locked/);
});
test('central client calls activate and verify endpoints without shipping HMAC secret', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'utils', 'centralLicense.js'), 'utf8');
  assert.match(client, /\/licenses\/activate/);
  assert.match(client, /\/licenses\/verify/);
  assert.doesNotMatch(client, /marketplace_api_secret|TAKNA_LICENSE_SHARED_SECRET/);
});
