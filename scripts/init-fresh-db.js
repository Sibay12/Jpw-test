'use strict';
/**
 * JPW fresh database initializer.
 * This is ONLY for a brand-new, empty MongoDB database. It never imports legacy data.
 * Run: npm run setup:fresh
 * Required: MONGO_URI, FRESH_DB_CONFIRM=JPW_FRESH_EMPTY_DATABASE, PLATFORM_OWNER_EMAIL
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const CONFIRM = 'JPW_FRESH_EMPTY_DATABASE';
function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
async function main() {
  const uri = required('MONGO_URI');
  if (process.env.FRESH_DB_CONFIRM !== CONFIRM) {
    throw new Error(`Refusing to initialize. Set FRESH_DB_CONFIRM=${CONFIRM} only for a brand-new empty database.`);
  }
  const ownerEmail = required('PLATFORM_OWNER_EMAIL').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('PLATFORM_OWNER_EMAIL is not a valid email address.');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: true });
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  if (!/^jpw_[a-z0-9_-]+$/i.test(dbName || '')) {
    throw new Error(`Unsafe database name "${dbName}". Use a dedicated database named jpw_staging or jpw_production in MONGO_URI.`);
  }

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const nonSystem = collections.filter(c => !c.name.startsWith('system.'));
  for (const item of nonSystem) {
    const count = await db.collection(item.name).estimatedDocumentCount();
    if (count > 0) throw new Error(`Database is not empty: collection "${item.name}" contains ${count} documents. Use a new empty database; no data was changed.`);
  }

  const now = new Date();
  const tenantId = 'legacy'; // Preserves the existing single-workspace UI/API namespace.
  const tenantKeyHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const tenants = db.collection('tenants');
  await tenants.insertOne({
    tenantId, slug: 'main', name: process.env.SITE_NAME || 'JPW Main Workspace',
    ownerEmail, ownerName: process.env.PLATFORM_OWNER_NAME || '',
    plan: 'free', status: 'active', tenantKeyHash,
    limits: { maxUsers: 5, maxOrdersPerMonth: 100, maxAdmins: 1 },
    features: { gatewayRouting: false, customBranding: false, apiAccess: false },
    trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: null,
    createdAt: now, updatedAt: now
  });

  const subscriptions = db.collection('tenantsubscriptions');
  await subscriptions.insertOne({ tenantId, plan: 'free', status: 'active', amount: 0, currency: 'INR', billingCycle: 'monthly', startsAt: now, endsAt: null, externalReference: 'fresh-install', notes: 'Initial free main workspace record; no payment collected.', createdAt: now });

  const meta = db.collection('platformmetas');
  await meta.insertOne({ key: 'fresh_setup', version: '2.16.1', databaseName: dbName, initializedAt: now, ownerEmail, dataImported: false });

  console.log(JSON.stringify({ success: true, databaseName: dbName, tenant: 'main', tenantId, importedLegacyData: false, next: 'Start the Render service; Mongoose will create the application collections and schema indexes.' }, null, 2));
}
main().catch(err => { console.error(`Fresh DB setup failed: ${err.message}`); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect().catch(() => {}); });
