// Netlify Function: /.netlify/functions/ytsearch
// AI Tutor "Find a video": a student types a question and gets a few good explainer videos from YouTube.
// - Long questions are first turned into a short search phrase by the AI (OPENAI_API_KEY, gpt-4o-mini).
// - Search uses YouTube's Data API when YOUTUBE_API_KEY is set in Netlify (most reliable), otherwise YouTube's own
//   search page. Restricted Mode / safe search is always on.
// - Results are ranked to favour well-known teaching channels and lesson-length videos (no Shorts, no 3-hour streams).
const { gate } = require("../lib/fb.js");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

// channels known for clear teaching (lower case); a match moves a video up the list
const TRUSTED = ["khan academy", "the organic chemistry tutor", "professor leonard", "3blue1brown", "math antics", "crashcourse",
  "mario's math tutoring", "patrickjmt", "eddie woo", "numberphile", "mathologer", "nancypi", "brian mclogan", "blackpenredpen",
  "professor dave explains", "economics explained", "marginal revolution university", "acdc econ", "jacob clifford",
  "the economist", "tutor4physics", "physics girl", "minutephysics", "flipping physics", "bozeman science", "amoeba sisters",
  "tyler dewitt", "mathbff", "mashup math", "math with mr. j", "learn math tutorials", "statquest with josh starmer",
  "zedstatistics", "freecodecamp.org", "mit opencourseware", "ted-ed", "scishow", "veritasium", "the math sorcerer",
  "yourteachermathhelp", "krista king", "dr. trefor bazett", "ted", "national geographic", "khan academy kids", "jensenmath"];

const secs = t => String(t || "").split(":").reduce((a, x) => a * 60 + (+x || 0), 0);
const isoSecs = d => { const m = String(d || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const fmt = s => s ? (s >= 3600 ? Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") : Math.floor(s / 60)) + ":" + String(s % 60).padStart(2, "0") : "";
const txt = o => !o ? "" : o.simpleText || (o.runs || []).map(r => r.text).join("") || o.content || "";
const views = s => { const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i); if (!m) return 0; return +m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1); };

// turn a long question into a short YouTube search phrase (falls back to a simple trim)
async function searchPhrase(q, subject) {
  const simple = (q.length > 90 ? q.split(/[.?!]\s/)[0].slice(0, 90) : q) + (/\bexplain/i.test(q) ? "" : " explained");
  const key = process.env.OPENAI_API_KEY;
  if (!key || q.length <= 60) return simple;
  try {
    const r = await timed(fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, max_tokens: 30, messages: [
        { role: "system", content: "Turn the student's question into the best short YouTube search phrase (3 to 8 words) to find a clear lesson video that teaches the concept behind it. Use the standard name of the topic. Reply with the phrase only, no quotes." },
        { role: "user", content: (subject ? `(The subject picked in the app is "${subject}", which may be wrong: only use it if it fits the question.)\n` : "") + q }] })
    }), 5000);
    const j = await r.json(), p = (((j.choices || [])[0] || {}).message || {}).content || "";
    const clean = p.replace(/["\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    return clean.length > 3 ? clean : simple;
  } catch (e) { return simple; }
}

