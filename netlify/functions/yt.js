const { gate } = require("../lib/fb.js");
// Netlify Function: /.netlify/functions/yt
// AI Tutor "Video helper": given a YouTube link, returns the video's title, channel, description, chapters and words
// (transcript) so the tutor AI can summarise and explain it. No API key needed; only youtube.com is contacted.
//
// YouTube often blocks one way of reading captions from cloud servers, so several ways run AT THE SAME TIME and the
// first one that gets the words wins. Everything finishes inside ~8.5 seconds (Netlify stops functions at 10), and
// whatever was found (at least the title) is always returned.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const COOKIE = "CONSENT=YES+1; SOCS=CAI";
const idOf = s => { const m = String(s || "").match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || String(s || "").trim().match(/^([\w-]{11})$/); return m ? m[1] : ""; };
const dec = s => String(s || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), Math.max(1, ms)))]);
const clean = s => String(s || "").replace(/\s+/g, " ").trim();

// the different "apps" YouTube talks to; each gets its own caption links
const CLIENTS = {
  ANDROID: { ua: "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip", client: { clientName: "ANDROID", clientVersion: "19.29.37", androidSdkVersion: 34, hl: "en", gl: "US" } },
  IOS: { ua: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)", client: { clientName: "IOS", clientVersion: "19.45.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.1.0.22B83", hl: "en", gl: "US" } },
  TV: { ua: UA, client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" }, thirdParty: { embedUrl: "https://www.youtube.com/" } },
  MWEB: { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", client: { clientName: "MWEB", clientVersion: "2.20241120.01.00", hl: "en", gl: "US" } }
};
async function player(id, name, ms) {
  const c = CLIENTS[name];
  const r = await timed(fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": c.ua, "Accept-Language": "en", Cookie: COOKIE },
    body: JSON.stringify(Object.assign({ videoId: id, context: Object.assign({ client: c.client }, c.thirdParty ? { thirdParty: c.thirdParty } : {}) }, { contentCheckOk: true, racyCheckOk: true }))
  }), ms);
  if (!r.ok) throw new Error(name + " " + r.status);
  return r.json();
}
async function captions(p, ms) {
  const tracks = (((p || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  if (!tracks.length) throw new Error("no caption tracks");
  const t = tracks.find(x => /^en/.test(x.languageCode) && x.kind !== "asr") || tracks.find(x => /^en/.test(x.languageCode)) || tracks[0];
  let url = t.baseUrl; if (!/[?&]fmt=/.test(url)) url += "&fmt=json3";
  const r = await timed(fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en", Cookie: COOKIE } }), ms), body = await r.text();
  let out = "";
  if (body.trim()) {
    try { const j = JSON.parse(body); out = (j.events || []).map(e => (e.segs || []).map(s => s.utf8 || "").join("")).join(" "); }
    catch (e) { out = dec(body.replace(/<[^>]+>/g, " ")); }   // older XML format
  }
  out = clean(out); if (out.length < 40) throw new Error("empty captions"); return out;
}
// find something anywhere inside YouTube's page data
function find(node, test, out = []) {
  if (!node || typeof node !== "object") return out;
  if (test(node)) out.push(node);
  for (const k in node) find(node[k], test, out);
  return out;
}
async function watchPage(id, ms) {
  const r = await timed(fetch(`https://www.youtube.com/watch?v=${id}&hl=en&bpctr=9999999999&has_verified=1`, { headers: { "User-Agent": UA, "Accept-Language": "en", Cookie: COOKIE } }), ms);
  const html = await r.text();
  const grab = re => { const m = html.match(re); if (!m) return null; try { return JSON.parse(m[1]); } catch (e) { return null; } };
  return { html, player: grab(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s), data: grab(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s),
    key: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1], ver: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || "2.20241120.01.00",
    visitor: (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] };
}
// what YouTube's own "Show transcript" button uses
async function transcriptPanel(w, ms) {
  const ep = find(w.data, n => n.getTranscriptEndpoint && n.getTranscriptEndpoint.params)[0];
  if (!ep) throw new Error("no transcript panel");
  const r = await timed(fetch("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false" + (w.key ? "&key=" + w.key : ""), {
    method: "POST", headers: Object.assign({ "Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "en", Cookie: COOKIE, Origin: "https://www.youtube.com" }, w.visitor ? { "X-Goog-Visitor-Id": w.visitor } : {}),
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: w.ver, hl: "en", gl: "US", visitorData: w.visitor } }, params: ep.getTranscriptEndpoint.params })
  }), ms);
  if (!r.ok) throw new Error("transcript " + r.status);
  const j = await r.json();
  const segs = find(j, n => n.transcriptSegmentRenderer).map(n => ((n.transcriptSegmentRenderer.snippet || {}).runs || []).map(x => x.text).join(""));
  const out = clean(segs.join(" ")); if (out.length < 40) throw new Error("empty transcript"); return out;
}
// "0:00 Intro" lines in a description → chapters
const chaptersOf = d => String(d || "").split("\n").map(l => l.match(/^\s*\(?((?:\d+:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.{3,90})$/)).filter(Boolean).map(m => m[1] + " " + m[2].trim()).slice(0, 40);
// any promise that succeeds first (Promise.any without needing a new Node version)
const first = ps => new Promise((res, rej) => { let left = ps.length; if (!left) rej(new Error("none")); ps.forEach(p => p.then(res, () => { if (--left === 0) rej(new Error("all failed")); })); });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const g = await gate(event);
  if (g.error) return g.error;
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const id = idOf(body.url);
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "That doesn't look like a YouTube link." }) };

  const end = Date.now() + 8500, left = () => end - Date.now();
  const out = { id, title: "", author: "", description: "", seconds: 0, chapters: [], transcript: "", via: "" };
  const take = p => { const d = (p || {}).videoDetails || {}; if (d.title && !out.title) out.title = String(d.title).slice(0, 200); if (d.author && !out.author) out.author = String(d.author).slice(0, 100);
    if (d.shortDescription && !out.description) out.description = String(d.shortDescription).slice(0, 4000); if (d.lengthSeconds && !out.seconds) out.seconds = +d.lengthSeconds || 0; return p; };

  // the title and channel from YouTube's public oEmbed (almost never blocked)
  const oembed = timed(fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`), 7500)
    .then(r => r.ok ? r.json() : null).then(j => { if (j) { if (!out.title) out.title = String(j.title || "").slice(0, 200); if (!out.author) out.author = String(j.author_name || "").slice(0, 100); } }).catch(() => {});
  // the watch page: description, chapters and the "Show transcript" route
  const page = watchPage(id, 7000).then(w => { take(w.player); if (w.data && !out.description) { const d = find(w.data, n => n.attributedDescriptionBodyText)[0]; if (d) out.description = String(d.attributedDescriptionBodyText.content || "").slice(0, 4000); } return w; });
  const routes = [
    ...["ANDROID", "IOS", "TV", "MWEB"].map(n => player(id, n, 5000).then(take).then(p => captions(p, Math.min(4000, left() - 300))).then(t => ({ t, via: n }))),
    page.then(w => captions(w.player, Math.min(4000, left() - 300)).then(t => ({ t, via: "web" }))),
    page.then(w => transcriptPanel(w, Math.min(4500, left() - 300)).then(t => ({ t, via: "transcript panel" })))
  ];
  try { const win = await timed(first(routes), left()); out.transcript = win.t.slice(0, 24000); out.via = win.via; } catch (e) {}
  await timed(Promise.allSettled([oembed, page.catch(() => {})]), Math.max(300, Math.min(1500, left())));
  out.chapters = chaptersOf(out.description);
  if (!out.title && !out.transcript) return { statusCode: 404, body: JSON.stringify({ error: "I couldn't open that video. Check the link." , id }) };
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(out) };
};
exports._t = { idOf, chaptersOf, find, captions, first };
