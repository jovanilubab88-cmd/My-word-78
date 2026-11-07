// Netlify Function: /.netlify/functions/stripe-webhook
// Stripe calls this when a family subscribes, renews or cancels, and it updates their account in Firebase.
// Needs STRIPE_WEBHOOK_SECRET (starts with whsec_) and FIREBASE_SERVICE_ACCOUNT in Netlify's environment variables.
const crypto = require("crypto");
const { fb, reply } = require("../lib/fb.js");

function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const items = String(header).split(","), t = (items.find(x => x.startsWith("t=")) || "").slice(2), sigs = items.filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - +t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex");
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  const h = event.headers || {};
  if (!verify(raw, h["stripe-signature"] || h["Stripe-Signature"], process.env.STRIPE_WEBHOOK_SECRET)) return reply(400, { error: "bad_signature" });
  const a = fb(); if (!a) return reply(500, { error: "firebase_not_set_up" });
  let ev; try { ev = JSON.parse(raw); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const db = a.firestore(), T = ms => a.firestore.Timestamp.fromMillis(ms), o = (ev.data && ev.data.object) || {};
  const uidOf = async () => {
    const u = o.client_reference_id || (o.metadata && o.metadata.uid);
    if (u) return String(u);
    if (o.customer) { const q = await db.collection("users").where("stripeCustomer", "==", o.customer).limit(1).get(); if (!q.empty) return q.docs[0].id; }
    return null;
  };
  const uid = await uidOf();
  if (!uid) return reply(200, { received: true, note: "no matching account" });
  const ref = db.collection("users").doc(uid);

  if (ev.type === "checkout.session.completed") {
    await ref.set({ plan: "active", stripeCustomer: o.customer || null, stripeSubscription: o.subscription || null, paidSince: T(Date.now()) }, { merge: true });
  } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    const live = ev.type !== "customer.subscription.deleted" && /^(active|trialing|past_due)$/.test(o.status || "");
    const until = o.current_period_end ? o.current_period_end * 1000 : (o.items && o.items.data && o.items.data[0] && o.items.data[0].current_period_end ? o.items.data[0].current_period_end * 1000 : null);
    await ref.set(Object.assign({ plan: live ? "active" : "canceled", stripeCustomer: o.customer || null, stripeSubscription: o.id || null, stripeStatus: o.status || null },
      until ? { paidUntil: T(live ? until + 3 * 864e5 : until) } : {}), { merge: true });
  }
  return reply(200, { received: true });
};
