// Beaufort AI — NDBC CORS Proxy Worker
// Deploy to Cloudflare Workers (free tier, 100k requests/day)
// Routes: /42001 or /buoy/42001 → NDBC data for buoy 42001

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/(\d{5})/);
    const buoyId = match ? match[1] : null;

    if (!buoyId) {
      return new Response('Invalid buoy ID', { status: 400, headers: CORS_HEADERS });
    }

    const ndbcUrl = `https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`;

    try {
      const resp = await fetch(ndbcUrl, {
        headers: { 'User-Agent': 'BeaufortAI/1.0 (beaufortai.pages.dev)' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });

      if (!resp.ok) {
        return new Response(`Upstream error ${resp.status}`, {
          status: resp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
        });
      }

      const text = await resp.text();

      return new Response(text, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        },
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
      });
    }
  },
};
