'use strict';

const crypto = require('crypto');
const { encryptSensitive, decryptSensitive } = require('./fieldEncryption');

// Fixed product endpoint/configuration. These are identifiers, not secrets.
// Keep this file server-side; do not expose it through static/public assets.
const API_BASE = 'http://license.takna.online/api/v1';
const PRODUCT_CODE = 'JPW';
const VERIFY_INTERVAL_MS = Math.max(60_000, Number(process.env.LICENSE_VERIFY_INTERVAL_MS || 6 * 60 * 60 * 1000));
const REQUEST_TIMEOUT_MS = 15_000;

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
}
function getDomain(req) {
  // Express trust-proxy is configured by the application; hostname excludes the port.
  return normalizeDomain(req.hostname || req.headers.host || '');
}
function assertConfig() {
  const u = new URL(API_BASE);
  if (u.protocol !== 'http:') throw new Error('Central license API must use HTTP.');
  if (!/^[A-Z0-9_-]{2,40}$/.test(PRODUCT_CODE)) throw new Error('Built-in license product code is invalid.');
}
async function callCentral(path, payload) {
  assertConfig();
  if (!path.startsWith('/licenses/')) throw new Error('Invalid central license API path.');
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let raw = '';
  try {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error'
      });
    } catch (networkError) {
      const rootCause = networkError && (networkError.cause || networkError);
      const causeCode = rootCause && rootCause.code ? rootCause.code : (networkError && networkError.code);
      const cause = causeCode ? ` (${causeCode})` : '';
      const detail = controller.signal.aborted
        ? `Central license server timed out after ${REQUEST_TIMEOUT_MS} ms.`
        : `Cannot connect to Central License Server at ${new URL(API_BASE).host}${cause}. Check Render outbound network, DNS and the portal's HTTP certificate.`;
      const err = new Error(detail);
      err.code = causeCode || (controller.signal.aborted ? 'ETIMEDOUT' : 'ECONNECT');
      err.cause = networkError;
      throw err;
    }
    raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    if (!data || typeof data !== 'object') {
      throw new Error(`Central License Server returned non-JSON response (HTTP ${response.status}). Check PHP endpoint and hosting rewrite configuration.`);
    }
    if (!response.ok || data.success !== true || data.active !== true || data.status !== 'ACTIVE') {
      const message = String(data.message || `Central license server rejected the request (HTTPS ${response.status}).`).slice(0, 300);
      const err = new Error(message); err.statusCode = response.status; err.centralStatus = data.status || 'UNVERIFIED'; throw err;
    }
    // The deployed central v1 API returns license.features; an empty list is
    // valid for a product/license with no feature rows configured yet.
    if (!data.license || !Array.isArray(data.license.features)) {
      throw new Error('Central license response is missing license.features. Confirm the deployed portal API version.');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function getInstallation(db) {
  const col = db.collection('productlicenseinstallations');
  let doc = await col.findOne({ _id: PRODUCT_CODE });
  if (doc && doc.installationId) return doc.installationId;
  const candidate = crypto.randomUUID();
  try {
    await col.updateOne(
      { _id: PRODUCT_CODE },
      { $setOnInsert: { installationId: candidate, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  doc = await col.findOne({ _id: PRODUCT_CODE });
  if (!doc || !doc.installationId) throw new Error('Could not create a persistent license installation ID.');
  return doc.installationId;
}
async function activate(db, req, licenseKey, owner) {
  const key = String(licenseKey || '').trim();
  const domain = getDomain(req);
  if (key.length < 12 || key.length > 200) throw new Error('Enter a valid license key.');
  if (!domain) throw new Error('Could not determine this installation domain.');
  const installationId = await getInstallation(db);
  const data = await callCentral('/licenses/activate', {
    product: PRODUCT_CODE,
    licenseKey: key,
    installationId,
    domain,
    owner: String(owner || '').trim().slice(0, 160)
  });
  await db.collection('productlicenses').updateOne(
    { _id: PRODUCT_CODE },
    { $set: {
      product: PRODUCT_CODE,
      licenseKeyEncrypted: encryptSensitive(key),
      domain,
      installationId,
      status: 'ACTIVE',
      customer: String(data.license.customer || ''),
      expiresAt: data.license.expiresAt || null,
      features: data.license.features,
      lastVerifiedAt: new Date(),
      activatedAt: new Date(),
      updatedAt: new Date()
    } },
    { upsert: true }
  );
  return { status: 'ACTIVE', customer: data.license.customer || '', expiresAt: data.license.expiresAt || null, features: data.license.features };
}
async function verifyStored(db, req, force = false) {
  const col = db.collection('productlicenses');
  const saved = await col.findOne({ _id: PRODUCT_CODE });
  if (!saved || !saved.licenseKeyEncrypted) {
    return { active: false, message: saved && saved.status ? `License status: ${saved.status}` : 'A license key is required.' };
  }
  const now = Date.now();
  const last = saved.lastVerifiedAt ? new Date(saved.lastVerifiedAt).getTime() : 0;
  if (!force && saved.status === 'ACTIVE' && last && now - last < VERIFY_INTERVAL_MS) {
    if (saved.expiresAt && new Date(saved.expiresAt).getTime() < now) return { active: false, message: 'License has expired.' };
    return { active: true, cached: true, features: saved.features || [] };
  }
  const key = decryptSensitive(saved.licenseKeyEncrypted);
  if (!key) return { active: false, message: 'Stored license key could not be decrypted. Check DATA_ENCRYPTION_KEY.' };
  const domain = getDomain(req);
  const installationId = saved.installationId || await getInstallation(db);
  try {
    const data = await callCentral('/licenses/verify', { product: PRODUCT_CODE, licenseKey: key, installationId, domain });
    await col.updateOne({ _id: PRODUCT_CODE }, { $set: {
      status: 'ACTIVE', domain, installationId,
      customer: String(data.license.customer || ''),
      expiresAt: data.license.expiresAt || null,
      features: data.license.features,
      lastVerifiedAt: new Date(), updatedAt: new Date()
    } });
    return { active: true, cached: false, features: data.license.features };
  } catch (e) {
    const newStatus = ['SUSPENDED', 'REVOKED', 'EXPIRED', 'INVALID'].includes(String(e.centralStatus || '').toUpperCase())
      ? String(e.centralStatus).toUpperCase() : 'UNVERIFIED';
    await col.updateOne({ _id: PRODUCT_CODE }, { $set: { status: newStatus, lastVerificationError: String(e.message).slice(0, 300), updatedAt: new Date() } });
    return { active: false, message: `License verification failed: ${e.message}` };
  }
}
function isLicenseExempt(req) {
  const p = req.path || '';
  return p === '/health' || p === '/license' ||
    p === '/api/license/activate' || p === '/api/license/status' || p === '/api/license/verify';
}
function licenseGate(dbGetter) {
  return async (req, res, next) => {
    if (isLicenseExempt(req)) return next();
    try {
      const db = dbGetter();
      if (!db) return res.status(503).json({ success: false, licenseRequired: true, message: 'Database is not ready for license verification.' });
      const result = await verifyStored(db, req, false);
      if (result.active) return next();
      if (req.path.startsWith('/api/')) {
        return res.status(423).json({ success: false, licenseRequired: true, message: result.message, activateUrl: '/license' });
      }
      return res.status(423).sendFile(require('path').join(__dirname, '..', 'public', 'license.html'));
    } catch (e) {
      return res.status(503).json({ success: false, licenseRequired: true, message: `License check unavailable: ${String(e.message).slice(0, 200)}` });
    }
  };
}
module.exports = { PRODUCT_CODE, activate, verifyStored, licenseGate, getDomain, normalizeDomain };
