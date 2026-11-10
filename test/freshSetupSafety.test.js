const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'init-fresh-db.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('fresh setup requires explicit one-time confirmation and owner email', () => {
  assert.match(script, /FRESH_DB_CONFIRM/);
  assert.match(script, /JPW_FRESH_EMPTY_DATABASE/);
  assert.match(script, /PLATFORM_OWNER_EMAIL/);
});

test('fresh setup refuses databases outside the dedicated jpw_ namespace', () => {
  assert.match(script, /\^jpw_\[a-z0-9_-\]\+\$/i);
});

test('fresh setup refuses any existing non-empty collection', () => {
  assert.match(script, /estimatedDocumentCount\(\)/);
  assert.match(script, /contains \$\{count\} documents/);
});

test('fresh setup is available as a package command', () => {
  assert.equal(pkg.scripts['setup:fresh'], 'node scripts/init-fresh-db.js');
});
