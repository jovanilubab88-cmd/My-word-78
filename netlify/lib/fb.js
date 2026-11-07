// Shared helpers for My Word Book's Netlify Functions (Firebase version).
// Needs the Netlify environment variable FIREBASE_SERVICE_ACCOUNT: the whole JSON file from
// Firebase console → Project settings → Service accounts → "Generate new private key". It is secret: Netlify only.
let admin = null, ready = null;
function fb() {
  if (ready !== null) return ready ? admin : null;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { ready = false; return null; }
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      const sa = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    }
    ready = true; return admin;
  } catch (e) { console.error("Firebase admin setup failed:", e.message); ready = false; return null; }
}
const reply = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const ms = v => (v && typeof v.toMillis === "function" ? v.toMillis() : +v || 0);
// same rule as js/auth.js: paid, or still inside the free trial
function access(p) {
  if (!p) return { ok: false, reason: "no-profile" };
  if (p.plan === "active" || p.plan === "paid" || ms(p.paidUntil) > Date.now()) return { ok: true, plan: "paid" };
  if (ms(p.trialEnds) > Date.now()) return { ok: true, plan: "trial" };
  return { ok: false, reason: "trial-over" };
}
// who is calling? (the app sends the signed-in person's Firebase token)
async function caller(event) {
  const a = fb(); if (!a) return { configured: false };
  const h = event.headers || {}, m = String(h.authorization || h.Authorization || "").match(/^Bearer\s+(.+)$/);
  if (!m) return { configured: true, user: null };
  try { const t = await a.auth().verifyIdToken(m[1]); return { configured: true, user: { uid: t.uid, email: t.email || "" } }; }
  catch (e) { return { configured: true, user: null }; }
}
async function profile(uid) { const s = await fb().firestore().collection("users").doc(uid).get(); return s.exists ? s.data() : null; }
// AI features: only for signed-in people with an active trial or plan (protects your OpenAI bill).
// Before FIREBASE_SERVICE_ACCOUNT is added, the AI stays open so the site keeps working while you set things up.
async function gate(event) {
  const c = await caller(event);
  if (!c.configured) return {};
  if (!c.user) return { error: reply(401, { error: "login_required", message: "Please log in to use the AI features." }) };
  let p = null; try { p = await profile(c.user.uid); } catch (e) { return {}; } // if Firestore is briefly unreachable, don't block learning
  const a = access(p);
  if (!a.ok) return { error: reply(402, { error: "subscribe", message: "Your free trial has ended. Subscribe to keep using the AI voice and AI help." }) };
  return { user: c.user, plan: a.plan };
}
module.exports = { fb, reply, access, caller, profile, gate, ms };
