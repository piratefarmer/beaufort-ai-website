#!/usr/bin/env node
/**
 * Deploy Cloudflare Worker directly via API
 * No wrangler needed, uses API token directly
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = process.env.ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WORKER_NAME = 'beaufort-ai-api';

if (!API_TOKEN) {
  console.error('❌ CLOUDFLARE_API_TOKEN not set');
  process.exit(1);
}

// Read worker script
const workerScript = fs.readFileSync(path.join(__dirname, 'src/api-proxy-worker.js'), 'utf8');

console.log('📤 Deploying Cloudflare Worker...');
console.log(`   Token: ${API_TOKEN.substring(0, 10)}...${API_TOKEN.substring(-10)}`);
console.log(`   Worker: ${WORKER_NAME}`);

// Try to get account ID from .wrangler/state.json first
let accountId = ACCOUNT_ID;
if (!accountId) {
  try {
    const state = JSON.parse(fs.readFileSync(path.expandUser('~/.wrangler/state.json'), 'utf8'));
    if (state.auth?.accounts?.[0]?.id) {
      accountId = state.auth.accounts[0].id;
      console.log(`   Using account ID from .wrangler: ${accountId}`);
    }
  } catch (e) {
    // Silently skip
  }
}

if (!accountId) {
  console.error('❌ Could not determine Cloudflare account ID');
  console.error('   Set ACCOUNT_ID env var or login via: wrangler login');
  process.exit(1);
}

// Deploy via API
const options = {
  hostname: 'api.cloudflare.com',
  port: 443,
  path: `/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}`,
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/javascript',
    'Content-Length': Buffer.byteLength(workerScript)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.success) {
        console.log(`✅ Worker deployed successfully!`);
        console.log(`   URL: https://${WORKER_NAME}.beaufortai.ai`);
        process.exit(0);
      } else {
        console.error('❌ Deployment failed:');
        console.error(JSON.stringify(json.errors, null, 2));
        process.exit(1);
      }
    } catch (e) {
      console.error('❌ Invalid API response:', data);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request failed:', e.message);
  process.exit(1);
});

req.write(workerScript);
req.end();
