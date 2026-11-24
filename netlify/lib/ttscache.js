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
  plain: "Read in a natural, neutral narration voice at a steady pace.",
  word: "You are a friendly, clear teacher helping a student learn a new vocabulary word. Speak at a calm, steady pace.",
  kids: "Speak like a warm, cheerful kindergarten teacher talking to a five-year-old. Use a bright, smiling, gentle voice. Speak slowly and clearly, say each word on its own, and leave a short happy pause after every sentence. Sound encouraging, never rushed."
};
// K-5 phonics: exactly which pure sound each letter makes (only these fixed descriptions are ever sent, never user text)
const PHONICS = {
  a: "the short a sound /æ/, as at the start of 'apple' and in 'cat' (not 'ay', not 'ah')",
  b: "a quick, crisp /b/ as at the start of 'ball', with almost no 'uh' after it",
  c: "a quick, crisp /k/ as at the start of 'cat', with almost no 'uh' after it",
  d: "a quick, crisp /d/ as at the start of 'dog', with almost no 'uh' after it",
  e: "the short e sound /ɛ/, as at the start of 'egg' (not 'ee')",
  f: "a long, gentle /f/: top teeth on the bottom lip, air only, no voice: ffff",
  g: "a quick, crisp hard /g/ as at the start of 'goat', with almost no 'uh' after it",
  h: "a soft, breathy /h/ as at the start of 'hat', just a puff of breath",
  i: "the short i sound /ɪ/, as at the start of 'igloo' and in 'sit' (not 'eye')",
  j: "a quick /dʒ/ as at the start of 'jam', with almost no 'uh' after it",
  k: "a quick, crisp /k/ as at the start of 'kite', with almost no 'uh' after it",
  l: "the sound at the very start of 'lion' and 'leg', stretched out: lllll. Tongue tip pressed up behind the top teeth, voice on, like a soft hum. Do NOT say the letter name 'el' (no 'eh' before it) and do NOT add 'uh' after it (not 'luh'); no vowel at all before or after the l",
  m: "a long hum /m/ with the lips closed: mmmm",
  n: "a long hum /n/ through the nose: nnnn",
  o: "the short o sound /ɑ/, as at the start of 'octopus' and in 'hot' (not 'oh')",
  p: "a quick puff /p/ as at the start of 'pig', with almost no 'uh' after it",
  q: "a quick /kw/ as at the start of 'queen'",
  r: "a long, held /r/ as at the start of 'red' (not 'ar'): rrrr",
  s: "a long snake hiss /s/: ssss, air only, no voice",
  t: "a quick, crisp /t/ as at the start of 'top', with almost no 'uh' after it",
  u: "the short u sound /ʌ/, as at the start of 'umbrella' and in 'cup' (not 'you')",
  v: "a long buzzing /v/: top teeth on the bottom lip with voice: vvvv",
  w: "a quick /w/ as at the start of 'water', lips rounded",
  x: "the /ks/ sound as at the end of 'fox'",
  y: "a quick /j/ as at the start of 'yo-yo'",
  z: "a long buzzing bee sound /z/: zzzz"
};
function instructionsFor(req) {
  let ins = STYLES[req.style] || "";
  if (req.w) ins += ` The text says the word "${req.w}", then the same word split into syllables separated by dashes, then the word again. Pronounce "${req.w}" correctly, exactly the way a science or language teacher would say it. For the syllables, say each one slowly as a piece of the real word, sounding exactly as it does inside "${req.w}", with a short pause between them. Never spell out letters, and never read a syllable as a separate word, name or abbreviation (for example "us" is not "U.S." and "a" is said the way it sounds inside the word).`;
  if (req.snd && PHONICS[req.snd]) ins += ` This is a phonics lesson. Text written between slashes, like /sss/ or /ă/, is a letter SOUND, not a letter name: say it as ${PHONICS[req.snd]}. Hold it for about half a second, clearly, then carry on smiling. Never say the letter's name instead of its sound. If the text is only the sound, say only the sound.`;
  if (req.snd && req.hint) ins += ` A parent listened and says this letter sound should be like this: "${req.hint}". Follow the parent's description exactly; it overrides the description above if they differ.`;
  return ins;
}
// the same request always gives the same name, so a saved clip can be found again
function clipKey(model, voice, style, text, snd, w, hint, take) {
  return crypto.createHash("sha256").update([model, voice, style || "", text].concat(snd ? ["snd:" + snd] : [], w ? ["w:" + w] : [], hint ? ["h:" + hint] : [], take ? ["t:" + take] : []).join("|")).digest("hex");
}
function cleanRequest(body) {
  const style = STYLES[body.style] ? body.style : "";
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, style ? 900 : 500);
  const voice = VOICES.includes(body.voice) ? body.voice : "nova";
  const model = style ? "gpt-4o-mini-tts" : "tts-1"; // word cards use the fast, cheap voice; reading styles use the steerable one
  const snd = style === "kids" && /^[a-z]$/.test(String(body.snd || "")) ? String(body.snd) : "";
  // a vocabulary word being taught (letters, spaces, hyphens and apostrophes only), for the "word" style
  const w = style === "word" ? String(body.w || "").replace(/[^A-Za-z\u00C0-\u024F' -]/g, "").trim().slice(0, 40) : "";
  // a parent's description of how a letter sound should be, and which try this is (each try is a fresh recording)
  const hint = snd ? String(body.hint || "").replace(/[^A-Za-z0-9 ,.'!?/()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const take = snd ? Math.max(0, Math.min(20, parseInt(body.take, 10) || 0)) : 0;
  return { style, text, voice, model, snd, w, hint, take };
}
function cacheStore(event) {
  if (!blobs) return null;
  try { blobs.connectLambda(event); } catch (e) {}
  try { return blobs.getStore("tts-cache"); } catch (e) { return null; }
}
// returns {buf, hit} — hit = true when the clip came from storage (no OpenAI call)
async function getClip(event, apiKey, req) {
  const st = cacheStore(event), key = clipKey(req.model, req.voice, req.style, req.text, req.snd, req.w, req.hint, req.take);
  if (st) {
    try { const saved = await st.get(key, { type: "arrayBuffer" }); if (saved && saved.byteLength > 200) return { buf: Buffer.from(saved), hit: true, key }; } catch (e) {}
  }
  if (!apiKey) throw { status: 500, message: "OpenAI API key not configured" };
  const speech = payload => fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  let res = await speech(Object.assign({ model: req.model, voice: req.voice, input: req.text, response_format: "mp3" }, req.style ? { instructions: instructionsFor(req) } : {}));
  // if the steerable model isn't available on this account, use the classic voice model (never for letter sounds: it can't make them)
  if (!res.ok && req.style && !req.snd && res.status !== 429) res = await speech({ model: "tts-1", voice: req.voice, input: req.w ? `${req.w}. ${req.w}.` : req.text, response_format: "mp3" });
  if (!res.ok) throw { status: res.status, message: await res.text() };
  const buf = Buffer.from(await res.arrayBuffer());
  if (st && buf.length > 200) { try { await st.set(key, buf, { metadata: { voice: req.voice, style: req.style, model: req.model, chars: req.text.length } }); } catch (e) {} }
  return { buf, hit: false, key };
}
module.exports = { VOICES, STYLES, PHONICS, instructionsFor, clipKey, cleanRequest, getClip };
