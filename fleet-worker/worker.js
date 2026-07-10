/**
 * Beau Fleet Worker (pilot build, feature/fleet-dashboard)
 * ---------------------------------------------------------
 * Real backend for the fleet dashboard: vessel registry, RMC-pushed
 * fleet advisories, and vessel-to-RMC hazard reports. Backed by
 * Cloudflare KV (namespace BEAU_FLEET) for actual persistence —
 * replaces the mock-data arrays that were temporarily hardcoded in
 * dashboard.html during initial UI scaffolding.
 *
 * IMPORTANT — interim auth note (remove/replace in Phase 2):
 * Real RMC login (Cloudflare Access / per-person accounts) is not
 * built yet. Write endpoints (advisory create/clear) are gated with
 * a shared secret header (X-Fleet-Admin-Key) as a stopgap so this
 * isn't a fully open write API on the public internet. This is NOT
 * real access control and must be replaced before RMC-wide rollout.
 *
 * Data model (all stored as JSON in KV):
 *   key "vessels"    -> array of { id, name, role, tunnel_url, added_at }
 *   key "advisories" -> array of { id, severity, title, body, issued_by,
 *                                   created_at, expires_at, active }
 *   key "reports"    -> array of { id, vessel_id, vessel_name, hazard_type,
 *                                   description, position, reported_at,
 *                                   status }
 *
 * Endpoints:
 *   GET  /api/fleet/vessels
 *   GET  /api/fleet/advisories            (only active=true unless ?all=1)
 *   POST /api/fleet/advisories             [admin key required]
 *   POST /api/fleet/advisories/:id/clear   [admin key required]
 *   GET  /api/fleet/reports                [admin key required]
 *   POST /api/fleet/reports                (vessel submits, no auth —
 *                                            open by design, any vessel
 *                                            can report; emails RMC)
 */

import { createMimeMessage } from "mimetext/browser";
import { EmailMessage } from "cloudflare:email";

const ALLOWED_ORIGINS = new Set([
  "https://beaufortai.ai",
  "https://www.beaufortai.ai",
  "https://beau.beaufort-ai.com",
  "https://www.beaufort-ai.com",
  "https://beaufortai.pages.dev",
]);

const HAZARD_TYPES = new Set([
  "Unlit rig / structure",
  "Buoy off station",
  "Drifting debris / trash",
  "Adrift vessel",
  "Weather hazard",
  "Other",
]);

function corsHeaders(origin) {
  // Allow any *.beaufortai.pages.dev preview deployment (branch previews
  // get a new random subdomain each build) in addition to the fixed list.
  const isPreview = /^https:\/\/[a-z0-9-]+\.beaufortai\.pages\.dev$/.test(origin);
  const allowOrigin = (ALLOWED_ORIGINS.has(origin) || isPreview) ? origin : "https://beaufortai.ai";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Fleet-Admin-Key",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function esc(s) {
  return String(s == null ? "" : s).trim();
}

function uid() {
  return crypto.randomUUID();
}

async function getJSON(env, key, fallback) {
  const v = await env.BEAU_FLEET.get(key, { type: "json" });
  return v == null ? fallback : v;
}

async function putJSON(env, key, value) {
  await env.BEAU_FLEET.put(key, JSON.stringify(value));
}

// Seed the vessel registry on first read if it doesn't exist yet —
// matches Phase 0 of the roadmap (one real vessel, four pilot slots).
const DEFAULT_VESSELS = [
  { id: "kirt_chouest", name: "KIRT CHOUEST", role: "AHTS \u00b7 Subsea Construction", tunnel_url: "https://beau.beaufort-ai.com/api/sensors", added_at: "2026-06-01T00:00:00Z" },
];

