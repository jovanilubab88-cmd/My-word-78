const { gate } = require("../lib/fb.js");
// Netlify Function: /.netlify/functions/yt
// Advanced Math "Video helper": given a YouTube link, returns the video's title, channel, description and captions (transcript)
// so the tutor AI can summarise it. No API key needed. Only youtube.com is contacted, and only for the one video asked for.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const idOf = s => { const m = String(s || "").match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || String(s || "").trim().match(/^([\w-]{11})$/); return m ? m[1] : ""; };
const dec = s => String(s || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function playerInnertube(id) {            // the mobile-app endpoint: caption links from here usually work without extra tokens
  const r = await timed(fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip", "Accept-Language": "en" },
    body: JSON.stringify({ videoId: id, context: { client: { clientName: "ANDROID", clientVersion: "19.29.37", androidSdkVersion: 34, hl: "en", gl: "US" } } })
  }), 6000);
  if (!r.ok) throw new Error("player " + r.status);
  return r.json();
}
async function playerWatchPage(id) {             // fallback: read the same data out of the normal watch page
  const r = await timed(fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { "User-Agent": UA, "Accept-Language": "en", Cookie: "CONSENT=YES+1; SOCS=CAI" } }), 6000);
  const html = await r.text(), m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
  if (!m) throw new Error("no player data");
  return JSON.parse(m[1]);
}
async function captions(player) {
  const tracks = (((player || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  if (!tracks.length) return "";
  const t = tracks.find(x => /^en/.test(x.languageCode) && x.kind !== "asr") || tracks.find(x => /^en/.test(x.languageCode)) || tracks[0];
  let url = t.baseUrl; if (!/[?&]fmt=/.test(url)) url += "&fmt=json3";
  const r = await timed(fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } }), 6000), txt = await r.text();
  if (!txt.trim()) return "";
  try { const j = JSON.parse(txt); return (j.events || []).map(e => (e.segs || []).map(s => s.utf8 || "").join("")).join(" ").replace(/\s+/g, " ").trim(); }
  catch (e) { return dec(txt.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }   // older XML format
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const g = await gate(event);
  if (g.error) return g.error;
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const id = idOf(body.url);
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "That doesn't look like a YouTube link." }) };

  const out = { id, title: "", author: "", description: "", seconds: 0, transcript: "" };
  const take = p => { const d = (p || {}).videoDetails || {}; if (d.title && !out.title) out.title = String(d.title).slice(0, 200); if (d.author && !out.author) out.author = String(d.author).slice(0, 100); if (d.shortDescription && !out.description) out.description = String(d.shortDescription).slice(0, 1500); if (+d.lengthSeconds && !out.seconds) out.seconds = +d.lengthSeconds; };
  for (const get of [playerInnertube, playerWatchPage]) {
    try { const p = await get(id); take(p); if (!out.transcript) out.transcript = await captions(p); } catch (e) {}
    if (out.transcript) break;
  }
  if (!out.title) {                                // last resort for the title: YouTube's public oEmbed
    try { const r = await timed(fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`), 4000); if (r.ok) { const j = await r.json(); out.title = String(j.title || "").slice(0, 200); out.author = String(j.author_name || "").slice(0, 100); } } catch (e) {}
  }
  out.transcript = out.transcript.slice(0, 24000);
  if (!out.title && !out.transcript) return { statusCode: 404, body: JSON.stringify({ error: "I couldn't open that video. Check the link, or paste the transcript instead." }) };
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(out) };
};
