/**
 * Cloudflare Worker — Beaufort AI API Proxy
 * 
 * Proxies requests from beau.beaufort-ai.com/api/beau to DGX server
 * DGX API: http://100.117.159.103:5001/api/beau (via Tailscale)
 * 
 * Deploy: wrangler deploy
 * Route: beau.beaufort-ai.com/api/beau
 */

const DGX_API_URL = 'http://100.117.159.103:5001/api/beau';
const TIMEOUT_MS = 10000;

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('OK', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Only POST allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      // Parse incoming request
      const body = await request.text();
      
      // Proxy to DGX API
      const response = await fetch(DGX_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        cf: {
          mirage: false,
          cacheTtl: 0,
          cacheEverything: false,
        },
      });

      // Get response and add CORS headers
      const responseBody = await response.json();
      return new Response(JSON.stringify(responseBody), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          status: 'error',
          error: {
            code: 'PROXY_ERROR',
            message: `DGX API unreachable: ${error.message}`,
          },
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  }
};
