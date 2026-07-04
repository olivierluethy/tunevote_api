const {
  pool,
  cleanupSession,
  assertEqual,
} = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");

// Exercises the collapsed voting_rounds.state through advanceToNext's emergency
// auto-promotion: open round (state IN suggesting/voting) → pick voted winner →
// close round (state='closed'). Also proves the dropped phase/status columns
// don't break any voting query.
module.exports = async () => {
  const [[u]] = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  for (const v of ["TESTVS00001", "TESTVS00002", "TESTVS00003"]) {
    await pool.query(
      `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, duration)
       VALUES (?, ?, ?, 30) ON DUPLICATE KEY UPDATE duration = VALUES(duration)`,
      [v, "t_" + v, "t_" + v],
    );
  }
  const [s] = await pool.query(
    `INSERT INTO sessions (user_id, title, is_live, is_private, created_at)
     VALUES (?, 'TEST_VS', 1, 0, NOW())`,
    [u.id],
  );
  const sessionId = s.insertId;
  await pool.query(
    `INSERT INTO session_participants (session_id, user_id, role, is_live, last_seen, joined_at)
     VALUES (?, ?, 'host', 1, NOW(), NOW())`,
    [sessionId, u.id],
  );
  const [r] = await pool.query(
    `INSERT INTO voting_rounds (session_id, state, phase_ends_at, suggestion_duration, voting_duration)
     VALUES (?, 'suggesting', DATE_ADD(NOW(), INTERVAL 60 SECOND), 90, 60)`,
    [sessionId],
  );
  const roundId = r.insertId;
  const [p1] = await pool.query(
    `INSERT INTO queue_items (session_id, video_id, status, item_type, item_source, startedAt, created_at)
     VALUES (?, 'TESTVS00001', 'playing', 'music', 'user', NOW(), NOW())`,
    [sessionId],
  );
  const [g1] = await pool.query(
    `INSERT INTO queue_items (session_id, video_id, status, item_type, item_source, voting_round_id, created_at)
     VALUES (?, 'TESTVS00002', 'suggested', 'music', 'user', ?, NOW())`,
    [sessionId, roundId],
  );
  await pool.query(
    `INSERT INTO queue_items (session_id, video_id, status, item_type, item_source, voting_round_id, created_at)
     VALUES (?, 'TESTVS00003', 'suggested', 'music', 'user', ?, NOW())`,
    [sessionId, roundId],
  );
  await pool.query(`INSERT INTO votes (queue_item_id, user_id) VALUES (?, ?)`, [
    g1.insertId,
    u.id,
  ]);

  // No 'queued' item → advanceToNext must emergency-promote the winner.
  await advanceToNext(sessionId, p1.insertId);

  const [[round]] = await pool.query(
    `SELECT state, winner_queue_item_id FROM voting_rounds WHERE id = ?`,
    [roundId],
  );
  assertEqual(round.state, "closed", "round closed via state='closed'");
  assertEqual(round.winner_queue_item_id, g1.insertId, "voted song won");

  const [[playing]] = await pool.query(
    `SELECT id FROM queue_items WHERE session_id = ? AND status = 'playing'`,
    [sessionId],
  );
  assertEqual(playing.id, g1.insertId, "winner is now playing");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
