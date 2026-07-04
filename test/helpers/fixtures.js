const pool = require("../../db");

function assert(cond, msg) {
  if (!cond) throw new Error("assert: " + (msg || "failed"));
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`assertEqual: ${msg || ""} — expected ${b}, got ${a}`);
}

// Seed a throwaway live session with a music queue. Upserts youtube_video_cache
// first (queue_items.video_id is a RESTRICT FK). One item is 'playing', the
// rest 'queued'. Returns created ids.
async function seedLiveSession(pool_, { videos, startPlayingIndex = 0 }) {
  for (const v of videos) {
    await pool_.query(
      `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, duration)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE duration = VALUES(duration)`,
      [v.id, "t_" + v.id, "t_" + v.id, v.duration],
    );
  }
  const [[u]] = await pool_.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  if (!u) throw new Error("seedLiveSession: no users exist in the DB to host a session");
  const [s] = await pool_.query(
    `INSERT INTO sessions (user_id, title, is_live, is_private, created_at)
     VALUES (?, 'TEST_SESSION', 1, 0, NOW())`,
    [u.id],
  );
  const sessionId = s.insertId;
  const itemIds = [];
  for (let i = 0; i < videos.length; i++) {
    const status = i === startPlayingIndex ? "playing" : "queued";
    const startedAt = i === startPlayingIndex ? new Date() : null;
    const [r] = await pool_.query(
      `INSERT INTO queue_items
         (session_id, video_id, status, item_type, item_source, startedAt, created_at)
       VALUES (?, ?, ?, 'music', 'user', ?, NOW())`,
      [sessionId, videos[i].id, status, startedAt],
    );
    itemIds.push(r.insertId);
  }
  await pool_.query(
    `INSERT INTO playback_sync (session_id, current_video_id, video_start_time, is_playing)
     VALUES (?, ?, ?, 1)`,
    [sessionId, videos[startPlayingIndex].id, Date.now()],
  );
  return { sessionId, itemIds };
}

async function cleanupSession(pool_, sessionId) {
  await pool_.query(`DELETE FROM sessions WHERE id = ?`, [sessionId]); // cascades
}

module.exports = { pool, assert, assertEqual, seedLiveSession, cleanupSession };
