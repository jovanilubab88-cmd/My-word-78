// Netlify Function: /.netlify/functions/portal
// Opens Stripe's page where a parent can change their card or cancel.
const { reply, caller, profile } = require("../lib/fb.js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const key = process.env.STRIPE_SECRET_KEY; if (!key) return reply(503, { error: "billing_not_set_up", message: "Payments aren't switched on yet." });
  const c = await caller(event);
  if (!c.user) return reply(401, { error: "login_required", message: "Please log in first." });
  const p = await profile(c.user.uid).catch(() => null);
  if (!p || !p.stripeCustomer) return reply(404, { error: "no_subscription", message: "There's no subscription on this account yet." });
  const site = process.env.URL || `https://${(event.headers || {}).host}`;
  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ customer: p.stripeCustomer, return_url: `${site}/app.html` }).toString() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.url) return reply(502, { error: "stripe_error", message: (d.error && d.error.message) || "Couldn't open the billing page." });
  return reply(200, { url: d.url });
};
