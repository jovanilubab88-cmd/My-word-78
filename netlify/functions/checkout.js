// Netlify Function: /.netlify/functions/checkout
// Opens Stripe's secure payment page for My Word Book Plus ($3.99/month per family).
// Netlify environment variables (secret, never in the code):
//   STRIPE_SECRET_KEY — starts with sk_   ·   STRIPE_PRICE_ID — the $3.99/month price, starts with price_
const { fb, reply, caller, profile, ms } = require("../lib/fb.js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const key = process.env.STRIPE_SECRET_KEY, price = process.env.STRIPE_PRICE_ID;
  if (!key || !price) return reply(503, { error: "billing_not_set_up", message: "Payments aren't switched on yet." });
  const c = await caller(event);
  if (!c.configured) return reply(503, { error: "accounts_not_set_up", message: "Accounts aren't connected to payments yet (FIREBASE_SERVICE_ACCOUNT)." });
  if (!c.user) return reply(401, { error: "login_required", message: "Please log in first." });
  const p = await profile(c.user.uid).catch(() => null);
  const site = process.env.URL || `https://${(event.headers || {}).host}`;
  const f = new URLSearchParams();
  f.set("mode", "subscription");
  f.set("line_items[0][price]", price); f.set("line_items[0][quantity]", "1");
  f.set("client_reference_id", c.user.uid);
  f.set("metadata[uid]", c.user.uid); f.set("subscription_data[metadata][uid]", c.user.uid);
  if (p && p.stripeCustomer) f.set("customer", p.stripeCustomer); else if (c.user.email) f.set("customer_email", c.user.email);
  // if they subscribe during the trial, the first payment waits until the trial would have ended
  const trialLeft = p ? ms(p.trialEnds) - Date.now() : 0;
  if (trialLeft > 48 * 3600 * 1000 && !(p && p.stripeCustomer)) f.set("subscription_data[trial_end]", String(Math.floor((Date.now() + trialLeft) / 1000)));
  f.set("allow_promotion_codes", "true");
  f.set("success_url", `${site}/app.html?subscribed=1`);
  f.set("cancel_url", `${site}/app.html?subscribed=0`);
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: f.toString() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.url) return reply(502, { error: "stripe_error", message: (d.error && d.error.message) || "Stripe didn't open the payment page." });
  return reply(200, { url: d.url });
};
