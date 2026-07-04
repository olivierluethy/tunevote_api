const { pool, assertEqual } = require("./helpers/fixtures");
const { reconcileOnce } = require("../services/scheduler");

// C1: sessions.status is dual-written alongside is_live. A live-but-dead session
// ended by the reconciler must land status='ended' AND is_live=0 (mirrors stay
// consistent during the transition).
module.exports = async () => {
  const [[u]] = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  const [s] = await pool.query(
    `INSERT INTO sessions (user_id, title, is_live, status, is_private, created_at)
     VALUES (?, 'TEST_STATUS', 1, 'live', 0, NOW())`,
    [u.id],
  );
  const sessionId = s.insertId;

  // No queue, no live participants, no open round → reconciler ends it.
  await reconcileOnce({ graceSeconds: 30 });

  const [[row]] = await pool.query(
    `SELECT is_live, status FROM sessions WHERE id = ?`,
    [sessionId],
  );
  assertEqual(row.status, "ended", "status dual-written to 'ended'");
  assertEqual(row.is_live, 0, "is_live mirror stays consistent with status");

  await pool.query(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
  await pool.end();
};
