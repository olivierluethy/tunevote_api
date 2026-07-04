const {
  pool,
  seedLiveSession,
  cleanupSession,
  assertEqual,
} = require("./helpers/fixtures");
const { reconcileOnce } = require("../services/scheduler");

// The reaper drops participants whose heartbeat has gone stale, but leaves
// recently-seen ones alone.
module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTHB00001", duration: 5 },
      { id: "TESTHB00002", duration: 5 },
    ],
  });
  const [[u]] = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);

  // Fresh heartbeat → must survive the reaper.
  await pool.query(
    `INSERT INTO session_participants (session_id, user_id, role, is_live, last_seen, joined_at)
     VALUES (?, ?, 'host', 1, NOW(), NOW())`,
    [sessionId, u.id],
  );
  await reconcileOnce({ graceSeconds: 30 });
  const [[live]] = await pool.query(
    `SELECT is_live FROM session_participants WHERE session_id = ? AND user_id = ?`,
    [sessionId, u.id],
  );
  assertEqual(live.is_live, 1, "recent-heartbeat participant survives reaper");

  // Stale heartbeat → must be reaped.
  await pool.query(
    `UPDATE session_participants SET last_seen = DATE_SUB(NOW(), INTERVAL 5 MINUTE)
     WHERE session_id = ? AND user_id = ?`,
    [sessionId, u.id],
  );
  await reconcileOnce({ graceSeconds: 30 });
  const [[dead]] = await pool.query(
    `SELECT is_live FROM session_participants WHERE session_id = ? AND user_id = ?`,
    [sessionId, u.id],
  );
  assertEqual(dead.is_live, 0, "stale participant reaped");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
