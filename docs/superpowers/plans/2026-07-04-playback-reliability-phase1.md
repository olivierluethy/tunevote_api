# Playback Reliability — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "session stays live after kill", song-switch races, and post-restart freezes by making song advancement atomic and DB-authoritative with a crash-safe reconciler and a participant heartbeat.

**Architecture:** Roadmap steps 1–3 from `docs/2026-07-04-architecture-and-database-analysis.md`. Song switching becomes a single locked transaction with compare-and-swap; a durable `current_plays_until` deadline plus a ~2s reconciler loop advances overdue sessions, rebuilds timers on boot, and ends orphaned sessions; a `last_seen` heartbeat makes participant liveness self-heal. No source-of-truth changes (that's Phase 2) — this phase is additive and behavior-preserving except where it fixes bugs.

**Tech Stack:** Node.js, Express, `mysql2/promise` pool (raw SQL), Socket.IO, Knex (migrations only), MySQL 8.

## Global Constraints

- MySQL-only. No new services (no Redis).
- Single Node process now; do not hard-depend on in-memory state (reconciler rebuilds from DB).
- Raw parameterized SQL via the shared pool (`require("../db")`); transactions via `pool.getConnection()` + `connection.beginTransaction()` (existing pattern: `services/playback.js:734`).
- Socket emits go through `getIO()` from `lib/io.js` (never at module load).
- Verification is integration-first: short-lived Node scripts that load dotenv and hit the **local MySQL container** (confirmed reachable), plus `node --check` and a boot smoke (`node index.js` via background + read log for `Server läuft` + `MySQL connected`). There is no unit-test runner; do not invent one.
- Commit style: sentence-case subject lines (match repo history, e.g. "Extract auth and subscription helpers…"). No Co-Authored-By trailer. `git pull --ff-only` before each commit.
- After each task: `node --check` the changed files, run the task's integration script, boot-smoke, then commit.

---

### Task 0: Integration test harness + fixtures

**Files:**
- Create: `test/helpers/fixtures.js`
- Create: `test/run.js` (tiny assert + runner, no dependency)

**Interfaces:**
- Produces:
  - `withDb(fn)` — loads dotenv, gives `fn(pool)`, ends pool after.
  - `seedLiveSession(pool, { videos: [{id,duration}], startPlayingIndex })` → `{ sessionId, itemIds }`. Inserts a `youtube_video_cache` row per video (idempotent upsert), a `sessions` row (`is_live=1`), and `queue_items` (one `status='playing'`, rest `status='queued'`), plus a `playback_sync` row for the playing item. Returns created ids.
  - `cleanupSession(pool, sessionId)` — `DELETE FROM sessions WHERE id=?` (cascade removes children); also delete the temp cache rows it created.
  - `assert(cond, msg)`, `assertEqual(a, b, msg)` — throw on failure.
- Consumes: nothing.

- [ ] **Step 1: Write `test/run.js`**

```js
// Minimal runner: `node test/run.js test/<file>.js`
require("dotenv").config();
const path = require("path");
const file = process.argv[2];
if (!file) { console.error("usage: node test/run.js <testfile>"); process.exit(2); }
(async () => {
  try {
    await require(path.resolve(file))();
    console.log("\n✅ PASS:", file);
    process.exit(0);
  } catch (e) {
    console.error("\n❌ FAIL:", file, "\n", e.stack || e.message);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Write `test/helpers/fixtures.js`**

```js
const pool = require("../../db");

function assert(cond, msg) { if (!cond) throw new Error("assert: " + (msg || "failed")); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`assertEqual: ${msg || ""} expected ${b}, got ${a}`);
}

