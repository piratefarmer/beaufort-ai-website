# beau-contact worker

Receives homepage "Get In Touch" contact-card submissions and emails them to
piratefarmer2@gmail.com via Cloudflare's native `send_email` binding (same
proven pattern as the sibling `feedback-worker`).

## Deploy

```
cd contact-worker
npm install
npx wrangler deploy
```

Requires `CLOUDFLARE_API_TOKEN` env var with Workers + Email Routing
permissions for the account (same token used for feedback-worker deploys).

## Endpoint

`POST https://beau-contact.<subdomain>.workers.dev/`

```json
{
  "name": "optional",
  "email": "required, sender's reply-to address",
  "company": "optional, vessel/operator/company name",
  "message": "required, free-text inquiry",
  "page_url": "optional, which page this came from"
}
```

CORS is locked to beaufortai.ai / beau.beaufort-ai.com origins in
`worker.js` — update `ALLOWED_ORIGINS` there if new domains are added.
