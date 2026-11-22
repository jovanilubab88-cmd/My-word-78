// Netlify Function: /.netlify/functions/talk
// AI Tutor "Live talk": real-time voice with the tutor, paid for with minute packs that families buy.
//
//   action "balance" → minutes left
//   action "buy"     → opens Stripe's payment page for a minute pack (the webhook adds the minutes once paid)
//   action "start"   → takes a block of minutes from the balance, then opens a live OpenAI voice session
//   action "extend"  → takes the next block while the student keeps talking
//   action "end"     → gives back the unused part of the current block
//
// Minutes are kept in Firestore collections the app itself can't write (talk, talkSessions, talkBuys), so nobody
// can give themselves free minutes. Time is taken BEFORE it is used, so you can never be charged for unpaid talk.
// Netlify environment variables: OPENAI_API_KEY, STRIPE_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT (all already set up),
// optional: TALK_PACKS (default "30:399,60:599" = 30 min for 3.99, 60 min for 5.99), TALK_CURRENCY (default: the
// currency of your monthly plan's price), REALTIME_MODEL (default gpt-realtime-2.1-mini), REALTIME_VOICE (default marin).
const crypto = require("crypto");
const { fb, reply, gate } = require("../lib/fb.js");

const BLOCK = 300;      // seconds taken from the balance at a time (5 minutes)
const MIN_START = 20;   // need at least this many seconds to start
const packs = () => String(process.env.TALK_PACKS || "30:399,60:599").split(",").map(x => x.split(":").map(Number))
  .filter(([m, c]) => m > 0 && c >= 50).map(([minutes, cents]) => ({ minutes, cents }));
const now = () => Date.now();
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function currency() {
  if (process.env.TALK_CURRENCY) return process.env.TALK_CURRENCY.toLowerCase();
  try {
    const r = await timed(fetch("https://api.stripe.com/v1/prices/" + encodeURIComponent(process.env.STRIPE_PRICE_ID || "x"), { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }), 4000);
    const d = await r.json(); if (r.ok && d.currency) return d.currency;
  } catch (e) {}
  return "cad";
}

// the tutor's personality for live talk
function instructions(ctx) {
  const c = ctx || {};
  return `You are a warm, patient, encouraging tutor talking out loud with a student${c.level ? ` at the "${c.level}" level` : ""}${c.subject ? `, working on ${c.subject}` : ""}. This is a live voice conversation, so:
- Keep each reply short (one to three sentences), then let the student talk. Sound natural and friendly, like a real teacher sitting next to them.
- Teach, don't just give answers: ask what they think, give one step or hint at a time, and check understanding with a quick question.
- Say maths out loud the way a teacher would ("x squared plus three x", "two over five"), never as symbols.
- If the student is right, say so warmly and briefly. If they are wrong, be kind and help them find the mistake.
- Stay on school learning. Keep everything suitable for children. Never ask for or repeat personal details like full names, addresses, phone numbers or passwords. If asked about something unsafe or unsuitable, gently steer back to learning.
- Speak English unless the student speaks another language first.${c.problem ? `\nThe student currently has this problem on their screen: "${c.problem}".${c.answer ? ` The worked answer shown is: ${c.answer}.` : ""} Start by helping with it if they ask.` : ""}`;
}

