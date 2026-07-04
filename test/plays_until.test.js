const {
  pool,
  seedLiveSession,
  cleanupSession,
  assert,
} = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");

// After an advance, the session carries a durable deadline for the new song.
module.exports = async () => {
  const { sessionId, itemIds } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTDL00001", duration: 5 },
      { id: "TESTDL00002", duration: 42 },
    ],
  });

  await advanceToNext(sessionId, itemIds[0]); // now the 42s song is playing

  const [[row]] = await pool.query(
    `SELECT TIMESTAMPDIFF(SECOND, NOW(), current_plays_until) AS secs FROM sessions WHERE id = ?`,
    [sessionId],
  );
  assert(
    row.secs >= 38 && row.secs <= 44,
    `deadline should be ~42s out, got ${row.secs}`,
  );

  await cleanupSession(pool, sessionId);
  await pool.end();
};
