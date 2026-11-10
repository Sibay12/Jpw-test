# JPW v2.16.1 — Fresh Setup Guide (No Legacy Data)

## Important scope
This procedure creates a new, empty MongoDB database. It does **not** copy customers, orders, wallet balances, payment records, Telegram sessions, WhatsApp sessions, or settings from v2.16.0/v2.16.1 databases. Keep the original ZIP and database backups separately.

The current v2.16.1 code still has a legacy single-workspace UI/API alongside a partial tenant API. The initializer creates the `main` platform workspace record so the fresh installation has a known owner/workspace. It does not magically complete tenant-aware UI, tenant-specific payment gateways, subscription billing, tenant-specific bot sessions, quotas, or all tenant-owned collections. Do not sell this build as a fully isolated commercial multi-tenant SaaS until those items are implemented and integration-tested.

## 1. Create accounts and a dedicated database
1. Create a MongoDB Atlas project and a new cluster.
2. Create a database user with a strong unique password.
3. Restrict Network Access to the smallest practical allow-list. If your Render plan does not provide stable outbound IPs, use the narrowest supported network policy and compensate with a dedicated DB user, TLS, strong password, and least privilege.
4. Create a dedicated database named `jpw_production` (or `jpw_staging` for staging). Put that database name in the MongoDB connection URI. Never use `admin`, `local`, or `config`.
5. Do not point this setup at any database containing existing data.

## 2. Generate secrets
Run locally:

```bash
node -e "console.log('DATA_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('INTERNAL_API_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
```

Store each output in a password manager and Render Environment. Never commit secrets or send them in chat. Keep `DATA_ENCRYPTION_KEY` permanently; losing/changing it makes encrypted target credentials unreadable.

## 3. Configure Render Environment
Copy `.env.example` values into Render > Web Service > Environment. Set at minimum:
- `NODE_ENV=production`
- `PORT` (Render supplies this automatically; do not hard-code a different port)
- `MONGO_URI` (dedicated fresh database)
- `ADMIN_SECRET_PASS` (long random admin password)
- `SESSION_SECRET`
- `INTERNAL_API_SECRET`
- `DATA_ENCRYPTION_KEY`
- `PLATFORM_OWNER_EMAIL`
- `CORS_ORIGINS` (comma-separated exact origins; use your actual site origins, no trailing slash)
- `SERVER_PUBLIC_URL` (your actual HTTPS service URL)

Add Telegram, WhatsApp, payment provider, Google Sheet and backup variables only when you have configured those integrations. Do not put placeholder values in production. Never commit `.env`.

## 4. Install and initialize the empty database
On a local machine with Node.js 18+:

```bash
npm install
```

Create a local `.env` from `.env.example` using the same dedicated fresh DB URI and secrets (do not commit it). Set:

```env
FRESH_DB_CONFIRM=JPW_FRESH_EMPTY_DATABASE
PLATFORM_OWNER_EMAIL=owner@example.com
PLATFORM_OWNER_NAME=Platform Owner
```

Then run exactly once:

```bash
npm run setup:fresh
```

The script refuses to run unless the confirmation phrase is exact, the database name is dedicated, and every existing non-system collection is empty. If any collection has documents, it stops without modifying records. It creates only the initial `main` workspace/subscription metadata. On first server startup, Mongoose creates the app's remaining collections and schema indexes.

After successful initialization, remove `FRESH_DB_CONFIRM` from all environments. Do not run `setup:fresh` against production again.

## 5. GitHub and Render deployment
1. Upload the extracted project to a new private GitHub repository.
2. Confirm `.env`, `node_modules`, logs, and session files are excluded.
3. Commit `package.json` and (after `npm install`) `package-lock.json` together.
4. In Render create a new Web Service connected to this repository.
5. Build command: `npm install` for this archive because no lockfile is included. After running `npm install` and reviewing the generated `package-lock.json`, commit it and change the Render build command to `npm ci`.
6. Start command: `npm start`.
7. Set all required Render Environment variables.
8. Deploy and inspect logs. Confirm MongoDB connected and `/health` returns HTTP 200.

## 6. Fresh-install smoke tests
- Open `/`, `/admin`, `/app`, `/reseller`, and `/health`.
- Authenticate to Admin with `ADMIN_SECRET_PASS`.
- Register and log in a test customer.
- Confirm new collections and indexes appear in Atlas.
- Test package display and a non-money test order only after confirming the destination gateway is a sandbox/test endpoint.
- Test each payment method in provider sandbox mode; never credit real wallets using screenshots alone.
- Test Telegram and WhatsApp sessions with test accounts and permitted use.
- Test backup and restore into a separate disposable database.

## 7. Deployment blockers / SaaS launch gate
The v2.16.1 source audit records that full tenant-aware UI, tenant-specific payment settings/webhook secrets, subscription billing, tenant-specific Telegram/WhatsApp sessions, tenant admin roles, quota enforcement, and tenant scoping for all operational collections are not complete. The tenant API currently covers only a limited set of register/login/profile/order-history/payment-history routes. Keep tenant onboarding and tenant financial actions disabled for commercial customers until Phase 6+ implementation and cross-tenant integration/penetration tests pass.

## 8. Rollback
Keep v2.16.0 and v2.16.1 archives and database backups. A fresh install can be rolled back by redeploying the previous source against its own compatible database backup. Do not point an older application build at a database whose schema or encrypted fields have been changed unless a tested rollback plan exists.
