const pool = require("../db");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve a route param to a native integer id for `artists` or `users`.
// If the param is a UUID it's looked up by public_id; otherwise it's assumed
// to already be the native id. Returns null if a UUID doesn't match anything.
// `table` is always a fixed internal constant — never user input.
async function resolveId(table, param) {
  const p = String(param);
  if (!UUID_RE.test(p)) return param;
  const [[row]] = await pool.query(
    `SELECT id FROM ${table} WHERE public_id = ? LIMIT 1`,
    [p],
  );
  return row ? row.id : null;
}

// Resolve a song param to its youtube_id. Accepts a UUID public_id or the raw
// 11-char youtube_id.
async function resolveVideoId(param) {
  const p = String(param);
  if (!UUID_RE.test(p)) return param;
  const [[row]] = await pool.query(
    "SELECT youtube_id FROM youtube_video_cache WHERE public_id = ? LIMIT 1",
    [p],
  );
  return row ? row.youtube_id : null;
}

// Resolve a session route param (UUID public_id or numeric id) to the numeric
// session id. Sessions stay numeric everywhere internally; only the URL uses
// the public_id.
async function resolveSessionId(param) {
  const p = String(param);
  if (!UUID_RE.test(p)) return param;
  const [[row]] = await pool.query(
    "SELECT id FROM sessions WHERE public_id = ? LIMIT 1",
    [p],
  );
  return row ? row.id : null;
}

module.exports = { resolveId, resolveVideoId, resolveSessionId, UUID_RE };
