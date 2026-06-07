/**
 * Cloudflare Worker — Beaufort AI API Proxy
 * 
 * Proxies requests from beaufortai.ai to private Pi @ 192.168.1.226:5000
 * Only works if gateway/tailscale has access to internal network.
 * 
 * Deploy: wrangler deploy
 * Route: beaufortai.ai/api/*
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Only proxy /api/sensors and /api/beau
    if (!url.pathname.match(/^\/api\/(sensors|beau)$/)) {
      return new Response('Not found', { status: 404 });
    }

    // Reconstruct internal URL
    const internalUrl = `http://192.168.1.226:5000${url.pathname}`;
    
    try {
      const response = await fetch(internalUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        cf: {
          mirage: false,
          minify: { javascript: false, css: false, html: false },
          cacheEverything: false,
          cacheTtl: 0,
        }
      });

      // Clone response and add CORS headers
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', 'https://beaufortai.ai');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      
      return newResponse;
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: 'Pi unreachable',
          message: error.message,
          timestamp: new Date().toISOString()
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};
