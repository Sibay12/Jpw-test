# JPW Phase 3 — Configurable Gateway Reply Rules

## Included
- Admin-only GET/POST endpoints: `/api/admin/gateway-reply-rules`.
- Persisted settings use the existing `Setting` collection and the `gatewayReplyRules` key.
- Up to 30 configurable rules; first enabled match wins.
- `exact` and `contains` matching modes.
- Classifications: `success_candidate`, `failure_candidate`, `in_progress`, `unclassified`.
- Optional regular-expression extraction with capture-group support.
- Optional customer-facing status messages delivered through the configured Telegram customer bot.
- Customer notifications are disabled by default.
- Admin reply history displays matched rule, extracted value and notification delivery result.

## Rule format
Each rule supports:
- `id`: stable identifier.
- `enabled`: boolean.
- `keyword`: text to match.
- `matchMode`: `exact` or `contains`.
- `classification`: one of the supported classifications.
- `customerMessage`: optional message template; supports `{targetId}`, `{status}`, `{extracted}`.
- `extractPattern`: optional JavaScript regular expression; capture group 1 is preferred.
- `extractLabel`: optional label shown beside the extracted value.

## Safety boundaries
- Rules do not automatically change order status, approve payment, issue refunds or mark work complete.
- Customer notifications are opt-in and off by default.
- Existing safe order correlation remains in place.
- Invalid regular expressions are rejected at save time.
- Only authorized admin endpoints can read or update rule settings.

## Deployment note
This update is source-only. Validate against a staging copy or controlled test account before deploying to the live Render service. Confirm Telegram customer-bot access and review customer message wording before enabling notifications.
