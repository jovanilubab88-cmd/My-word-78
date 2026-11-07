// Saved AI voice clips. Every clip is made by OpenAI only ONCE and then kept in Netlify Blobs (storage built into
// your Netlify site). After that, anyone who needs the same words, voice and style gets the saved copy — no new charge.
const crypto = require("crypto");
let blobs = null; try { blobs = require("@netlify/blobs"); } catch (e) { /* not installed yet: works without saving */ }

const VOICES = ["nova", "shimmer", "coral", "sage", "alloy", "ash", "fable", "echo", "onyx"];
const STYLES = {
  story: "Read like a warm, engaging storyteller reading a book aloud to a student. Natural pacing, gentle expression, clear pauses at punctuation.",
  calm: "Read slowly in a calm, soft, soothing voice, like a bedtime story. Relaxed pacing with gentle pauses.",
  teacher: "Read like a clear, friendly teacher. Pronounce every word carefully at a steady pace and stress important words.",
  lively: "Read with lively, expressive energy and enthusiasm, while staying clear and easy to follow.",
  plain: "Read in a natural, neutral narration voice at a steady pace."
};
// the same request always gives the same name, so a saved clip can be found again
function clipKey(model, voice, style, text) {
  return crypto.createHash("sha256").update([model, voice, style || "", text].join("|")).digest("hex");
}
function cleanRequest(body) {
  const style = STYLES[body.style] ? body.style : "";
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, style ? 900 : 500);
  const voice = VOICES.includes(body.voice) ? body.voice : "nova";
  const model = style ? "gpt-4o-mini-tts" : "tts-1"; // word cards use the fast, cheap voice; reading styles use the steerable one
  return { style, text, voice, model };
}
function cacheStore(event) {
  if (!blobs) return null;
  try { blobs.connectLambda(event); } catch (e) {}
  try { return blobs.getStore("tts-cache"); } catch (e) { return null; }
}
// returns {buf, hit} — hit = true when the clip came from storage (no OpenAI call)
async function getClip(event, apiKey, req) {
  const st = cacheStore(event), key = clipKey(req.model, req.voice, req.style, req.text);
  if (st) {
    try { const saved = await st.get(key, { type: "arrayBuffer" }); if (saved && saved.byteLength > 200) return { buf: Buffer.from(saved), hit: true, key }; } catch (e) {}
  }
  if (!apiKey) throw { status: 500, message: "OpenAI API key not configured" };
  const speech = payload => fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  let res = await speech(Object.assign({ model: req.model, voice: req.voice, input: req.text, response_format: "mp3" }, req.style ? { instructions: STYLES[req.style] } : {}));
  // if the steerable model isn't available on this account, use the classic voice model
  if (!res.ok && req.style && res.status !== 429) res = await speech({ model: "tts-1", voice: req.voice, input: req.text, response_format: "mp3" });
  if (!res.ok) throw { status: res.status, message: await res.text() };
  const buf = Buffer.from(await res.arrayBuffer());
  if (st && buf.length > 200) { try { await st.set(key, buf, { metadata: { voice: req.voice, style: req.style, model: req.model, chars: req.text.length } }); } catch (e) {} }
  return { buf, hit: false, key };
}
module.exports = { VOICES, STYLES, clipKey, cleanRequest, getClip };
