/**
 * Beau Feedback Worker
 * Accepts operator-submitted feedback/bug-flag submissions from the
 * dashboard "Flag Issue" widget and emails them to piratefarmer2@gmail.com
 * (same inbox used for photo/video submissions) via Cloudflare's native
 * send_email binding — no MailChannels, no external email API key needed.
 *
 * POST body (JSON):
 *   {
 *     category: string,        // required, one of CATEGORIES
 *     comment: string,         // required, operator's free-text note
 *     question: string,        // optional, the Q&A question that was asked
 *     answer: string,          // optional, Beau's response being flagged
 *     page_url: string,        // optional, which page/tab this came from
 *   }
 */
import { createMimeMessage } from "mimetext/browser";
import { EmailMessage } from "cloudflare:email";

const CATEGORIES = new Set([
  "Wrong or Inaccurate Answer",
  "Missing Information",
  "Unclear / Confusing Response",
  "Website or Dashboard Bug",
  "Other",
]);

const ALLOWED_ORIGINS = new Set([
  "https://beaufortai.ai",
  "https://www.beaufortai.ai",
  "https://beau.beaufort-ai.com",
  "https://www.beaufort-ai.com",
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://beaufortai.ai";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function esc(s) {
  return String(s == null ? "" : s);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const category = esc(body.category).trim();
    const comment = esc(body.comment).trim();
    const question = esc(body.question).trim();
    const answer = esc(body.answer).trim();
    const pageUrl = esc(body.page_url).trim();

    if (!category || !CATEGORIES.has(category)) {
      return new Response(JSON.stringify({ error: "Invalid or missing category" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (!comment) {
      return new Response(JSON.stringify({ error: "Comment is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (comment.length > 4000) {
      return new Response(JSON.stringify({ error: "Comment too long (max 4000 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const nowIso = new Date().toISOString();

    const lines = [];
    lines.push(`Category: ${category}`);
    lines.push(`Submitted: ${nowIso}`);
    if (pageUrl) lines.push(`Page: ${pageUrl}`);
    lines.push("");
    if (question) {
      lines.push("Flagged question:");
      lines.push(question);
      lines.push("");
    }
    if (answer) {
      lines.push("Beau's answer being flagged:");
      lines.push(answer);
      lines.push("");
    }
    lines.push("Operator comment:");
    lines.push(comment);

    const textBody = lines.join("\n");

    try {
      const msg = createMimeMessage();
      msg.setSender({ addr: "feedback@beaufortai.ai", name: "Beau Dashboard Feedback" });
      msg.setRecipient("piratefarmer2@gmail.com");
      msg.setSubject(`[Beau Feedback] ${category}`);
      msg.addMessage({ contentType: "text/plain", data: textBody });

      const email = new EmailMessage(
        "feedback@beaufortai.ai",
        "piratefarmer2@gmail.com",
        msg.asRaw()
      );
      await env.SEB.send(email);

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Failed to send feedback email", detail: e.message }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }
  },
};
