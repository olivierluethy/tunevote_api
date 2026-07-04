const {
  pool,
  seedLiveSession,
  cleanupSession,
  assertEqual,
} = require("./helpers/fixtures");
const { reconcileOnce } = require("../services/scheduler");

// An overdue live session is advanced by the reconciler even with no in-memory
// timer (simulating a post-restart recovery).
module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTREC0001", duration: 5 },
      { id: "TESTREC0002", duration: 5 },
    ],
  });
  // Its current song's deadline already passed; no timer exists in this process.
  await pool.query(
    `UPDATE sessions SET current_plays_until = DATE_SUB(NOW(), INTERVAL 10 SECOND) WHERE id = ?`,
    [sessionId],
  );

  const res = await reconcileOnce({ graceSeconds: 30 });
  assertEqual(res.advanced >= 1, true, "reconciler advanced at least one session");

  const [[playing]] = await pool.query(
    `SELECT video_id FROM queue_items WHERE session_id = ? AND status = 'playing'`,
    [sessionId],
  );
  assertEqual(playing.video_id, "TESTREC0002", "advanced to the second song");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