// Real 11-char-ish ids for the test; upsert into cache (video_id is FK RESTRICT).
async function seedLiveSession(pool_, { videos, startPlayingIndex = 0 }) {
  for (const v of videos) {
    await pool_.query(
      `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, duration)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE duration = VALUES(duration)`,
      [v.id, "t_" + v.id, "t_" + v.id, v.duration],
    );
  }
  const [s] = await pool_.query(
    `INSERT INTO sessions (user_id, title, is_live, is_private, created_at)
     VALUES (1, 'TEST_SESSION', 1, 0, NOW())`,
  );
  const sessionId = s.insertId;
  const itemIds = [];
  for (let i = 0; i < videos.length; i++) {
    const status = i === startPlayingIndex ? "playing" : "queued";
    const started = i === startPlayingIndex ? "NOW()" : "NULL";
    const [r] = await pool_.query(
      `INSERT INTO queue_items (session_id, video_id, status, item_type, item_source, startedAt, created_at)
       VALUES (?, ?, ?, 'music', 'user', ${started}, NOW())`,
      [sessionId, videos[i].id, status],
    );
    itemIds.push(r.insertId);
  }
  await pool_.query(
    `INSERT INTO playback_sync (session_id, current_video_id, video_start_time, is_playing)
     VALUES (?, ?, ?, 1)`,
    [sessionId, videos[startPlayingIndex].id, Date.now()],
  );
  return { sessionId, itemIds };
}

