const pool = require("../db");
const { advanceToNext, broadcastParticipantCount } = require("./playback");

// ---------------------------------------------------------------------------
// RECONCILER
//
// The database is authoritative. In-memory setTimeout is only a low-latency
// optimization; this loop is the safety net that makes playback survive
// restarts and makes "stuck live" impossible:
//   1. advance any live session whose current song deadline has passed,
//   2. reap participants whose heartbeat has gone stale,
//   3. end sessions that are live but truly have nothing left + nobody live.
// On boot it runs immediately, rebuilding work from the DB (current_plays_until)
// with no reliance on timers that a crash would have wiped.
//
// Single-process today. For multiple instances later, guard reconcileOnce with
// a MySQL advisory lock (SELECT GET_LOCK) so exactly one instance ticks.
// ---------------------------------------------------------------------------

let timer = null;

async function reconcileOnce({ graceSeconds = 30 } = {}) {
  let advanced = 0;
  let ended = 0;

  // 1) Advance songs whose deadline has passed. Pass the current playing item id
  //    so advanceToNext's compare-and-swap no-ops if a timer already advanced.
  const [overdue] = await pool.query(
    `SELECT s.id AS session_id, q.id AS item_id
       FROM sessions s
       LEFT JOIN queue_items q
         ON q.session_id = s.id AND q.status = 'playing'
      WHERE s.is_live = 1
        AND s.current_plays_until IS NOT NULL
        AND s.current_plays_until < NOW()`,
  );
  for (const row of overdue) {
    await advanceToNext(row.session_id, row.item_id ?? null);
    advanced++;
  }

  // 2) Reap participants with no recent heartbeat. This is what makes the count
  //    self-healing: a user who crashed, closed the tab, or lost connection
  //    stops sending heartbeats and is dropped here. We first note which sessions
  //    are affected, then broadcast their fresh presence-derived count so the
  //    live viewer count drops for everyone without a page refresh.
  const [staleSessions] = await pool.query(
    `SELECT DISTINCT session_id
       FROM session_participants
      WHERE is_live = 1
        AND (last_seen IS NULL OR last_seen < DATE_SUB(NOW(), INTERVAL ? SECOND))`,
    [graceSeconds],
  );
  if (staleSessions.length) {
    await pool.query(
      `UPDATE session_participants
          SET is_live = 0
        WHERE is_live = 1
          AND (last_seen IS NULL OR last_seen < DATE_SUB(NOW(), INTERVAL ? SECOND))`,
      [graceSeconds],
    );
    for (const { session_id } of staleSessions) {
      await broadcastParticipantCount(session_id);
    }
  }

  // 3) End sessions that are live but have nothing playable, nobody live, and no
  //    open voting round — self-heals the "stuck live after kill" bug.
  const [dead] = await pool.query(
    `SELECT s.id
       FROM sessions s
      WHERE s.is_live = 1
        AND NOT EXISTS (
          SELECT 1 FROM queue_items q
           WHERE q.session_id = s.id
             AND q.status IN ('playing', 'queued', 'suggested'))
        AND NOT EXISTS (
          SELECT 1 FROM session_participants p
           WHERE p.session_id = s.id AND p.is_live = 1)
        AND NOT EXISTS (
          SELECT 1 FROM voting_rounds v
           WHERE v.session_id = s.id AND v.status = 'open')`,
  );
  for (const s of dead) {
    const [r] = await pool.query(
      `UPDATE sessions SET is_live = 0, ended_at = NOW() WHERE id = ? AND is_live = 1`,
      [s.id],
    );
    if (r.affectedRows) ended++;
  }

  return { advanced, ended };
}

function startReconciler({ intervalMs = 2000, graceSeconds = 30 } = {}) {
  if (timer) return;
  const tick = () =>
    reconcileOnce({ graceSeconds }).catch((e) =>
      console.error("reconciler tick failed:", e.message),
    );
  tick(); // immediate pass on boot rebuilds overdue work
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  console.log("⏱️  Reconciler started");
}

function stopReconciler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startReconciler, stopReconciler, reconcileOnce };
