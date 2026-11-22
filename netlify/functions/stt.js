// Netlify Function: /.netlify/functions/stt
// Speech to text for the AI Tutor's mic. iPads and iPhones often can't use Safari's own voice typing (Dictation off,
// home-screen app, or it just doesn't start), so the app records the question and this turns it into text with
// OpenAI's gpt-4o-mini-transcribe (about $0.003 per minute of speech). Uses OPENAI_API_KEY.
const { gate } = require("../lib/fb.js");
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const g = await gate(event);
  if (g.error) return g.error;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return reply(503, { error: "no_key", message: "The AI isn't set up yet (OPENAI_API_KEY)." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const audio = Buffer.from(String(b.audio || ""), "base64");
  if (audio.length < 800) return reply(200, { text: "" });                 // too short to hold any words
  if (audio.length > 4.5 * 1024 * 1024) return reply(413, { error: "too_long", message: "That was too long. Ask a shorter question." });
  const type = String(b.type || "audio/mp4").split(";")[0];
  const ext = /webm/.test(type) ? "webm" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : "mp4";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), "speech." + ext);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  // helps it spell school words and maths the way a student means them
  form.append("prompt", "A student asking a tutor a school question, often maths, e.g. 'What is x squared plus 3x?', 'How do I solve 2x + 5 = 11?'" + (b.subject ? ` Subject: ${String(b.subject).slice(0, 40)}.` : ""));
  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("stt:", r.status, d.error && d.error.message); return reply(502, { error: "stt_error", message: "I couldn't understand the recording. Try again." }); }
    return reply(200, { text: String(d.text || "").trim().slice(0, 600) });
  } catch (e) {
    console.error("stt:", e.message);
    return reply(502, { error: "stt_error", message: "Couldn't reach the speech service. Check your internet and try again." });
  }
};
