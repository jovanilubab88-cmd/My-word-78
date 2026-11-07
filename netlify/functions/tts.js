// Netlify Function: /.netlify/functions/tts
// Turns text into speech with OpenAI, using the server-side OPENAI_API_KEY.
// Each clip is made only once: after that it is played from storage, so you never pay twice for the same words.
const { gate } = require("../lib/fb.js");
const { cleanRequest, getClip } = require("../lib/ttscache.js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  // only signed-in people with an active free trial or subscription can use the AI (protects your OpenAI bill)
  const g = await gate(event);
  if (g.error) return g.error;

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const req = cleanRequest(body);
  if (!req.text) return { statusCode: 400, body: JSON.stringify({ error: "No text provided" }) };

  try {
    const clip = await getClip(event, process.env.OPENAI_API_KEY, req);
    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-TTS-Cache": clip.hit ? "hit" : "new" },
      body: clip.buf.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: e.status || 500, body: JSON.stringify({ error: e.message || "Voice failed" }) };
  }
};