// every videoRenderer anywhere in YouTube's search data
function collect(node, out) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach(n => collect(n, out)); return out; }
  if (node.videoRenderer && node.videoRenderer.videoId) {
    const v = node.videoRenderer;
    out.push({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText) || txt(v.longBylineText) || txt(v.shortBylineText),
      seconds: secs(txt(v.lengthText)), views: views(txt(v.viewCountText) || txt(v.shortViewCountText)), age: txt(v.publishedTimeText),
      live: !!(v.badges || []).some(b => /live/i.test(JSON.stringify(b))) || !txt(v.lengthText) });
    return out;
  }
  for (const k in node) collect(node[k], out);
  return out;
}
async function viaInnertube(query) {
  const r = await timed(fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "en", Cookie: "PREF=f2=8000000; CONSENT=YES+1; SOCS=CAI" },
    body: JSON.stringify({ query, params: "EgIQAQ%3D%3D", context: { client: { clientName: "WEB", clientVersion: "2.20241120.01.00", hl: "en", gl: "US" }, user: { enableSafetyMode: true } } })
  }), 7000);
  if (!r.ok) throw new Error("search " + r.status);
  return collect(await r.json(), []);
}
async function viaPage(query) {
  const r = await timed(fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=en`, { headers: { "User-Agent": UA, "Accept-Language": "en", Cookie: "PREF=f2=8000000; CONSENT=YES+1; SOCS=CAI" } }), 7000);
  const html = await r.text(), m = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
  if (!m) throw new Error("no search data");
  return collect(JSON.parse(m[1]), []);
}
async function viaApi(query, key) {
  const s = await timed(fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&safeSearch=strict&relevanceLanguage=en&videoEmbeddable=true&q=${encodeURIComponent(query)}&key=${key}`), 7000);
  const sj = await s.json(); if (!s.ok) throw new Error("api " + ((sj.error || {}).message || s.status));
  const items = (sj.items || []).filter(i => i.id && i.id.videoId); if (!items.length) return [];
  const d = await timed(fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${items.map(i => i.id.videoId).join(",")}&key=${key}`), 7000);
  const dj = await d.json(), info = {}; (dj.items || []).forEach(v => info[v.id] = v);
  return items.map(i => { const v = info[i.id.videoId] || {}, sn = i.snippet || {};
    return { id: i.id.videoId, title: sn.title || "", channel: sn.channelTitle || "", seconds: isoSecs((v.contentDetails || {}).duration), views: +((v.statistics || {}).viewCount || 0),
      age: String(sn.publishedAt || "").slice(0, 4), live: sn.liveBroadcastContent && sn.liveBroadcastContent !== "none" }; });
}

function rank(list) {
  const seen = new Set();
  return list.filter(v => v.id && !seen.has(v.id) && seen.add(v.id) && !v.live && v.seconds >= 90 && v.seconds <= 75 * 60)
    .map((v, i) => { const ch = v.channel.toLowerCase(), trusted = TRUSTED.some(t => ch === t || ch.startsWith(t));
      const len = v.seconds >= 180 && v.seconds <= 25 * 60 ? 1.5 : 0;
      const pop = v.views ? Math.min(2, Math.log10(v.views + 1) / 3) : 0;
      return Object.assign({}, v, { trusted, score: (trusted ? 4 : 0) + len + pop - i * 0.35 }); })
    .sort((a, b) => b.score - a.score).slice(0, 6)
    .map(v => ({ id: v.id, url: "https://www.youtube.com/watch?v=" + v.id, title: v.title.slice(0, 160), channel: v.channel.slice(0, 80),
      length: fmt(v.seconds), views: v.views, age: v.age, trusted: v.trusted, thumb: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` }));
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" });
  const g = await gate(event);
  if (g.error) return g.error;
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
  const q = String(body.q || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const subject = String(body.subject || "").replace(/[^\w &-]/g, "").slice(0, 40);
  if (q.length < 3) return reply(400, { error: "Type your question first." });
  const query = await searchPhrase(q, subject);
  const ways = [];
  if (process.env.YOUTUBE_API_KEY) ways.push(() => viaApi(query, process.env.YOUTUBE_API_KEY));
  ways.push(() => viaInnertube(query), () => viaPage(query));
  let found = [];
  for (const w of ways) { try { found = rank(await w()); } catch (e) { console.warn("ytsearch:", e.message); } if (found.length) break; }
  if (!found.length) return reply(404, { error: "I couldn't find videos right now. Try different words, or try again in a minute.", query });
  return reply(200, { query, videos: found });
};
// for tests
exports._t = { collect, rank, searchPhrase };
