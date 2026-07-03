#!/bin/bash
# Run this script with: bash DEPLOY_WHEN_TOKEN.sh YOUR_CF_TOKEN
CF_TOKEN="${1}"
if [ -z "$CF_TOKEN" ]; then
  echo "Usage: bash DEPLOY_WHEN_TOKEN.sh <cloudflare_api_token>"
  exit 1
fi

cd "$(dirname "$0")"
echo "Deploying to Cloudflare Pages..."
CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
CLOUDFLARE_ACCOUNT_ID="e40994912d6ab9356321c6157756df35" \
npx wrangler pages deploy . --project-name beaufortai --commit-dirty=true
echo "Done! Check https://beaufortai.ai"
