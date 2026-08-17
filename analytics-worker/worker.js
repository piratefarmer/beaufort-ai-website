import { DASHBOARD_HTML } from "./dashboard_html.js";

/**
 * Beau site analytics — city-level visit log + edge beacon injection.
 * Uses Cloudflare request.cf geo (country/city/region/colo).
 *
 * Analytics host (analytics.beaufortai.ai / workers.dev):
 *   POST /v
 *   GET  /report?days=7
 *   GET  /offices?days=30
 *   GET  /health
 *   GET  /beacon.js
 *
 * Main site hosts (beaufortai.ai / www):
 *   serves /js/analytics-beacon.js
 *   injects beacon script into HTML responses
 */
const ALLOWED_ORIGINS = new Set([
  "https://beaufortai.ai",
  "https://www.beaufortai.ai",
  "https://beau.beaufort-ai.com",
  "https://www.beaufort-ai.com",
  "https://beaufortai.pages.dev",
]);

const ANALYTICS_HOSTS = new Set([
  "analytics.beaufortai.ai",
  "beau-analytics.capt-barrett.workers.dev",
]);

const SITE_HOSTS = new Set([
  "beaufortai.ai",
  "www.beaufortai.ai",
]);

const BEACON_TAG =
  '<script src="/js/analytics-beacon.js?v=20260801a" defer></script>';

// Cap harden 2026-08-01: baseline security headers for all site responses.
// CSP intentionally allows current dashboard third-parties (Google Fonts,
// RainViewer tiles/API, Beau/Fleet APIs). Tighten further only after audit.
function securityHeaders() {
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "script-src 'self' 'unsafe-inline' https://api.rainviewer.com",
      "connect-src 'self' https://beaufortai.ai https://www.beaufortai.ai https://analytics.beaufortai.ai https://beau-analytics.capt-barrett.workers.dev https://beau.beaufort-ai.com https://beau.beaufortai.ai https://fleet.beaufortai.ai https://beau-fleet.capt-barrett.workers.dev https://api.rainviewer.com https://tilecache.rainviewer.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://mapservices.weather.noaa.gov https://fonts.googleapis.com https://fonts.gstatic.com",
      "worker-src 'self' blob:",
      "media-src 'self' blob: data:",
      "upgrade-insecure-requests",
    ].join("; "),
  };
}

function withSecurityHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  const sec = securityHeaders();
  for (const [k, v] of Object.entries(sec)) headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  // HTML pages do not need wide-open CORS.
  if ((headers.get("content-type") || "").includes("text/html")) {
    headers.delete("Access-Control-Allow-Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const BEACON_JS = `/* Beau city-level analytics beacon */
(function () {
  try {
    var host = location.hostname || "";
    if (
      host !== "beaufortai.ai" &&
      host !== "www.beaufortai.ai" &&
      host !== "beau.beaufort-ai.com" &&
      host !== "www.beaufort-ai.com" &&
      host.indexOf("beaufortai.pages.dev") === -1
    ) {
      return;
    }
    var ENDPOINTS = [
      "https://analytics.beaufortai.ai/v",
      "https://beau-analytics.capt-barrett.workers.dev/v"
    ];
    var payload = {
      path: location.pathname + location.search,
      title: document.title || "",
      referrer: document.referrer || "",
      page_url: location.href,
      ts: new Date().toISOString()
    };
    var body = JSON.stringify(payload);
    function send(url) {
      if (navigator.sendBeacon) {
        try {
          return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        } catch (e) {}
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      }).catch(function () {});
      return true;
    }
    if (!send(ENDPOINTS[0])) send(ENDPOINTS[1]);
  } catch (e) {}
})();
`;

// Known office / interest locations
const OFFICE_RULES = [
  {
    tag: "US_OFFICE_CUTOFF",
    label: "US office area (Cut Off / Lafourche)",
    country: "US",
    cities: [
      "cut off",
      "cutoff",
      "fourchon",
      "port fourchon",
      "galliano",
      "larose",
      "lockport",
      "golden meadow",
      "raceland",
      "thibodaux",
      "houma",
      "leeville",
    ],
    regions: ["louisiana", "la"],
    requireCityForRegion: true,
  },
  {
    tag: "BRAZIL_OFFICE",
    label: "Brazil office area",
    country: "BR",
    cities: [
      "macae",
      "macaé",
      "rio de janeiro",
      "niteroi",
      "niterói",
      "vitoria",
      "vitória",
      "campos",
      "campos dos goytacazes",
      "sao joao da barra",
      "são joão da barra",
      "itaguai",
      "itaguaí",
    ],
    regions: ["rio de janeiro", "espirito santo", "espírito santo"],
    countryOnlyTag: "BRAZIL_COUNTRY",
  },
];

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://beaufortai.ai";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Analytics-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin || ""),
      ...securityHeaders(),
    },
  });
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function norm(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function classifyOffice(country, city, region) {
  const c = String(country || "").toUpperCase();
  const cityN = norm(city);
  const regionN = norm(region);
  const tags = [];

  for (const rule of OFFICE_RULES) {
    if (rule.country && c !== rule.country) continue;

    let cityHit = false;
    if (cityN && rule.cities) {
      cityHit = rule.cities.some((x) => cityN === norm(x) || cityN.includes(norm(x)));
    }

    let regionHit = false;
    if (regionN && rule.regions) {
      regionHit = rule.regions.some((x) => regionN === norm(x) || regionN.includes(norm(x)));
    }

    if (cityHit) tags.push(rule.tag);
    else if (regionHit && !rule.requireCityForRegion) tags.push(rule.tag);

    if (rule.countryOnlyTag && c === rule.country) tags.push(rule.countryOnlyTag);
  }

  if (c === "US" && (regionN === "louisiana" || regionN === "la")) {
    tags.push("US_LOUISIANA");
  }

  return [...new Set(tags)];
}

function visitorHash(ip, ua) {
  const raw = `${ip || ""}|${ua || ""}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function appendVisit(env, visit) {
  const day = dayKey(new Date(visit.ts));
  const key = `day:${day}`;
  const existing = await env.BEAU_ANALYTICS.get(key, { type: "json" });
  const arr = Array.isArray(existing) ? existing : [];
  arr.push(visit);
  const trimmed = arr.length > 5000 ? arr.slice(arr.length - 5000) : arr;
  await env.BEAU_ANALYTICS.put(key, JSON.stringify(trimmed), {
    expirationTtl: 60 * 60 * 24 * 120,
  });

  const idxKey = "index:days";
  const idx = (await env.BEAU_ANALYTICS.get(idxKey, { type: "json" })) || [];
  if (!idx.includes(day)) {
    idx.push(day);
    idx.sort();
    const keep = idx.slice(Math.max(0, idx.length - 180));
    await env.BEAU_ANALYTICS.put(idxKey, JSON.stringify(keep));
  }
}

function summarize(events) {
  const byCountry = {};
  const byCity = {};
  const byOffice = {};
  const byPath = {};
  const visitors = new Set();
  const officeVisitors = {};

  for (const e of events) {
    const country = e.country || "ZZ";
    const city = e.city || "(unknown)";
    const region = e.region || "";
    const place = `${city}, ${region || country}`.replace(/, $/, "");
    const path = e.path || "/";
    const vid = e.vid || "anon";

    visitors.add(vid);
    byCountry[country] = (byCountry[country] || 0) + 1;
    byCity[place] = (byCity[place] || 0) + 1;
    byPath[path] = (byPath[path] || 0) + 1;

    for (const tag of e.office_tags || []) {
      byOffice[tag] = (byOffice[tag] || 0) + 1;
      if (!officeVisitors[tag]) officeVisitors[tag] = new Set();
      officeVisitors[tag].add(vid);
    }
  }

  const top = (obj, n = 20) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ key: k, count: v }));

  const office = {};
  for (const [tag, count] of Object.entries(byOffice)) {
    office[tag] = {
      events: count,
      unique_visitors: officeVisitors[tag] ? officeVisitors[tag].size : 0,
    };
  }

  return {
    events: events.length,
    unique_visitors: visitors.size,
    office,
    top_countries: top(byCountry, 15),
    top_cities: top(byCity, 30),
    top_paths: top(byPath, 20),
  };
}

async function loadDays(env, days) {
  const n = Math.max(1, Math.min(120, Number(days) || 7));
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `day:${dayKey(d)}`;
    const arr = await env.BEAU_ANALYTICS.get(key, { type: "json" });
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

function requireAdmin(request, env) {
  const key = request.headers.get("X-Analytics-Key") || "";
  return key && env.ANALYTICS_ADMIN_KEY && key === env.ANALYTICS_ADMIN_KEY;
}

function beaconResponse() {
  return new Response(BEACON_JS, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      // Public static JS; keep readable cross-origin, but no credentials.
      "Access-Control-Allow-Origin": "*",
      ...securityHeaders(),
    },
  });
}

class BodyInjector {
  element(element) {
    element.append(BEACON_TAG, { html: true });
  }
}

