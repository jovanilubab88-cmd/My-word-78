// Shared Stripe helpers for My Word Book's Netlify Functions.
// Uses STRIPE_SECRET_KEY from Netlify's environment variables (secret: Netlify only, never in the code).
const LIVE = /^(active|trialing|past_due)$/;

async function api(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: `Bearer ${key}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || "Stripe error " + r.status);
  return d;
}

const idOf = v => (typeof v === "string" ? v : (v && v.id) || null);
// newer Stripe API versions keep the period end on the subscription item instead of the subscription
const periodEnd = s => ((s && (s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end))) || 0) * 1000;
const rank = s => (LIVE.test(s.status || "") ? 2 : s.status === "incomplete" ? 1 : 0);

// the fields we keep on the person's Firebase profile for a subscription
function subFields(admin, s) {
  const live = LIVE.test(s.status || ""), until = periodEnd(s), T = ms => admin.firestore.Timestamp.fromMillis(ms);
  return Object.assign(
    { plan: live ? "active" : "canceled", stripeCustomer: idOf(s.customer), stripeSubscription: s.id || null, stripeStatus: s.status || null },
    until ? { paidUntil: T(live ? until + 3 * 864e5 : until) } : {}
  );
}

async function getSub(id) { return id ? api("subscriptions/" + encodeURIComponent(id)) : null; }

// Stripe customers that use this email (Stripe's email search is exact, so try it as typed and in lower case)
async function customersByEmail(email) {
  if (!email) return [];
  const ids = new Set();
  for (const e of new Set([email, email.toLowerCase()])) {
    const l = await api(`customers?email=${encodeURIComponent(e)}&limit=20`);
    ((l && l.data) || []).forEach(c => ids.add(c.id));
  }
  return [...ids];
}

// the best subscription across these customers: a live one first, then the one paid furthest ahead
async function bestSub(customerIds) {
  let best = null;
  for (const c of new Set(customerIds.filter(Boolean))) {
    const l = await api(`subscriptions?customer=${encodeURIComponent(c)}&status=all&limit=20`);
    for (const s of (l && l.data) || []) {
      if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && periodEnd(s) > periodEnd(best))) best = s;
    }
  }
  return best;
}

module.exports = { LIVE, api, idOf, subFields, getSub, customersByEmail, bestSub };
