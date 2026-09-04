// ---------------------------------------------------------------------------
// SECTION COMPLETION HOOK (#66, Slice 3)
//
// Standalone (db-only) so playback.js can require it without a cycle. Called from
// advanceToNext right after an item is marked 'played': if that was the last
// queued item of its section and the section has an on_complete rule, stamp
// completed_at so the reconciler (changeRequests.processSectionCompletions) fires
// the rule exactly once. Mirrors the loops on_complete mechanism.
// ---------------------------------------------------------------------------
const pool = require("../db");

async function onItemPlayed(conn, sessionId, itemId) {
  if (!itemId) return;
  const [[it]] = await conn.query(
    `SELECT section_id FROM queue_items WHERE id = ?`,
    [itemId],
  );
  const sectionId = it?.section_id;
  if (!sectionId) return;

  const [[sec]] = await conn.query(
    `SELECT id, on_complete, completed_at FROM sections
      WHERE id = ? AND session_id = ? AND status = 'active'`,
    [sectionId, sessionId],
  );
  if (!sec || sec.on_complete === "none" || sec.completed_at) return;

  const [[rem]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM queue_items
      WHERE session_id = ? AND section_id = ? AND status IN ('queued','playing')`,
    [sessionId, sectionId],
  );
  if (rem.cnt > 0) return; // section not finished yet

  await conn.query(`UPDATE sections SET completed_at = NOW() WHERE id = ?`, [
    sectionId,
  ]);
}

module.exports = { onItemPlayed };
