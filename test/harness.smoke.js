const {
  pool,
  seedLiveSession,
  cleanupSession,
  assertEqual,
} = require("./helpers/fixtures");

module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTVID0001", duration: 5 },
      { id: "TESTVID0002", duration: 5 },
    ],
  });
  const [rows] = await pool.query(
    `SELECT status FROM queue_items WHERE session_id = ? ORDER BY id`,
    [sessionId],
  );
  assertEqual(rows[0].status, "playing", "first item playing");
  assertEqual(rows[1].status, "queued", "second item queued");
  await cleanupSession(pool, sessionId);
  await pool.end();
};
