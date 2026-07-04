const {
  pool,
  seedLiveSession,
  cleanupSession,
  assert,
} = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");

// "Now playing" is derived from the queue row (no playback_sync table).
module.exports = async () => {
  const { sessionId, itemIds } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTPS00001", duration: 5 },
      { id: "TESTPS00002", duration: 30 },
    ],
  });
  await advanceToNext(sessionId, itemIds[0]); // item2 now playing, startedAt=NOW()

  const [[row]] = await pool.query(
    `SELECT qi.video_id AS current_video_id,
            UNIX_TIMESTAMP(qi.startedAt) * 1000 AS video_start_time,
            (s.is_live = 1 AND qi.item_type = 'music') AS is_playing
       FROM sessions s
       JOIN queue_items qi ON qi.session_id = s.id AND qi.status = 'playing'
      WHERE s.id = ?`,
    [sessionId],
  );

  assert(row.current_video_id === "TESTPS00002", "derives current video");
  assert(Number(row.is_playing) === 1, "derives is_playing");
  assert(
    Math.abs(row.video_start_time - Date.now()) < 5000,
    "derived start time is ~now",
  );

  await cleanupSession(pool, sessionId);
  await pool.end();
};