async function mint(uid, ctx) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("no OPENAI_API_KEY");
  const voice = process.env.REALTIME_VOICE || "marin";
  const models = [...new Set([process.env.REALTIME_MODEL || "gpt-realtime-2.1-mini", "gpt-realtime-mini"])];
  const ins = instructions(ctx);
  const bodies = m => [
    { expires_after: { anchor: "created_at", seconds: 120 }, session: { type: "realtime", model: m, instructions: ins, audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad" } }, output: { voice } } } },
    { session: { type: "realtime", model: m, instructions: ins, audio: { output: { voice } } } } // simplest form, if the first is refused
  ];
  let last = "";
  for (const m of models) for (const body of bodies(m)) {
    const r = await timed(fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("mwb:" + uid).digest("hex").slice(0, 32) },
      body: JSON.stringify(body) }), 7000);
    const d = await r.json().catch(() => ({}));
    const v = d.value || (d.client_secret && d.client_secret.value);
    if (r.ok && v) return { key: v, model: m };
    last = (d.error && d.error.message) || ("status " + r.status);
  }
  throw new Error(last);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const g = await gate(event);
  if (g.error) return g.error;
  if (!g.user) return reply(503, { error: "accounts_not_set_up", message: "Live talk needs accounts to be connected (FIREBASE_SERVICE_ACCOUNT)." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const a = fb(), db = a.firestore(), uid = g.user.uid, wallet = db.collection("talk").doc(uid);
  const balance = async () => { const s = await wallet.get(); return Math.max(0, Math.floor((s.exists && s.data().seconds) || 0)); };

  if (b.action === "balance") return reply(200, { seconds: await balance(), packs: packs() });

  if (b.action === "buy") {
    if (!process.env.STRIPE_SECRET_KEY) return reply(503, { error: "billing_not_set_up", message: "Payments aren't switched on yet." });
    const p = packs().find(x => x.minutes === +b.minutes); if (!p) return reply(400, { error: "Unknown pack" });
    const site = process.env.URL || `https://${(event.headers || {}).host}`, f = new URLSearchParams();
    f.set("mode", "payment");
    f.set("line_items[0][quantity]", "1");
    f.set("line_items[0][price_data][currency]", await currency());
    f.set("line_items[0][price_data][unit_amount]", String(p.cents));
    f.set("line_items[0][price_data][product_data][name]", `Live Tutor talk time: ${p.minutes} minutes`);
    f.set("line_items[0][price_data][product_data][description]", "Real-time voice conversation with the My Word Book AI tutor. Minutes never expire.");
    f.set("client_reference_id", uid);
    f.set("metadata[kind]", "talk"); f.set("metadata[uid]", uid); f.set("metadata[minutes]", String(p.minutes));
    f.set("payment_intent_data[metadata][kind]", "talk"); f.set("payment_intent_data[metadata][uid]", uid);
    if (g.user.email) f.set("customer_email", g.user.email);
    f.set("success_url", `${site}/app.html?talk=bought`);
    f.set("cancel_url", `${site}/app.html?talk=cancel`);
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: f.toString() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) return reply(502, { error: "stripe_error", message: (d.error && d.error.message) || "Stripe didn't open the payment page." });
    return reply(200, { url: d.url });
  }

  if (b.action === "start") {
    const sid = crypto.randomBytes(12).toString("hex"), sref = db.collection("talkSessions").doc(sid);
    let block = 0, left = 0;
    await db.runTransaction(async t => {
      const s = await t.get(wallet), have = Math.max(0, Math.floor((s.exists && s.data().seconds) || 0));
      if (have < MIN_START) { left = have; return; }
      block = Math.min(have, BLOCK); left = have - block;
      t.set(wallet, { seconds: left, updated: now() }, { merge: true });
      t.set(sref, { uid, start: now(), reserved: block, ended: false });
    });
    if (!block) return reply(402, { error: "no_minutes", seconds: left, packs: packs(), message: "You're out of live talk minutes." });
    const ctx = { subject: String(b.subject || "").slice(0, 40), level: String(b.level || "").slice(0, 40), problem: String(b.problem || "").replace(/\s+/g, " ").slice(0, 600), answer: String(b.answer || "").replace(/\s+/g, " ").slice(0, 300) };
    try {
      const m = await mint(uid, ctx);
      return reply(200, { sid, key: m.key, model: m.model, reserved: block, seconds: left });
    } catch (e) {
      console.error("talk start:", e.message);
      await db.runTransaction(async t => { t.set(wallet, { seconds: a.firestore.FieldValue.increment(block) }, { merge: true }); t.set(sref, { ended: true, refunded: block }, { merge: true }); });
      return reply(502, { error: "openai_error", message: "The live tutor couldn't start right now, and no minutes were used. Try again, or use hands-free talk." });
    }
  }

  if (b.action === "extend" || b.action === "end") {
    const sref = db.collection("talkSessions").doc(String(b.sid || "x").replace(/[^a-f0-9]/g, "").slice(0, 32) || "x");
    let out = {};
    await db.runTransaction(async t => {
      const s = await t.get(sref), w = await t.get(wallet);
      const have = Math.max(0, Math.floor((w.exists && w.data().seconds) || 0));
      if (!s.exists || s.data().uid !== uid) { out = { error: "no_session", seconds: have }; return; }
      const d = s.data(), used = Math.ceil((now() - d.start) / 1000);
      if (d.ended) { out = { ended: true, seconds: have }; return; }
      if (b.action === "extend") {
        const add = Math.min(have, BLOCK);
        t.set(wallet, { seconds: have - add, updated: now() }, { merge: true });
        t.set(sref, { reserved: d.reserved + add }, { merge: true });
        out = { reserved: d.reserved + add, used, added: add, seconds: have - add };
      } else {
        const back = Math.max(0, d.reserved - used);
        t.set(wallet, { seconds: have + back, updated: now() }, { merge: true });
        t.set(sref, { ended: true, endedAt: now(), used: Math.min(used, d.reserved), refunded: back }, { merge: true });
        out = { ended: true, used: Math.min(used, d.reserved), seconds: have + back };
      }
    });
    return reply(out.error ? 404 : 200, out);
  }
  return reply(400, { error: "Unknown action" });
};
exports._t = { instructions, packs };
