// Netlify Function: /.netlify/functions/sound-learn
// A parent records how a K-5 letter sound should be said. An OpenAI audio model listens to the recording and writes a short,
// exact description of the sound. The app then gives that description to the AI voice, so the AI says the sound
// the parent's way, in its own voice. The recording itself is not kept. Uses OPENAI_API_KEY.
const { gate } = require("../lib/fb.js");
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
// audio models to try, newest first (SOUND_MODEL in Netlify can choose a different one)
const MODELS = [process.env.SOUND_MODEL, "gpt-audio-mini", "gpt-audio", "gpt-4o-audio-preview", "gpt-4o-mini-audio-preview"].filter(Boolean);

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const g = await gate(event);
  if (g.error) return g.error;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return reply(503, { error: "no_key", message: "The AI isn't set up yet (OPENAI_API_KEY)." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const letter = /^[a-z]$/.test(String(b.letter || "")) ? String(b.letter) : "";
  if (!letter) return reply(400, { error: "no_letter" });
  const example = String(b.example || "").replace(/[^A-Za-z -]/g, "").slice(0, 30);
  const wav = String(b.audio || "");
  if (wav.length < 2000) return reply(400, { error: "too_short", message: "That recording was too short. Try again and hold the sound a little longer." });
  if (wav.length > 2.5 * 1024 * 1024) return reply(413, { error: "too_long", message: "Please record just the sound, about 1 to 3 seconds." });

  const ask = `This recording is a parent saying the phonics SOUND for the letter "${letter}"${example ? ` (as in "${example}")` : ""}, the way they want young children to learn it. ` +
    `Listen carefully and describe exactly how this sound is pronounced, so a voice actor can copy it. Cover: which sound it is (IPA), whether it is held long or said quickly, ` +
    `voiced or just air, any vowel before or after it (say clearly if there is none), and what to avoid (like the letter name). ` +
    `Answer with ONE plain sentence under 110 characters, only letters, numbers, spaces and simple punctuation, no quotes. ` +
    `Example: a long held l like the start of lion, voiced, no vowel before or after, not el.`;
  let lastErr = "";
  for (const model of MODELS) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, modalities: ["text"], max_completion_tokens: 120,
          messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "input_audio", input_audio: { data: wav, format: "wav" } }] }] })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { lastErr = `${model}: ${r.status} ${d.error && d.error.message}`; if (r.status === 401 || r.status === 429) break; continue; }
      const text = String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "")
        .replace(/[^A-Za-z0-9 ,.'!?/()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (text) return reply(200, { hint: text, model });
      lastErr = `${model}: empty answer`;
    } catch (e) { lastErr = `${model}: ${e.message}`; }
  }
  console.error("sound-learn:", lastErr);
  return reply(502, { error: "learn_error", message: "The AI couldn't listen to that recording right now. Try again, or type how it should sound." });
};