async function handleSitePassThrough(request, url) {
  // Serve beacon JS from edge even if Pages deploy is stale
  if (
    url.pathname === "/js/analytics-beacon.js" ||
    url.pathname.startsWith("/js/analytics-beacon.js")
  ) {
    return beaconResponse();
  }

  // Cap 2026-07-31: Pages deploy token lacks scope. Serve fixed dashboard
  // from this Worker (already fronts beaufortai.ai/*) until Pages is fixed.
  if (
    request.method === "GET" &&
    (url.pathname === "/dashboard" ||
      url.pathname === "/dashboard.html" ||
      url.pathname === "/dashboard/")
  ) {
    return withSecurityHeaders(
      new Response(DASHBOARD_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
        },
      })
    );
  }

  const originRes = await fetch(request);
  const ct = originRes.headers.get("content-type") || "";
  if (!ct.includes("text/html") || request.method !== "GET") {
    // Still stamp baseline headers on static assets from origin.
    return withSecurityHeaders(originRes);
  }

  // Avoid double-inject if page already has beacon
  // HTMLRewriter can't easily read full body first; inject once near </body>
  const rewritten = new HTMLRewriter().on("body", new BodyInjector()).transform(originRes);
  return withSecurityHeaders(rewritten);
}

async function handleAnalyticsApi(request, env, url, origin) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname === "/health") {
    return json({ ok: true, service: "beau-analytics" }, 200, origin);
  }

  if (url.pathname === "/beacon.js" || url.pathname === "/js/analytics-beacon.js") {
    return beaconResponse();
  }

  if (url.pathname === "/v" && request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const cf = request.cf || {};
    const country = cf.country || request.headers.get("CF-IPCountry") || "";
    const city = cf.city || "";
    const region = cf.region || cf.regionCode || "";
    const colo = cf.colo || "";
    const timezone = cf.timezone || "";
    const path = String(body.path || body.page_url || "/").slice(0, 300);
    const referrer = String(body.referrer || request.headers.get("Referer") || "").slice(0, 300);
    const title = String(body.title || "").slice(0, 200);
    const ua = (request.headers.get("User-Agent") || "").slice(0, 300);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const vid = visitorHash(ip, ua);
    const office_tags = classifyOffice(country, city, region);

    const visit = {
      ts: new Date().toISOString(),
      path,
      title,
      referrer,
      country,
      city,
      region,
      colo,
      timezone,
      office_tags,
      vid,
    };

    try {
      await appendVisit(env, visit);
    } catch (e) {
      return json({ ok: false, error: "store_failed", detail: String(e) }, 500, origin);
    }

    return json(
      {
        ok: true,
        office_tags,
        geo: { country, city, region, colo },
      },
      200,
      origin
    );
  }

  if ((url.pathname === "/report" || url.pathname === "/offices") && request.method === "GET") {
    if (!requireAdmin(request, env)) {
      return json({ error: "unauthorized" }, 401, origin);
    }
    const days = url.searchParams.get("days") || (url.pathname === "/offices" ? "30" : "7");
    const events = await loadDays(env, days);
    const summary = summarize(events);

    const officeEvents = events
      .filter((e) => (e.office_tags || []).length > 0)
      .slice(-100)
      .map((e) => ({
        ts: e.ts,
        path: e.path,
        country: e.country,
        city: e.city,
        region: e.region,
        office_tags: e.office_tags,
        vid: e.vid,
      }));

    return json(
      {
        ok: true,
        days: Number(days),
        generated_at: new Date().toISOString(),
        summary,
        recent_office_events: officeEvents.reverse(),
        notes: [
          "Geo from Cloudflare edge (request.cf). City accuracy varies by ISP/VPN.",
          "US_OFFICE_CUTOFF matches Cut Off and nearby Lafourche/Terrebonne towns.",
          "BRAZIL_OFFICE matches known RJ/ES office/ops cities; BRAZIL_COUNTRY is any BR hit.",
          "US_LOUISIANA = Louisiana region without exact Cut Off/nearby city match.",
        ],
      },
      200,
      origin
    );
  }

  return json(
    {
      error: "not_found",
      endpoints: ["POST /v", "GET /report", "GET /offices", "GET /health", "GET /beacon.js"],
    },
    404,
    origin
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const host = url.hostname;

    // Main marketing site: inject beacon / serve JS
    if (SITE_HOSTS.has(host)) {
      return handleSitePassThrough(request, url);
    }

    // Analytics API host (and workers.dev)
    if (ANALYTICS_HOSTS.has(host) || host.endsWith(".workers.dev")) {
      return handleAnalyticsApi(request, env, url, origin);
    }

    // Fallback: treat as analytics API
    return handleAnalyticsApi(request, env, url, origin);
  },
};
