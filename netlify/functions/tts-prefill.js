// Netlify Function: /.netlify/functions/tts-prefill
// Used only by your private prefill.html page to make the audio for your whole word list ahead of time.
// Protected by PREFILL_TOKEN — a password you make up and add in Netlify's environment variables.
const crypto = require("crypto");
const { cleanRequest, getClip } = require("../lib/ttscache.js");
const reply = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const secret = process.env.PREFILL_TOKEN || "";
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const given = String(body.token || "");
  if (!secret || secret.length < 8) return reply(503, { error: "Add PREFILL_TOKEN (at least 8 characters) in Netlify's environment variables first." });
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return reply(403, { error: "Wrong admin password." });
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 12);
  const out = await Promise.all(items.map(async it => {
    const req = cleanRequest(it || {});
    if (!req.text) return { ok: false, error: "empty" };
    try { const c = await getClip(event, process.env.OPENAI_API_KEY, req); return { ok: true, hit: c.hit, chars: req.text.length }; }
    catch (e) { return { ok: false, status: e.status || 500, error: String(e.message || "failed").slice(0, 200) }; }
  }));
  return reply(200, { results: out });
};
