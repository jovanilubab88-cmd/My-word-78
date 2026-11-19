// Netlify Function: /.netlify/functions/sub-sync
// "I already subscribed": asks Stripe directly whether the signed-in person has a live subscription
// (by the Stripe customer saved on their account, or by their verified login email) and fixes their account.
// This rescues anyone whose payment message from Stripe never reached Firebase.
const { fb, reply, caller, profile } = require("../lib/fb.js");
const { LIVE, subFields, customersByEmail, bestSub } = require("../lib/stripe.js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  if (!process.env.STRIPE_SECRET_KEY) return reply(503, { error: "billing_not_set_up", message: "Payments aren't switched on yet." });
  const c = await caller(event);
  if (!c.configured) return reply(503, { error: "accounts_not_set_up", message: "Accounts aren't connected to payments yet." });
  if (!c.user) return reply(401, { error: "login_required", message: "Please log in first." });
  const a = fb(), ref = a.firestore().collection("users").doc(c.user.uid);
  try {
    const p = await profile(c.user.uid).catch(() => null);
    const ids = [];
    if (p && p.stripeCustomer) ids.push(p.stripeCustomer);
    // only a verified email can claim a subscription, so nobody can borrow someone else's
    if (c.user.email && c.user.emailVerified) ids.push(...(await customersByEmail(c.user.email)));
    const s = ids.length ? await bestSub(ids) : null;
    if (!s || !LIVE.test(s.status || "")) {
      return reply(200, { ok: false, message: `We couldn't find a subscription for ${c.user.email || "this account"}. If you paid with a different email, log in with that account.` });
    }
    await ref.set(subFields(a, s), { merge: true });
    return reply(200, { ok: true, status: s.status });
  } catch (e) {
    console.error("sub-sync:", e.message);
    return reply(502, { error: "stripe_error", message: "Couldn't reach the payment system. Please try again in a minute." });
  }
};
