// Beaufort AI — NDBC CORS Proxy Worker
// Deploy to Cloudflare Workers (free tier, 100k requests/day)
// Routes: /buoy/42001 → NDBC data for buoy 42001

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const buoyId = url.pathname.replace('/buoy/', '').replace('/', '');

    if (!buoyId || !/^\d{5}$/.test(buoyId)) {
      return new Response('Invalid buoy ID', { status: 400 });
    }

    const ndbcUrl = `https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`;

    try {
      const resp = await fetch(ndbcUrl, {
        headers: { 'User-Agent': 'BeaufortAI/1.0 (beaufortai.pages.dev)' }
      });

      const text = await resp.text();

      return new Response(text, {
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300', // Cache 5 min
        }
      });
    } catch(e) {
      return new Response(`Error: ${e.message}`, { status: 502 });
    }
  }
};
