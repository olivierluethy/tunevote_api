const {
  pool,
  seedLiveSession,
  cleanupSession,
  assertEqual,
} = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");

// Deterministic guard against the double-advance race: advanceToNext takes the
// item the caller believed was playing. A stale/duplicate call for an item that
// already finished must be a no-op (compare-and-swap), so the queue never skips.
module.exports = async () => {
  const { sessionId, itemIds } = await seedLiveSession(pool, {
    videos: [
      { id: "TESTADV0001", duration: 5 },
      { id: "TESTADV0002", duration: 5 },
      { id: "TESTADV0003", duration: 5 },
    ],
  });
  const [item0, item1, item2] = itemIds;

  // Legit advance from the currently-playing item0 → item1 plays.
  await advanceToNext(sessionId, item0);

  // Stale/duplicate advance for the already-finished item0 must NOT advance again.
  await advanceToNext(sessionId, item0);

  // Also: two concurrent advances for the SAME current item collapse to one.
  await Promise.all([
    advanceToNext(sessionId, item1),
    advanceToNext(sessionId, item1),
  ]);

  const [rows] = await pool.query(
    `SELECT id, status FROM queue_items WHERE session_id = ? ORDER BY id`,
    [sessionId],
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));

  assertEqual(byId[item0], "played", "item0 played");
  assertEqual(byId[item1], "played", "item1 played (advanced once, not skipped by the stale call)");
  assertEqual(byId[item2], "playing", "item2 playing (exactly two advances total)");

  const playing = rows.filter((r) => r.status === "playing").length;
  assertEqual(playing, 1, "exactly one row playing");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
