const pool = require("../db");
const { advanceToNext, broadcastParticipantCount } = require("./playback");
const { generateAiSuggestions } = require("./recommendations");
const {
  reconcileExpired: reconcileExpiredChangeRequests,
  autoProposePauses,
  processLoopCompletions,
  processSectionCompletions,
  proposeAiSuggestions,
} = require("./changeRequests");

// Sessions with an AI auto-fill generation in flight. Prevents the reconciler
// from starting a second (expensive) OpenAI/YouTube generation for the same
// session across ticks. Single-process, so an in-memory Set is enough.
const autoFilling = new Set();

// Per-session cooldown so we don't re-generate every couple of seconds. Crucial
// for cost: if generation yields 0 (e.g. the YouTube quota is exhausted so
// nothing maps), the "dry" condition stays true — without a cooldown the
// reconciler would call OpenAI in a tight loop. Short cooldown after a real
// fill; long back-off after an empty result or an error.
const autoFillCooldownUntil = new Map(); // sessionId -> epoch ms
const AUTOFILL_COOLDOWN_OK_MS = 30_000;
const AUTOFILL_COOLDOWN_EMPTY_MS = 300_000;

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

async function reconcileOnce({
  graceSeconds = 30,
  emptyGraceSeconds = 600,
  autoFillEnabled = true,
} = {}) {
  let advanced = 0;
  let ended = 0;
  let autoFilled = 0;

  // 0) Resolve change requests whose vote deadline has passed. Durable safety net
  //    for the in-memory expiry timers (survives a restart), mirroring how the
  //    playback deadline below is reconciled from the DB. Never throws upward.
  try {
    await reconcileExpiredChangeRequests();
  } catch (e) {
    console.error("[reconciler] change-request expiry failed:", e.message);
  }

  // Auto-pause rule: propose a pause after N songs where the rule is enabled.
  try {
    await autoProposePauses();
  } catch (e) {
    console.error("[reconciler] auto-pause failed:", e.message);
  }

  // Loop "what happens after": propose a pause when a loop with that rule ends.
  try {
    await processLoopCompletions();
  } catch (e) {
    console.error("[reconciler] loop on-complete failed:", e.message);
  }

  // Section "what happens after": fire a completed section's on_complete rule.
  try {
    await processSectionCompletions();
  } catch (e) {
    console.error("[reconciler] section on-complete failed:", e.message);
  }

  // AI suggestions: opt-in, key-gated. No-op unless a session enabled the rule.
  try {
    await proposeAiSuggestions();
  } catch (e) {
    console.error("[reconciler] ai-suggest failed:", e.message);
  }

  // 1) Advance songs whose deadline has passed. Pass the current playing item id
  //    so advanceToNext's compare-and-swap no-ops if a timer already advanced.
  const [overdue] = await pool.query(
    `SELECT s.id AS session_id, q.id AS item_id
       FROM sessions s
       LEFT JOIN queue_items q
         ON q.session_id = s.id AND q.status = 'playing'
      WHERE s.status = 'live'
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
      WHERE s.status = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM queue_items q
           WHERE q.session_id = s.id
             AND q.status IN ('playing', 'queued', 'suggested'))
        AND NOT EXISTS (
          SELECT 1 FROM session_participants p
           WHERE p.session_id = s.id AND p.is_live = 1)
        AND NOT EXISTS (
          SELECT 1 FROM voting_rounds v
           WHERE v.session_id = s.id AND v.state IN ('suggesting','voting'))`,
  );
  for (const s of dead) {
    const [r] = await pool.query(
      `UPDATE sessions SET is_live = 0, status = 'ended', ended_at = NOW() WHERE id = ? AND is_live = 1`,
      [s.id],
    );
    if (r.affectedRows) ended++;
  }

  // 3b) End sessions everyone has abandoned: still 'live', but no participant has
  //     been present for `emptyGraceSeconds`. Unlike phase 3 this deliberately
  //     does NOT require the queue or an open voting round to be empty — a host
  //     who simply closes the tab leaves queued songs (and sometimes an open
  //     round) behind, and phase 3's `NOT EXISTS queue_items` then never fires,
  //     stranding the session "live" forever. Presence, not leftover content,
  //     decides a session is dead. The grace window (each participant's
  //     last_seen, or the session's created_at when nobody ever joined)
  //     tolerates brief disconnects/reconnects so we never end a session someone
  //     is still in — a returning user heartbeats and is excluded next tick.
  const [abandoned] = await pool.query(
    `SELECT s.id
       FROM sessions s
      WHERE s.status = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM session_participants p
           WHERE p.session_id = s.id AND p.is_live = 1)
        AND COALESCE(
              (SELECT MAX(p.last_seen) FROM session_participants p
                WHERE p.session_id = s.id),
              s.created_at
            ) < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [emptyGraceSeconds],
  );
  for (const s of abandoned) {
    const [r] = await pool.query(
      `UPDATE sessions SET is_live = 0, status = 'ended', ended_at = NOW() WHERE id = ? AND is_live = 1`,
      [s.id],
    );
    if (r.affectedRows) ended++;
  }

  // 4) AI AUTO-FILL — keep a live session with users present from going silent.
  //    When a session has run dry (nothing queued AND its open voting round has
  //    no suggestions) yet people are still present, top up the OPEN round with
  //    AI suggestions so the existing emergency-promote (voted → user → random
  //    AI) always has something to play. Deliberately SAFE + additive:
  //      • only INSERT into an already-open round — never create rounds or touch
  //        the phase-timer state machine (avoids double-round races);
  //      • fire the OpenAI/YouTube work OFF the tick (non-blocking) and
  //        single-flight per session so concurrent ticks don't double-generate;
  //      • presence-gated (is_live participants > 0), so an empty session is
  //        ended by phase 3, never auto-filled (no zombie sessions / API spend);
  //      • never calls advanceToNext(null) directly — instead nudges
  //        current_plays_until (guarded to sessions with nothing playing) so the
  //        single, serialized phase-1 advance promotes one next tick. This avoids
  //        the double-advance hazard of two null-advances racing.
  if (autoFillEnabled) {
    const [needFill] = await pool.query(
      `SELECT s.id AS session_id,
              (SELECT v.id FROM voting_rounds v
                WHERE v.session_id = s.id AND v.state IN ('suggesting','voting')
                ORDER BY v.id DESC LIMIT 1) AS round_id
         FROM sessions s
        WHERE s.status = 'live'
          AND EXISTS (SELECT 1 FROM session_participants p
                       WHERE p.session_id = s.id AND p.is_live = 1)
          AND NOT EXISTS (SELECT 1 FROM queue_items q
                           WHERE q.session_id = s.id AND q.status = 'queued')
          AND NOT EXISTS (SELECT 1 FROM queue_items q
                           WHERE q.session_id = s.id AND q.status = 'suggested')`,
    );
    const now = Date.now();
    for (const { session_id, round_id } of needFill) {
      if (!round_id || autoFilling.has(session_id)) continue;
      if (now < (autoFillCooldownUntil.get(session_id) || 0)) continue; // cooling down
      autoFilling.add(session_id);
      autoFilled++;
      generateAiSuggestions(session_id, round_id, 3)
        .then(async (created) => {
          // Back off longer when nothing could be mapped (YouTube quota etc.) so
          // we never spend OpenAI in a tight loop; short cooldown after a real fill.
          autoFillCooldownUntil.set(
            session_id,
            Date.now() +
              (created.length ? AUTOFILL_COOLDOWN_OK_MS : AUTOFILL_COOLDOWN_EMPTY_MS),
          );
          if (!created.length) return;
          // Make the overdue-advance (phase 1) promote one next tick — but only
          // if nothing is currently playing (never cut a playing song short).
          await pool.query(
            `UPDATE sessions SET current_plays_until = NOW()
              WHERE id = ? AND status = 'live'
                AND NOT EXISTS (SELECT 1 FROM queue_items q
                                 WHERE q.session_id = sessions.id
                                   AND q.status = 'playing')`,
            [session_id],
          );
        })
        .catch((e) => {
          autoFillCooldownUntil.set(session_id, Date.now() + AUTOFILL_COOLDOWN_EMPTY_MS);
          console.error(`[auto-fill] session ${session_id}:`, e.message);
        })
        .finally(() => autoFilling.delete(session_id));
    }
  }

  return { advanced, ended, autoFilled };
}

function startReconciler({
  intervalMs = 2000,
  graceSeconds = 30,
  emptyGraceSeconds = 600,
} = {}) {
  if (timer) return;
  // Server-authoritative AI auto-fill is ON by default; set AUTOFILL_DISABLED=true
  // (then restart) to instantly turn it off if it ever misbehaves.
  const autoFillEnabled = process.env.AUTOFILL_DISABLED !== "true";
  const tick = () =>
    reconcileOnce({ graceSeconds, emptyGraceSeconds, autoFillEnabled }).catch((e) =>
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