async function requireAdmin(request, env) {
  const key = request.headers.get("X-Fleet-Admin-Key") || "";
  return env.FLEET_ADMIN_KEY && key === env.FLEET_ADMIN_KEY;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // ── GET /api/fleet/vessels ──────────────────────────────
      if (path === "/api/fleet/vessels" && request.method === "GET") {
        let vessels = await getJSON(env, "vessels", null);
        if (vessels == null) {
          vessels = DEFAULT_VESSELS;
          await putJSON(env, "vessels", vessels);
        }
        return json({ vessels }, 200, origin);
      }

      // ── GET /api/fleet/advisories ───────────────────────────
      if (path === "/api/fleet/advisories" && request.method === "GET") {
        const advisories = await getJSON(env, "advisories", []);
        const showAll = url.searchParams.get("all") === "1";
        const now = Date.now();
        const filtered = advisories.filter(a => {
          if (showAll) return true;
          if (!a.active) return false;
          if (a.expires_at && new Date(a.expires_at).getTime() < now) return false;
          return true;
        });
        return json({ advisories: filtered }, 200, origin);
      }

      // ── POST /api/fleet/advisories (RMC creates) ────────────
      if (path === "/api/fleet/advisories" && request.method === "POST") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized \u2014 admin key required" }, 401, origin);
        }
        const body = await request.json().catch(() => ({}));
        const severity = esc(body.severity) || "info";
        const title = esc(body.title);
        const advBody = esc(body.body);
        const issuedBy = esc(body.issued_by) || "RMC";
        const expiresDays = Number.isFinite(Number(body.expires_days)) ? Number(body.expires_days) : 7;

        if (!title || !advBody) {
          return json({ error: "title and body are required" }, 400, origin);
        }
        if (!["info", "warning", "critical"].includes(severity)) {
          return json({ error: "severity must be info, warning, or critical" }, 400, origin);
        }

        const advisories = await getJSON(env, "advisories", []);
        const now = new Date();
        const expires = new Date(now.getTime() + expiresDays * 86400000);
        const advisory = {
          id: uid(),
          severity,
          title,
          body: advBody,
          issued_by: issuedBy,
          created_at: now.toISOString(),
          expires_at: expires.toISOString(),
          active: true,
        };
        advisories.unshift(advisory);
        await putJSON(env, "advisories", advisories);
        return json({ status: "ok", advisory }, 200, origin);
      }

      // ── POST /api/fleet/advisories/:id/clear (RMC retires) ──
      const clearMatch = path.match(/^\/api\/fleet\/advisories\/([a-f0-9-]+)\/clear$/);
      if (clearMatch && request.method === "POST") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized \u2014 admin key required" }, 401, origin);
        }
        const advisories = await getJSON(env, "advisories", []);
        const idx = advisories.findIndex(a => a.id === clearMatch[1]);
        if (idx === -1) return json({ error: "Advisory not found" }, 404, origin);
        advisories[idx].active = false;
        advisories[idx].cleared_at = new Date().toISOString();
        await putJSON(env, "advisories", advisories);
        return json({ status: "ok", advisory: advisories[idx] }, 200, origin);
      }

      // ── GET /api/fleet/reports (RMC views inbox) ────────────
      if (path === "/api/fleet/reports" && request.method === "GET") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized \u2014 admin key required" }, 401, origin);
        }
        const reports = await getJSON(env, "reports", []);
        return json({ reports }, 200, origin);
      }

      // ── POST /api/fleet/reports (vessel reports a hazard) ───
      // Intentionally NOT admin-gated: any vessel in the pilot needs to
      // be able to report without needing the RMC's write key. Report
      // volume is naturally low (hazard reports, not routine chatter),
      // and every report is emailed to the RMC inbox for visibility/audit.
      if (path === "/api/fleet/reports" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const vesselId = esc(body.vessel_id);
        const vesselName = esc(body.vessel_name) || vesselId || "Unknown vessel";
        const hazardType = esc(body.hazard_type);
        const description = esc(body.description);
        const position = esc(body.position);

        if (!hazardType || !HAZARD_TYPES.has(hazardType)) {
          return json({ error: "hazard_type is required and must be a recognized type" }, 400, origin);
        }
        if (!description) {
          return json({ error: "description is required" }, 400, origin);
        }
        if (description.length > 2000) {
          return json({ error: "description too long (max 2000 chars)" }, 400, origin);
        }

        const report = {
          id: uid(),
          vessel_id: vesselId || null,
          vessel_name: vesselName,
          hazard_type: hazardType,
          description,
          position: position || null,
          reported_at: new Date().toISOString(),
          status: "new",
        };

        const reports = await getJSON(env, "reports", []);
        reports.unshift(report);
        await putJSON(env, "reports", reports);

        // Email the RMC inbox so a report doesn't sit silently in KV
        // waiting for someone to check a dashboard.
        try {
          const msg = createMimeMessage();
          msg.setSender({ addr: "fleet@beaufortai.ai", name: "Beau Fleet Reports" });
          msg.setRecipient("piratefarmer2@gmail.com");
          msg.setSubject(`[Fleet Report] ${hazardType} \u2014 ${vesselName}`);
          const lines = [
            `Vessel: ${vesselName}`,
            `Hazard type: ${hazardType}`,
            position ? `Reported position: ${position}` : null,
            `Reported at: ${report.reported_at}`,
            "",
            "Description:",
            description,
          ].filter(Boolean);
          msg.addMessage({ contentType: "text/plain", data: lines.join("\n") });
          const email = new EmailMessage("fleet@beaufortai.ai", "piratefarmer2@gmail.com", msg.asRaw());
          await env.SEB.send(email);
        } catch (e) {
          // Report is already saved in KV even if email delivery fails —
          // don't lose the report over a transient email issue, but do
          // surface it in the response so it's not silently swallowed.
          return json({ status: "ok", report, email_warning: e.message }, 200, origin);
        }

        return json({ status: "ok", report }, 200, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Internal error", detail: e.message }, 500, origin);
    }
  },
};
