/**
 * Cloudflare Worker — Beau API Proxy
 * 
 * Proxies requests from public internet to private DGX API
 * Public: https://api.beaufort-ai.com/beau
 * Private: http://100.117.159.103:5001/api/beau (via Tailscale)
 */

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('OK', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
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
      // Read request body
      const body = await request.text();
      
      // Proxy to DGX API (via Tailscale)
      const response = await fetch('http://100.117.159.103:5001/api/beau', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });

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
      console.error('Proxy error:', error);
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
