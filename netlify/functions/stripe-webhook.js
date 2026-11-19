// Netlify Function: /.netlify/functions/stripe-webhook
// Stripe calls this when a family subscribes, renews or cancels, and it updates their account in Firebase.
// Needs STRIPE_WEBHOOK_SECRET (starts with whsec_), STRIPE_SECRET_KEY and FIREBASE_SERVICE_ACCOUNT in Netlify's environment variables.
// In Stripe → Developers → Webhooks, send: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid
const crypto = require("crypto");
const { fb, reply } = require("../lib/fb.js");
const { api, idOf, subFields, getSub } = require("../lib/stripe.js");

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
  if (!verify(raw, h["stripe-signature"] || h["Stripe-Signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error("stripe-webhook: signature check failed — is STRIPE_WEBHOOK_SECRET the signing secret of THIS webhook (live vs test)?");
    return reply(400, { error: "bad_signature" });
  }
  const a = fb(); if (!a) return reply(500, { error: "firebase_not_set_up" });
  let ev; try { ev = JSON.parse(raw); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const db = a.firestore(), users = db.collection("users"), o = (ev.data && ev.data.object) || {};
  const type = ev.type || "";
  if (!/^(checkout\.session\.completed|customer\.subscription\.(created|updated|deleted)|invoice\.(paid|payment_succeeded))$/.test(type)) return reply(200, { received: true, ignored: type });

  // which subscription is this about? Ask Stripe for its status now, so messages that arrive out of order can't undo a payment
  const subId = o.object === "subscription" ? o.id : (idOf(o.subscription) || (o.parent && o.parent.subscription_details && idOf(o.parent.subscription_details.subscription)));
  let sub = o.object === "subscription" ? o : null;
  try { const fresh = await getSub(subId); if (fresh) sub = fresh; } catch (e) { console.warn("stripe-webhook: couldn't fetch subscription", e.message); }
  if (o.object === "checkout.session" && o.mode && o.mode !== "subscription") return reply(200, { received: true, ignored: "not a subscription" });

  // whose account? the app's own id first, then the saved Stripe customer, then the email
  const customer = idOf(o.customer) || (sub && idOf(sub.customer));
  let uid = o.client_reference_id || (o.metadata && o.metadata.uid) || (sub && sub.metadata && sub.metadata.uid) || null;
  if (!uid && customer) { const q = await users.where("stripeCustomer", "==", customer).limit(1).get(); if (!q.empty) uid = q.docs[0].id; }
  if (!uid) {
    let email = (o.customer_details && o.customer_details.email) || o.customer_email || null;
    if (!email && customer) { try { const cu = await api("customers/" + encodeURIComponent(customer)); email = cu && cu.email; } catch (e) {} }
    for (const e of new Set(email ? [email, email.toLowerCase()] : [])) {
      const q = await users.where("accountEmail", "==", e).limit(1).get();
      if (!q.empty) { uid = q.docs[0].id; break; }
    }
  }
  if (!uid) { console.warn("stripe-webhook: no account matches", type, customer); return reply(200, { received: true, note: "no matching account" }); }
  const ref = users.doc(String(uid));

  if (sub) {
    await ref.set(Object.assign(subFields(a, sub), type === "checkout.session.completed" ? { paidSince: a.firestore.Timestamp.fromMillis(Date.now()) } : {}), { merge: true });
  } else if (type === "checkout.session.completed") {
    await ref.set({ plan: "active", stripeCustomer: customer, stripeSubscription: subId || null, paidSince: a.firestore.Timestamp.fromMillis(Date.now()) }, { merge: true });
  }
  return reply(200, { received: true });
};
