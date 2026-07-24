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
 *   POST /api/fleet/vessels                [admin key required]
 *   PATCH /api/fleet/vessels/:id            [admin key required]
 *   GET  /api/fleet/advisories            (only active=true unless ?all=1)
 *   POST /api/fleet/advisories             [admin key required]
 *   POST /api/fleet/advisories/:id/clear   [admin key required]
 *   GET  /api/fleet/reports                [admin key required]
 *   POST /api/fleet/reports/:id/status     [admin key required]
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

const REPORT_STATUSES = new Set(["new", "acknowledged", "resolved"]);

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

      // ── POST /api/fleet/vessels (RMC/admin adds a pilot vessel) ──
      // Added 2026-07-24: fleet pilot expanding beyond the single seeded
      // KIRT CHOUEST entry (6 more Raspberry Pi 5 sensor rigs arriving).
      // Same admin-key gate as advisories -- this is a fleet-composition
      // change, not a routine vessel action, so it stays admin-only.
      if (path === "/api/fleet/vessels" && request.method === "POST") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized — admin key required" }, 401, origin);
        }
        const body = await request.json().catch(() => ({}));
        const id = esc(body.id);
        const name = esc(body.name);
        const role = esc(body.role) || "Sensor Pilot Unit";
        const tunnelUrl = esc(body.tunnel_url);

        if (!id || !name) {
          return json({ error: "id and name are required" }, 400, origin);
        }
        if (!/^[a-z0-9_-]+$/i.test(id)) {
          return json({ error: "id must be alphanumeric (dashes/underscores ok)" }, 400, origin);
        }

        let vessels = await getJSON(env, "vessels", null);
        if (vessels == null) vessels = DEFAULT_VESSELS;

        if (vessels.some(v => v.id === id)) {
          return json({ error: `Vessel id "${id}" already exists` }, 409, origin);
        }

        const vessel = {
          id,
          name,
          role,
          tunnel_url: tunnelUrl || null,
          added_at: new Date().toISOString(),
        };
        vessels.push(vessel);
        await putJSON(env, "vessels", vessels);

        return json({ status: "ok", vessel }, 200, origin);
      }

      // ── PATCH /api/fleet/vessels/:id (RMC/admin edits name/role/tunnel_url) ──
      // Added 2026-07-24: needed to rename KIRT CHOUEST's display name to
      // clarify it's the demo/pilot sensor rig, not implying it's a second
      // real vessel alongside the others coming online. Only name/role/
      // tunnel_url are editable -- id and added_at are immutable identity
      // fields (renaming the id would break the relay's registry lookup
      // and any dashboard/relay code keyed on it).
      const vesselPatchMatch = path.match(/^\/api\/fleet\/vessels\/([a-z0-9_-]+)$/i);
      if (vesselPatchMatch && request.method === "PATCH") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized — admin key required" }, 401, origin);
        }
        const id = vesselPatchMatch[1];
        const body = await request.json().catch(() => ({}));

        let vessels = await getJSON(env, "vessels", null);
        if (vessels == null) vessels = DEFAULT_VESSELS;

        const idx = vessels.findIndex(v => v.id === id);
        if (idx === -1) return json({ error: `Vessel id "${id}" not found` }, 404, origin);

        if (body.name !== undefined) {
          const name = esc(body.name);
          if (!name) return json({ error: "name cannot be empty" }, 400, origin);
          vessels[idx].name = name;
        }
        if (body.role !== undefined) vessels[idx].role = esc(body.role) || vessels[idx].role;
        if (body.tunnel_url !== undefined) vessels[idx].tunnel_url = esc(body.tunnel_url) || null;
        vessels[idx].updated_at = new Date().toISOString();

        await putJSON(env, "vessels", vessels);
        return json({ status: "ok", vessel: vessels[idx] }, 200, origin);
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

        // Notify the fleet inbox so a published advisory doesn't sit
        // silently in KV waiting for someone to open the dashboard tab.
        // Same send_email binding/pattern as hazard reports, mirrored
        // direction (RMC -> fleet instead of vessel -> RMC). Best-effort:
        // the advisory is already saved even if email delivery fails.
        let emailWarning;
        try {
          const msg = createMimeMessage();
          msg.setSender({ addr: "fleet@beaufortai.ai", name: "Beau Fleet Advisories" });
          msg.setRecipient("piratefarmer2@gmail.com");
          msg.setSubject(`[Fleet Advisory] ${severity.toUpperCase()} \u2014 ${title}`);
          const lines = [
            `Severity: ${severity.toUpperCase()}`,
            `Issued by: ${issuedBy}`,
            `Issued at: ${advisory.created_at}`,
            `Expires: ${advisory.expires_at}`,
            "",
            title,
            "",
            advBody,
          ];
          msg.addMessage({ contentType: "text/plain", data: lines.join("\n") });
          const email = new EmailMessage("fleet@beaufortai.ai", "piratefarmer2@gmail.com", msg.asRaw());
          await env.SEB.send(email);
        } catch (e) {
          emailWarning = e.message;
        }

        return json(emailWarning ? { status: "ok", advisory, email_warning: emailWarning } : { status: "ok", advisory }, 200, origin);
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

      // ── POST /api/fleet/reports/:id/status (RMC updates triage status) ──
      // Added 2026-07-10: reports previously had a status field ('new')
      // but nothing ever changed it — they'd sit in the inbox forever with
      // no way to tell what RMC had already looked at/handled. Lets the
      // RMC dashboard mark a report acknowledged (seen, being worked) or
      // resolved (handled, done) without deleting the record.
      const statusMatch = path.match(/^\/api\/fleet\/reports\/([a-f0-9-]+)\/status$/);
      if (statusMatch && request.method === "POST") {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Unauthorized \u2014 admin key required" }, 401, origin);
        }
        const body = await request.json().catch(() => ({}));
        const newStatus = esc(body.status);
        if (!REPORT_STATUSES.has(newStatus)) {
          return json({ error: `status must be one of: ${[...REPORT_STATUSES].join(", ")}` }, 400, origin);
        }
        const reports = await getJSON(env, "reports", []);
        const idx = reports.findIndex(r => r.id === statusMatch[1]);
        if (idx === -1) return json({ error: "Report not found" }, 404, origin);
        reports[idx].status = newStatus;
        reports[idx].status_updated_at = new Date().toISOString();
        await putJSON(env, "reports", reports);
        return json({ status: "ok", report: reports[idx] }, 200, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      return json({ error: "Internal error", detail: e.message }, 500, origin);
    }
  },
};