async function cleanupSession(pool_, sessionId) {
  await pool_.query(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

module.exports = { pool, assert, assertEqual, seedLiveSession, cleanupSession };
```

- [ ] **Step 3: Smoke the harness** — create `test/harness.smoke.js`:

```js
const { pool, seedLiveSession, cleanupSession, assertEqual } = require("./helpers/fixtures");
module.exports = async () => {
  const { sessionId, itemIds } = await seedLiveSession(pool, {
    videos: [{ id: "TESTVID0001", duration: 5 }, { id: "TESTVID0002", duration: 5 }],
  });
  const [rows] = await pool.query(
    `SELECT status FROM queue_items WHERE session_id = ? ORDER BY id`, [sessionId]);
  assertEqual(rows[0].status, "playing", "first item playing");
  assertEqual(rows[1].status, "queued", "second item queued");
  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

Run: `node test/run.js test/harness.smoke.js`
Expected: `✅ PASS`.

- [ ] **Step 4: Commit**

```bash
git pull --ff-only
git add test/run.js test/helpers/fixtures.js test/harness.smoke.js
git commit -m "Add integration test harness for playback engine"
```

---

### Task 1: Make `advanceToNext` atomic + idempotent (roadmap step 1)

**Files:**
- Modify: `services/playback.js` (`advanceToNext`, currently `services/playback.js:432` — signature `const advanceToNext = async (sessionId) => {`)
- Create: `test/advance.concurrent.test.js`

**Interfaces:**
- Produces: `advanceToNext(sessionId, expectedCurrentItemId = null)` — unchanged callers keep working (2nd arg optional). When `expectedCurrentItemId` is given and the current playing row no longer equals it, the call no-ops (idempotent). Internally runs in one transaction with `SELECT … FOR UPDATE` on the session row.
- Consumes: Task 0 fixtures.

- [ ] **Step 1: Write the failing test** — `test/advance.concurrent.test.js`:

```js
const { pool, seedLiveSession, cleanupSession, assert, assertEqual } = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");

module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [{ id: "TESTADV0001", duration: 5 }, { id: "TESTADV0002", duration: 5 },
             { id: "TESTADV0003", duration: 5 }],
  });

  // Fire two concurrent advances — the classic double-advance race.
  await Promise.all([advanceToNext(sessionId), advanceToNext(sessionId)]);

  const [playing] = await pool.query(
    `SELECT COUNT(*) c FROM queue_items WHERE session_id = ? AND status = 'playing'`, [sessionId]);
  const [played] = await pool.query(
    `SELECT COUNT(*) c FROM queue_items WHERE session_id = ? AND status = 'played'`, [sessionId]);

  assertEqual(playing[0].c, 1, "exactly one row playing after concurrent advance");
  assertEqual(played[0].c, 1, "exactly one row played (single advance, not double)");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js test/advance.concurrent.test.js`
Expected: FAIL — `played[0].c` is `2` (both calls advanced), or two rows `playing`. (Current `advanceToNext` has no lock.)

*Note: it may occasionally pass by luck; run 3×. The fix makes it deterministic.*

- [ ] **Step 3: Wrap `advanceToNext` in a locked transaction with compare-and-swap**

Transform `services/playback.js` `advanceToNext`:

1. Change the signature:
```js
const advanceToNext = async (sessionId, expectedCurrentItemId = null) => {
```
2. Acquire a connection and lock the session at the very top; replace **every** `pool.query(` inside the function body with `connection.query(`; wrap the whole body in `try/commit / catch/rollback / finally release`. Emit socket events **only after commit** (collect payloads in a local, emit after `connection.commit()`).

Skeleton (preserve the existing finalize/next-pick/emergency-promotion/play logic verbatim, just moved inside and using `connection`):

```js
const advanceToNext = async (sessionId, expectedCurrentItemId = null) => {
  const connection = await pool.getConnection();
  let afterCommit = () => {};
  try {
    await connection.beginTransaction();

    // Serialize all advances for this session.
    await connection.query(`SELECT id FROM sessions WHERE id = ? FOR UPDATE`, [sessionId]);

    // Lock + read the current playing row.
    const [playingRows] = await connection.query(
      `SELECT id FROM queue_items WHERE session_id = ? AND status = 'playing' LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
    const currentId = playingRows[0]?.id ?? null;

    // Idempotency: if the caller expected a specific current item and it's
    // already gone, another advance won already — do nothing.
    if (expectedCurrentItemId !== null && currentId !== expectedCurrentItemId) {
      await connection.commit();
      return;
    }

    // ... finalizeListeningForCurrentSong(sessionId) — see Step 3b ...
    // ... mark current played (guarded), pick next, emergency-promote, play next ...
    //     ALL using `connection.query(...)` instead of `pool.query(...)`.
    //     Guard the "mark played" update:
    //       UPDATE queue_items SET status='played', playedAt=NOW()
    //       WHERE id = ? AND status = 'playing'
    //     Collect the playback_sync emit payload into `afterCommit`.

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    console.error("advanceToNext failed, rolled back:", err.message);
    return;
  } finally {
    connection.release();
  }
  afterCommit(); // emit playback_sync / queue_updated / arm the setTimeout here
};
```

- [ ] **Step 3b: Make `finalizeListeningForCurrentSong` accept the connection**

Change `services/playback.js:356` to `async function finalizeListeningForCurrentSong(sessionId, conn = pool) {` and replace its internal `pool.query` with `conn.query`. Call it as `finalizeListeningForCurrentSong(sessionId, connection)` inside the transaction so the listen-stat write is part of the same atomic unit.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run.js test/advance.concurrent.test.js` (run 3×)
Expected: PASS all three — exactly 1 playing, exactly 1 played.

- [ ] **Step 5: Boot smoke**

Run (background): `node index.js` → read log → expect `Server läuft` + `✅ MySQL connected successfully!`, no `Error:`/`is not defined`.

- [ ] **Step 6: Commit**

```bash
git pull --ff-only
git add services/playback.js test/advance.concurrent.test.js
git commit -m "Make advanceToNext atomic and idempotent with a locked transaction"
```

---

### Task 2: Durable playback deadline (`current_plays_until`) + heartbeat column (roadmap steps 2–3 schema)

**Files:**
- Create: `migrations/20260704000001_playback_reliability_phase1.js`
- Modify: `services/playback.js` (write `current_plays_until` where the song timer is armed — near `services/playback.js:661` and `:688`)
- Create: `test/plays_until.test.js`

**Interfaces:**
- Produces: `sessions.current_plays_until DATETIME NULL`; `session_participants.last_seen DATETIME NULL`. After an advance, `current_plays_until = NOW() + INTERVAL <duration> SECOND` is written inside the transaction.
- Consumes: Task 1 (transaction connection).

- [ ] **Step 1: Write the migration**

```js
exports.up = async (knex) => {
  await knex.schema.alterTable("sessions", (t) => {
    t.dateTime("current_plays_until").nullable();
  });
  await knex.schema.alterTable("session_participants", (t) => {
    t.dateTime("last_seen").nullable();
  });
  // Indexes the reconciler will scan on.
  await knex.raw("CREATE INDEX idx_sessions_live_deadline ON sessions (is_live, current_plays_until)");
};
exports.down = async (knex) => {
  await knex.raw("DROP INDEX idx_sessions_live_deadline ON sessions");
  await knex.schema.alterTable("session_participants", (t) => t.dropColumn("last_seen"));
  await knex.schema.alterTable("sessions", (t) => t.dropColumn("current_plays_until"));
};
```

- [ ] **Step 2: Run the migration**

Run: `npx knex migrate:latest`
Expected: `Batch N run: 1 migrations`. Verify: `node -e "require('dotenv').config();require('./db').query('DESCRIBE sessions').then(([r])=>{console.log(r.map(c=>c.Field).includes('current_plays_until'));process.exit()})"` prints `true`.

- [ ] **Step 3: Write `current_plays_until` in the advance transaction**

In `advanceToNext` (inside the transaction, right after setting the next row `status='playing'`), for BOTH the pause branch and the music branch add:

```js
await connection.query(
  `UPDATE sessions SET current_plays_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?`,
  [Math.max(1, Math.floor(duration || 180)), sessionId],
);
```

- [ ] **Step 4: Write + run the test** — `test/plays_until.test.js`:

```js
const { pool, seedLiveSession, cleanupSession, assert } = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");
module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [{ id: "TESTDL00001", duration: 5 }, { id: "TESTDL00002", duration: 42 }],
  });
  await advanceToNext(sessionId); // now item2 (42s) is playing
  const [[row]] = await pool.query(
    `SELECT TIMESTAMPDIFF(SECOND, NOW(), current_plays_until) AS secs FROM sessions WHERE id = ?`,
    [sessionId]);
  assert(row.secs >= 38 && row.secs <= 44, `deadline ~42s, got ${row.secs}`);
  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

Run: `node test/run.js test/plays_until.test.js` → Expected PASS.

- [ ] **Step 5: Commit**

```bash
git pull --ff-only
git add migrations/20260704000001_playback_reliability_phase1.js services/playback.js test/plays_until.test.js
git commit -m "Add durable current_plays_until deadline and last_seen column"
```

---

### Task 3: Crash-safe reconciler (roadmap step 2 runtime)

**Files:**
- Create: `services/scheduler.js`
- Modify: `index.js` (start the reconciler after `initIO`, near `index.js:155`)
- Create: `test/reconciler.test.js`

**Interfaces:**
- Produces:
  - `startReconciler({ intervalMs = 2000, graceSeconds = 30 } = {})` — starts the interval; idempotent (no double-start).
  - `reconcileOnce({ graceSeconds })` — one pass (exported for tests): advances overdue live sessions, ends orphaned ones. Returns `{ advanced, ended }` counts.
  - `stopReconciler()` — clears the interval (for clean test exit).
- Consumes: `advanceToNext` (Task 1), `current_plays_until` (Task 2).

- [ ] **Step 1: Write `services/scheduler.js`**

```js
const pool = require("../db");
const { advanceToNext } = require("./playback");

let timer = null;

async function reconcileOnce({ graceSeconds = 30 } = {}) {
  let advanced = 0, ended = 0;

  // 1) Advance songs whose deadline has passed.
  const [overdue] = await pool.query(
    `SELECT id FROM sessions
     WHERE is_live = 1 AND current_plays_until IS NOT NULL AND current_plays_until < NOW()`,
  );
  for (const s of overdue) { await advanceToNext(s.id); advanced++; }

  // 2) Reap stale participants (no heartbeat within grace window).
  await pool.query(
    `UPDATE session_participants SET is_live = 0
     WHERE is_live = 1 AND (last_seen IS NULL OR last_seen < DATE_SUB(NOW(), INTERVAL ? SECOND))`,
    [graceSeconds],
  );

  // 3) End sessions that are live but have nothing playing, no live participants,
  //    and no open voting round — self-heals "stuck live".
  const [dead] = await pool.query(
    `SELECT s.id FROM sessions s
     WHERE s.is_live = 1
       AND NOT EXISTS (SELECT 1 FROM queue_items q
                       WHERE q.session_id = s.id AND q.status IN ('playing','queued','suggested'))
       AND NOT EXISTS (SELECT 1 FROM session_participants p
                       WHERE p.session_id = s.id AND p.is_live = 1)
       AND NOT EXISTS (SELECT 1 FROM voting_rounds v
                       WHERE v.session_id = s.id AND v.status = 'open')`,
  );
  for (const s of dead) {
    const [r] = await pool.query(
      `UPDATE sessions SET is_live = 0, ended_at = NOW() WHERE id = ? AND is_live = 1`, [s.id]);
    if (r.affectedRows) ended++;
  }
  return { advanced, ended };
}

function startReconciler({ intervalMs = 2000, graceSeconds = 30 } = {}) {
  if (timer) return;
  const tick = () => reconcileOnce({ graceSeconds }).catch((e) =>
    console.error("reconciler tick failed:", e.message));
  tick(); // immediate pass on boot rebuilds overdue work
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log("⏱️  Reconciler started");
}

function stopReconciler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { startReconciler, stopReconciler, reconcileOnce };
```

- [ ] **Step 2: Wire into `index.js`** (after `initIO(httpServer);`, ~`index.js:155`):

```js
require("./services/scheduler").startReconciler();
```

- [ ] **Step 3: Write + run the test** — `test/reconciler.test.js`:

```js
const { pool, seedLiveSession, cleanupSession, assertEqual } = require("./helpers/fixtures");
const { reconcileOnce } = require("../services/scheduler");
module.exports = async () => {
  // Session whose current song is already overdue.
  const { sessionId } = await seedLiveSession(pool, {
    videos: [{ id: "TESTREC0001", duration: 5 }, { id: "TESTREC0002", duration: 5 }],
  });
  await pool.query(
    `UPDATE sessions SET current_plays_until = DATE_SUB(NOW(), INTERVAL 10 SECOND) WHERE id = ?`,
    [sessionId]);

  const res = await reconcileOnce({ graceSeconds: 30 });
  assertEqual(res.advanced >= 1, true, "overdue session advanced");

  const [[playing]] = await pool.query(
    `SELECT video_id FROM queue_items WHERE session_id = ? AND status='playing'`, [sessionId]);
  assertEqual(playing.video_id, "TESTREC0002", "advanced to second song");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

Run: `node test/run.js test/reconciler.test.js` → Expected PASS.

- [ ] **Step 4: Boot smoke** — expect `⏱️  Reconciler started` in the log alongside the usual lines.

- [ ] **Step 5: Commit**

```bash
git pull --ff-only
git add services/scheduler.js index.js test/reconciler.test.js
git commit -m "Add crash-safe reconciler to advance overdue and end orphaned sessions"
```

---

### Task 4: Participant heartbeat (roadmap step 3 runtime)

**Files:**
- Modify: `socket.js` (add a `heartbeat` handler; set `last_seen` on connect/join)
- Modify: `Frontend/src/context/PlaybackContext.jsx` (emit `heartbeat` every ~10s on the active socket)
- Create: `test/heartbeat.test.js`

**Interfaces:**
- Produces: socket event `heartbeat` (payload `{ sessionId }`) → `UPDATE session_participants SET last_seen = NOW()` for the caller's user/guest. On successful join-live the backend already inserts the participant; set `last_seen = NOW()` there too.
- Consumes: `last_seen` column (Task 2), reconciler reaper (Task 3).

- [ ] **Step 1: Backend — set `last_seen` on join-live and on heartbeat**

In `socket.js` inside `registerSocketHandlers()` connection handler, add:

```js
socket.on("heartbeat", async () => {
  const token = socket.handshake.auth?.token;
  const guestToken = socket.handshake.auth?.guestToken;
  const user = token ? await getUserFromToken(token) : null;
  const guest = !user && guestToken ? await getGuestFromToken(guestToken) : null;
  const col = user ? "user_id" : guest ? "guest_id" : null;
  const idv = user ? user.id : guest ? guest.id : null;
  if (!col || !idv) return;
  await pool.query(
    `UPDATE session_participants SET last_seen = NOW() WHERE session_id = ? AND ${col} = ?`,
    [sessionIdInt, idv],
  );
});
```

Also in `routes/sessions.js` where `session_participants` is inserted/updated on join-live, add `last_seen = NOW()` to that write (search for the `INSERT INTO session_participants` / `is_live = 1` in join-live and include `last_seen`).

- [ ] **Step 2: Frontend — emit heartbeat on the active socket**

In `Frontend/src/context/PlaybackContext.jsx` `connectSocket`, after the socket is created, add:

```js
const hb = setInterval(() => {
  if (activeRef.current?.sessionId === sessionId && socket.connected) {
    socket.emit("heartbeat", { sessionId });
  }
}, 10000);
socket.on("disconnect", () => clearInterval(hb));
```

- [ ] **Step 3: Write + run the test** — `test/heartbeat.test.js` (verifies the reaper respects `last_seen`):

```js
const { pool, seedLiveSession, cleanupSession, assertEqual } = require("./helpers/fixtures");
const { reconcileOnce } = require("../services/scheduler");
module.exports = async () => {
  const { sessionId } = await seedLiveSession(pool, {
    videos: [{ id: "TESTHB00001", duration: 5 }, { id: "TESTHB00002", duration: 5 }],
  });
  // A fresh participant with a recent heartbeat must NOT be reaped.
  await pool.query(
    `INSERT INTO session_participants (session_id, user_id, role, is_live, last_seen, joined_at)
     VALUES (?, 1, 'host', 1, NOW(), NOW())`, [sessionId]);
  await reconcileOnce({ graceSeconds: 30 });
  const [[live]] = await pool.query(
    `SELECT is_live FROM session_participants WHERE session_id = ? AND user_id = 1`, [sessionId]);
  assertEqual(live.is_live, 1, "recent-heartbeat participant survives reaper");

  // A stale participant (old last_seen) MUST be reaped.
  await pool.query(
    `UPDATE session_participants SET last_seen = DATE_SUB(NOW(), INTERVAL 5 MINUTE)
     WHERE session_id = ? AND user_id = 1`, [sessionId]);
  await reconcileOnce({ graceSeconds: 30 });
  const [[dead]] = await pool.query(
    `SELECT is_live FROM session_participants WHERE session_id = ? AND user_id = 1`, [sessionId]);
  assertEqual(dead.is_live, 0, "stale participant reaped");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

Run: `node test/run.js test/heartbeat.test.js` → Expected PASS.

- [ ] **Step 4: Boot smoke (backend) + `npm run build` (frontend).**

- [ ] **Step 5: Commit (two repos)**

```bash
# backend
cd Backend && git pull --ff-only
git add socket.js routes/sessions.js test/heartbeat.test.js
git commit -m "Add participant heartbeat and last_seen updates"
# frontend
cd ../Frontend && git add src/context/PlaybackContext.jsx
git commit -m "feat(player): emit heartbeat on the active session socket"
```

---

## Self-Review

- **Spec coverage:** Roadmap step 1 → Task 1. Step 2 (reconciler + `current_plays_until` + boot recovery) → Tasks 2–3. Step 3 (heartbeat + reaper) → Tasks 2 (column), 3 (reaper), 4 (heartbeat). Source-of-truth collapse (steps 4–6) and `DELETE`→status (step 8) are **deliberately out of scope** for Phase 1 and will be a Phase-2 plan.
- **Placeholders:** Task 1 Step 3 intentionally references "preserve existing finalize/next-pick/emergency-promotion/play logic" rather than re-pasting ~230 lines — this is an in-place refactor of a working function; the exact transformation (add lock, swap `pool`→`connection`, guard the played-update, emit after commit) is fully specified.
- **Type consistency:** `advanceToNext(sessionId, expectedCurrentItemId=null)`, `reconcileOnce({graceSeconds})`, `startReconciler()`, `seedLiveSession/cleanupSession` names match across all tasks.
- **Ambiguity:** Reaper grace window is 30s everywhere; deadline uses `duration || 180`.

## Risks

- **Tests mutate the local dev DB.** Fixtures create `TEST_SESSION` rows and cleanup via cascade `DELETE`. Safe on the local container; never run against prod.
- **`FOR UPDATE` on `queue_items` needs the `idx_session_status` index (exists, `init.sql:186`)** to avoid gap-lock surprises; verify no deadlocks under the concurrent test.
- **Reconciler + in-memory `setTimeout` may both fire** an advance near the deadline — the Task 1 idempotent lock makes the double harmless (second no-ops).
- **This phase keeps `playback_sync` and `is_live`** (no source-of-truth change yet); the reconciler operates on `is_live` for now and moves to `sessions.status` in Phase 2.
