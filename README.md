# JPW v2.16.1 — Clean Fresh Installation

This archive contains the application source and only the files required to install, configure, test, and deploy a fresh JPW instance.

## Quick start
1. Extract this ZIP.
2. Read `FRESH_SETUP_GUIDE_EN.md` completely.
3. Create a brand-new empty MongoDB database named `jpw_staging` first.
4. Configure secrets and environment variables using `.env.example`.
5. Run `npm install`.
6. Set `FRESH_DB_CONFIRM=JPW_FRESH_EMPTY_DATABASE` and `PLATFORM_OWNER_EMAIL` in a local `.env`.
7. Run `npm run setup:fresh` exactly once against the empty staging database.
8. Remove `FRESH_DB_CONFIRM`, upload the extracted folder to a new private GitHub repository, and deploy a new Render Web Service.
9. Complete all staging tests before creating a separate production database.

## Important
- No legacy customer, order, wallet, payment, or session data is imported.
- Never commit `.env`, credentials, session files, logs, or `node_modules`.
- This source is **not yet a fully production-ready commercial multi-tenant SaaS**. Full tenant-aware UI, tenant-specific payment/gateway configuration, billing, quotas, and complete isolation tests remain launch gates.
- Do not enable real customer payments or commercial tenant onboarding until those launch gates pass.

## Commands
```bash
npm install
npm test
npm run setup:fresh
npm start
```

For the full instructions, see `FRESH_SETUP_GUIDE_EN.md`.

## Central license activation
This package is protected by the TAKNA Central License Portal. The Central API URL and product code `JPW` are built into the backend. Configure `LICENSE_DOMAIN` if required and a stable `DATA_ENCRYPTION_KEY` in Render. Register product `JPW` as ACTIVE in the central portal's Product & Feature Registry, create a license, deploy JPW, then open `/license` and enter the license key. See `LICENSE-INTEGRATION.md` for the exact setup and test procedure. The application remains locked if central verification fails.
