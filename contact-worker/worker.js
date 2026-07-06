/**
 * Beau Contact Worker
 * Accepts "Get In Touch" contact-card submissions from the homepage
 * (index.html #contact section) and emails them to piratefarmer2@gmail.com
 * via Cloudflare's native send_email binding — same proven pattern as
 * beau-feedback worker, no MailChannels, no external email API key needed.
 *
 * POST body (JSON):
 *   {
 *     name: string,      // optional
 *     email: string,     // required, sender's reply-to address
 *     company: string,   // optional, vessel/operator/company name
 *     message: string,   // required, free-text inquiry
 *     page_url: string,  // optional, which page this came from
 *   }
 */
import { createMimeMessage, Mailbox } from "mimetext/browser";
import { EmailMessage } from "cloudflare:email";

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

// Very small sanity check — not a full RFC 5322 validator, just enough to
// catch empty/garbage input before we send an email.
function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

    const name = esc(body.name).trim().slice(0, 200);
    const email = esc(body.email).trim().slice(0, 300);
    const company = esc(body.company).trim().slice(0, 200);
    const message = esc(body.message).trim();
    const pageUrl = esc(body.page_url).trim();

    if (!email || !looksLikeEmail(email)) {
      return new Response(JSON.stringify({ error: "A valid email address is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (!message) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (message.length > 4000) {
      return new Response(JSON.stringify({ error: "Message too long (max 4000 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const nowIso = new Date().toISOString();

    const lines = [];
    lines.push(`Submitted: ${nowIso}`);
    if (name) lines.push(`Name: ${name}`);
    lines.push(`Email: ${email}`);
    if (company) lines.push(`Company/Vessel: ${company}`);
    if (pageUrl) lines.push(`Page: ${pageUrl}`);
    lines.push("");
    lines.push("Message:");
    lines.push(message);

    const textBody = lines.join("\n");

    try {
      const msg = createMimeMessage();
      msg.setSender({ addr: "contact@beaufortai.ai", name: "Beaufort AI Contact Form" });
      msg.setRecipient("piratefarmer2@gmail.com");
      // Reply-To set to the submitter's address so a normal "Reply" in
      // Gmail goes straight back to them, not to contact@beaufortai.ai.
      msg.setHeader("Reply-To", new Mailbox(email, { type: "Reply-To" }));
      msg.setSubject(`[Beau Contact] ${name || email}`);
      msg.addMessage({ contentType: "text/plain", data: textBody });

      const emailMsg = new EmailMessage(
        "contact@beaufortai.ai",
        "piratefarmer2@gmail.com",
        msg.asRaw()
      );
      await env.SEB.send(emailMsg);

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Failed to send message", detail: e.message }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }
  },
};
