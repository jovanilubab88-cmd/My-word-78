// Netlify Function: /.netlify/functions/book-file
// Keeps the original book files (PDF, EPUB, Word …) from the Smart Reader in your account,
// so a book opens on its real pages on every device — whatever its size.
// Files are stored in pieces of up to 3 MB in Netlify Blobs, under the signed-in person's own ID.
//   POST   ?book=ID&n=K   body = one piece (binary)   → saves piece K
//   GET    ?book=ID&n=K                              → returns piece K
//   DELETE ?book=ID                                  → removes every piece of that book
const { caller, reply } = require("../lib/fb.js");
let blobs = null; try { blobs = require("@netlify/blobs"); } catch (e) {}

const MAX_PIECE = 3.2 * 1024 * 1024;
const cleanId = v => (/^[\w-]{1,100}$/.test(String(v || "")) ? String(v) : "");

function store(event) {
  if (!blobs) return null;
  try { blobs.connectLambda(event); } catch (e) {}
  try { return blobs.getStore("book-files"); } catch (e) { return null; }
}

exports.handler = async function (event) {
  const c = await caller(event);
  if (!c.configured) return reply(503, { error: "not_configured", message: "Add FIREBASE_SERVICE_ACCOUNT in Netlify first." });
  if (!c.user) return reply(401, { error: "login_required", message: "Please log in." });
  const st = store(event);
  if (!st) return reply(503, { error: "no_storage", message: "File storage isn't available on this site." });

  const q = event.queryStringParameters || {}, book = cleanId(q.book), n = Number.isInteger(+q.n) && +q.n >= 0 && +q.n < 2000 ? +q.n : -1;
  if (!book) return reply(400, { error: "bad_book" });
  const prefix = `${c.user.uid}/${book}/`;

  try {
    if (event.httpMethod === "POST") {
      if (n < 0) return reply(400, { error: "bad_piece" });
      const buf = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "binary");
      if (!buf.length || buf.length > MAX_PIECE) return reply(413, { error: "piece_too_big" });
      await st.set(prefix + n, buf);
      return reply(200, { ok: true, n, size: buf.length });
    }
    if (event.httpMethod === "GET") {
      if (n < 0) return reply(400, { error: "bad_piece" });
      const data = await st.get(prefix + n, { type: "arrayBuffer" });
      if (!data) return reply(404, { error: "not_found" });
      return { statusCode: 200, headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=31536000, immutable" }, body: Buffer.from(data).toString("base64"), isBase64Encoded: true };
    }
    if (event.httpMethod === "DELETE") {
      const { blobs: list } = await st.list({ prefix });
      await Promise.all((list || []).map(b => st.delete(b.key).catch(() => {})));
      return reply(200, { ok: true, removed: (list || []).length });
    }
    return reply(405, { error: "Method Not Allowed" });
  } catch (e) {
    console.error("book-file", e && e.message);
    return reply(500, { error: "storage_failed", message: String((e && e.message) || "failed").slice(0, 200) });
  }
};
