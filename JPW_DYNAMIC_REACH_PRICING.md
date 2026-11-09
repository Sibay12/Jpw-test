# JPW — Dynamic Reach Pricing & Finite Packages

## What is now configurable
The Admin Panel > Offers tab now contains a Reach Pricing & Package Manager with two channel-specific package lists:
- Website & WhatsApp: preserves the existing web defaults (₹13 for 1, ₹60 for 5, ₹115 for 10, ₹210 for 20, ₹400 for 40).
- Telegram Referral Bot: preserves the existing bot defaults (₹20 for 1, ₹55 for 3, ₹105 for 7, ₹210 for 15).

For each channel, the administrator can change the base price per Reach, add packages, edit Reach/Coin quantities and package prices, remove packages, and save the configuration. Telegram Referral Bot package rows also retain an editable referral commission amount.

## Runtime behavior
- Pricing is persisted in MongoDB using the `reach_pricing_v1` setting.
- Configuration is loaded on server startup.
- Website/customer app package list reads from `/api/packages`.
- Telegram Referral Bot package list reads from `/api/external/v1/packages`.
- WhatsApp recharge menu uses the same Website & WhatsApp package configuration.
- Payment package validation uses the active server-side package list; client-submitted prices/quantities are not trusted.
- Referral commission is read from the configured Telegram package rather than hard-coded quantity tiers.
- Promotional offer packages remain separately configurable and are now validated as finite whole-number Reach/Coin quantities.

## Finite-only rules
- At least one and at most 30 packages per channel.
- Each package must contain a whole-number quantity from 1 to 100,000.
- Each package price must be a positive whole INR amount up to ₹1 crore.
- Duplicate Reach quantities within the same channel are rejected.
- Unlimited packages, non-numeric quantities, zero quantities, fractional Reach counts and unlimited wallet grants are rejected.
- Internal bot approval also rejects non-finite or out-of-range coin grants.

## Existing balances and selected accounts
Changing the package catalogue affects future purchases only. Existing paid wallet balances and historical payments are not silently changed.
The legacy Selected Users workflow is a separate admin-managed usage-billing facility (per successful Reach or a fixed daily fee), not a customer-purchasable unlimited package. It remains separate in this update; if the business rule is to discontinue that special workflow as well, it needs a dedicated migration so pending bills and existing selected accounts are not lost.

## Validation
- `node --check server.js`
- `node --check` for all inline JavaScript blocks in `public/admin.html`
- ZIP integrity check
- No live Render deployment or payment-gateway transaction was performed.
