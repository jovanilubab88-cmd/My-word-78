const { gate } = require("../lib/fb.js");
// Netlify Function: /.netlify/functions/ask
// Answers students' questions in CellVerse 3D (My Word Book).
// Uses the server-side OPENAI_API_KEY environment variable — the key is never sent to the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  // only signed-in people with an active free trial or subscription can use the AI (protects your OpenAI bill)
  const g = await gate(event);
  if (g.error) return g.error;


  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "OpenAI API key not configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);
  const question = clean(body.question, 300).trim();
  if (!question) {
    return { statusCode: 400, body: JSON.stringify({ error: "No question provided" }) };
  }
  const cell = clean(body.cell, 160);
  const selected = clean(body.selected, 60);
  const parts = (Array.isArray(body.parts) ? body.parts : []).slice(0, 25).map(p => clean(p, 40)).join(", ");
  const history = (Array.isArray(body.history) ? body.history : []).slice(-2);

  const system =
    'You are a friendly science tutor inside "My Word Book", a learning app for students from kindergarten to grade 12. ' +
    `The student is looking at a 3D model of ${cell || "a cell"}${selected ? `, with the ${selected} selected` : ""}. ` +
    `Parts shown in the model: ${parts || "unknown"}. ` +
    "Answer accurately in 2–4 short sentences of simple, clear language (about grade 5 level unless the question is advanced). " +
    "Mention part names exactly as written in the list when relevant. Use no markdown, lists or emojis. " +
    "If the question is not about science or cells, answer kindly in one sentence and suggest a question about cells. " +
    "Never include anything unsafe or inappropriate for children.";

  const messages = [{ role: "system", content: system }];
  history.forEach(h => {
    if (h && h.q && h.a) {
      messages.push({ role: "user", content: clean(h.q, 300) });
      messages.push({ role: "assistant", content: clean(h.a, 800) });
    }
  });
  messages.push({ role: "user", content: question });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 250, temperature: 0.4 }),
    });
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      return { statusCode: status, body: JSON.stringify({ error: "Upstream error" }) };
    }
    const data = await response.json();
    const answer = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
