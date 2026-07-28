// encoding_roundtrip.test.js — guards against UTF-8 → CP1252 mojibake regressions.
//
// Proves a non-ASCII string survives the WHOLE pipeline end to end:
//   write to MySQL  →  read back (HEX byte check)  →  serve over the real HTTP
//   route  →  parse the JSON response bytes.
//
// If the DB connection charset regresses to latin1 (the original bug), the
// stored bytes or the API response bytes change and this test FAILS.
//
// Run: node test/run.js test/encoding_roundtrip.test.js   (against LOCAL DB)

const http = require("http");
const express = require("express");
const { pool, assert, assertEqual } = require("./helpers/fixtures");
const { normalize } = require("../utils/helpers");

// A deliberately nasty string: smart apostrophe, umlauts, accent, en-dash and an
// emoji — exactly the mix the acceptance criteria calls out.
const TRICKY = "Rag’n’Bone Man – Güíltÿ ä ü é 😀";
const YT_ID = "ENCTEST0001"; // VARCHAR(11), unique
const APOSTROPHE_UTF8 = "E28099"; // U+2019 correctly stored

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw: Buffer.concat(chunks), // raw bytes, before any decoding
          }),
        );
      })
      .on("error", reject);
  });
}

module.exports = async () => {
  // Clean any leftover from a previous run.
  await pool.query(`DELETE FROM youtube_video_cache WHERE youtube_id = ?`, [YT_ID]);

  // --- 1. WRITE (same parameterized path the app uses) ---
  await pool.query(
    `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, duration, public_id)
     VALUES (?, ?, ?, ?, UUID())`,
    [YT_ID, TRICKY, normalize(TRICKY), 0],
  );

  // --- 2. READ BACK + byte-level check ---
  const [[row]] = await pool.query(
    `SELECT title, HEX(title) AS hex_title FROM youtube_video_cache WHERE youtube_id = ?`,
    [YT_ID],
  );
  assertEqual(row.title, TRICKY, "DB round-trip title mismatch");
  assert(
    row.hex_title.includes(APOSTROPHE_UTF8),
    `apostrophe not stored as UTF-8 ${APOSTROPHE_UTF8}; HEX=${row.hex_title}`,
  );
  assert(
    !row.hex_title.includes("C3A2E282AC"),
    "title contains the CP1252 double-encoding signature C3A2E282AC",
  );

  // --- 3. SERVE over the real route and check the response BYTES ---
  const app = express();
  app.use(express.json());
  app.use(require("../routes/youtube"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const res = await getJson(port, `/youtube-info/${YT_ID}`);
    assertEqual(res.status, 200, "GET /youtube-info status");
    assert(
      /charset=utf-8/i.test(res.headers["content-type"] || ""),
      `response is not declared utf-8: ${res.headers["content-type"]}`,
    );
    // Parse the RAW bytes as UTF-8 and confirm the exact title survived.
    const body = JSON.parse(res.raw.toString("utf8"));
    assertEqual(body.snippet.title, TRICKY, "API response title mismatch");
    // And the correct apostrophe bytes must be physically present in the payload.
    assert(
      res.raw.includes(Buffer.from(APOSTROPHE_UTF8, "hex")),
      "API response bytes do not contain the UTF-8 apostrophe E2 80 99",
    );
  } finally {
    await new Promise((r) => server.close(r));
    await pool.query(`DELETE FROM youtube_video_cache WHERE youtube_id = ?`, [YT_ID]);
    await pool.end();
  }

  console.log("✓ non-ASCII string survived write → read → API response round-trip");
};
