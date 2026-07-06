# Beau Feedback Worker

Cloudflare Worker that powers the dashboard's "Flag Issue" widget. Accepts
operator-submitted bug reports / wrong-answer flags and emails them to
`piratefarmer2@gmail.com` (same inbox used for photo/video submissions)
using Cloudflare's native `send_email` binding — no third-party email API
key, no MailChannels, no DNS changes needed.

- **Deployed URL**: `https://beau-feedback.capt-barrett.workers.dev`
- **Called from**: `dashboard.html` (`FEEDBACK_API_URL` constant, `submitFlagIssue()`)
- **Sender address**: `feedback@beaufortai.ai` (routes via beaufortai.ai's
  existing Cloudflare Email Routing config — same one that already forwards
  `submissions@beaufortai.ai` to piratefarmer2@gmail.com)

## Deploy

```bash
cd feedback-worker
export CLOUDFLARE_API_TOKEN="<token with Workers edit permission>"
export CLOUDFLARE_ACCOUNT_ID="e40994912d6ab9356321c6157756df35"
npm install
wrangler deploy
```

## CORS

`ALLOWED_ORIGINS` in `worker.js` is a hard allowlist of production origins
(beaufortai.ai, beau.beaufort-ai.com and their www/http variants). Requests
from any other origin still send the email server-side (this is a public
POST endpoint, not auth-gated) but the browser will refuse to expose the
JSON response due to the CORS header not matching — this is intentional
and matches Cap's existing api-beau-proxy pattern (`Access-Control-Allow-Origin: *`
on that one, tighter allowlist here since this one sends real email).

## Testing history (2026-07-06)

Verified end-to-end with Playwright before going live:
- Modal open/close (general / sensor / QA flag buttons)
- Category defaults per source
- Empty-comment client-side validation
- Real submit → Worker → send_email → landed in piratefarmer2@gmail.com inbox (confirmed via gog gmail search)
- Modal auto-closes on success
- CORS allowlist confirmed to reject non-production origins (server-side send still happens, browser can't read the response)
