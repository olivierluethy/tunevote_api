# Source-of-Truth Collapse — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, with checkpoints). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the redundant, drift-prone state identified in `docs/2026-07-04-architecture-and-database-analysis.md` §4: one home for "what's playing" (drop `playback_sync`), one session-lifecycle column (`sessions.status`), one voting-round state column (`voting_rounds.state`).

**Architecture:** Roadmap steps 4–6. Ordered by frontend coupling (least first) so each sub-step ships independently: (A) drop `playback_sync` — backend-only, response-shape-preserving; (B) `voting_rounds.state` — backend-only, `/current-phase` response keeps `phase`; (C) `sessions.status` — has frontend coupling, so additive → dual-write → migrate reads → drop.

**Tech Stack:** Node/Express, `mysql2` pool, Socket.IO, Knex migrations, MySQL 8; frontend Vite/React.

## Global Constraints

- Same as Phase 1: MySQL-only; single process now / multi later; raw parameterized SQL; transactions via `getConnection()`; integration-test-first against the local container (`node test/run.js test/<f>.js`); `node --check` + boot smoke; sentence-case backend commits / conventional frontend commits; `git pull --ff-only` before each commit.
- **No behavior change to the client sync contract:** `/playback-sync` still returns `{current_video_id, video_start_time, is_playing}`; `/current-phase` still returns `{phase, endsAt, duration, roundId}`.
- Deploy note: sub-steps A and B are safe to deploy independently. Sub-step C's column drop MUST come after the frontend that reads `status` is live (dual-write bridges the gap).

---

## Sub-step A: Drop `playback_sync`; derive "now playing" from the queue row

**Rationale (§4.1):** `queue_items.status='playing'` + `startedAt` and the whole `playback_sync` table encode the same fact via separate non-atomic writes. `startedAt` (set to DB `NOW()` in the same transaction that sets `status='playing'`) is already the authoritative start time. `playback_sync` is pure duplication.

**Files:**
- Migration: `migrations/20260704000002_drop_playback_sync.js`
- Modify: `routes/sessions.js` — endpoint `:33`, start-flow `:557` (DELETE) and `:598` (INSERT), and add `current_plays_until` + CAS timer at start.
- Modify: `services/playback.js` — remove the two `playback_sync` writes in `advanceToNext` (pause + music branches).
- Test: `test/playback_sync_derive.test.js`

- [ ] **Step 1: Failing test** — `test/playback_sync_derive.test.js`:

```js
const { pool, seedLiveSession, cleanupSession, assert } = require("./helpers/fixtures");
const { advanceToNext } = require("../services/playback");
const express = require("express");
const request = require("http");

// Directly exercise the derivation query the endpoint will use.
module.exports = async () => {
  const { sessionId, itemIds } = await seedLiveSession(pool, {
    videos: [{ id: "TESTPS00001", duration: 5 }, { id: "TESTPS00002", duration: 30 }],
  });
  await advanceToNext(sessionId, itemIds[0]); // item2 now playing, startedAt=NOW()

  const [[row]] = await pool.query(
    `SELECT qi.video_id AS current_video_id,
            UNIX_TIMESTAMP(qi.startedAt)*1000 AS video_start_time,
            (s.is_live = 1 AND qi.item_type='music') AS is_playing
       FROM sessions s
       JOIN queue_items qi ON qi.session_id = s.id AND qi.status='playing'
      WHERE s.id = ?`, [sessionId]);
  assert(row.current_video_id === "TESTPS00002", "derives current video");
  assert(Number(row.is_playing) === 1, "derives is_playing");
  assert(Math.abs(row.video_start_time - Date.now()) < 5000, "start time ~now");

  await cleanupSession(pool, sessionId);
  await pool.end();
};
```

Run: `node test/run.js test/playback_sync_derive.test.js` → PASS (the derivation works even before we change the endpoint; this locks the query).

- [ ] **Step 2: Migration** — `migrations/20260704000002_drop_playback_sync.js`:

```js
exports.up = async (knex) => { await knex.schema.dropTableIfExists("playback_sync"); };
exports.down = async (knex) => {
  await knex.raw(`CREATE TABLE playback_sync (
    session_id INT NOT NULL PRIMARY KEY,
    current_video_id VARCHAR(11) DEFAULT NULL,
    progress_seconds FLOAT DEFAULT 0,
    is_playing TINYINT(1) DEFAULT 0,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    video_start_time BIGINT DEFAULT NULL,
    CONSTRAINT playback_sync_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);
};
```

- [ ] **Step 3: Endpoint derives** — replace `routes/sessions.js:28-41` body query with the derivation SELECT from Step 1 (return `rows[0] || {}`).

- [ ] **Step 4: `advanceToNext` stops writing `playback_sync`** — delete both `playback_sync` `INSERT/UPDATE` blocks in `services/playback.js` (pause branch `UPDATE playback_sync …`, music branch `INSERT INTO playback_sync …`). Keep the socket emits (they still carry `video_start_time = startTime`).

- [ ] **Step 5: `/start` — remove `playback_sync`, set deadline, CAS timer** in `routes/sessions.js`:
  - Delete `:557` `DELETE FROM playback_sync …` and `:598-606` `INSERT INTO playback_sync …`.
  - After setting the first song `status='playing'` (`:592-595`), add:
    ```js
    await pool.query(
      `UPDATE sessions SET current_plays_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?`,
      [Math.max(1, Math.floor(duration)), id]);
    ```
  - Change the timer to pass the item id (compare-and-swap): `setTimeout(() => advanceToNext(id, firstId), duration * 1000)`. **(Closes the Phase-1 first-song gap.)**

- [ ] **Step 6:** Run migration (`npx knex migrate:latest`), re-run the test, `node --check`, boot smoke. Confirm no remaining `playback_sync` refs: `grep -rn playback_sync routes services` → only comments/none.

- [ ] **Step 7: Commit**

```bash
git pull --ff-only
git add migrations/20260704000002_drop_playback_sync.js routes/sessions.js services/playback.js test/playback_sync_derive.test.js
git commit -m "Drop playback_sync; derive now-playing from the queue row"
```

---

## Sub-step B: Collapse `voting_rounds.phase` + `.status` → `state`

**Rationale (§4.6):** `phase` (`suggestion`/`voting`/`closed`) and `status` (`open`/`closed`/`computed`) are two columns updated by different statements and can contradict. Collapse into `state ENUM('suggesting','voting','closed')`. Mapping: `status='open' & phase='suggestion'` → `suggesting`; `status='open' & phase='voting'` → `voting`; else → `closed`.

**Files:**
- Migration: `migrations/20260704000003_voting_round_state.js` (add `state`, backfill, drop `phase`+`status`).
- Modify (mechanical sweep, ~52 refs): `services/playback.js`, `routes/proposals.js`, `routes/sessions.js`, `services/scheduler.js`.
- Test: `test/voting_state.test.js`

- [ ] **Step 1:** Enumerate every site: `grep -rnE "\.status|\.phase|status *=|phase *=" services/playback.js routes/proposals.js routes/sessions.js | grep -iE "voting_round|round"`. Build the list; each `WHERE status='open'` → `WHERE state IN ('suggesting','voting')`; `SET phase='voting'` → `SET state='voting'`; `SET status='closed', phase='closed'` → `SET state='closed'`; reads of `.phase` for the client → keep returning a derived `phase` field (`state='voting'?'voting':state='closed'?'closed':'suggestion'`).
- [ ] **Step 2:** Migration adds `state` (backfill per mapping), keeps `phase`/`status` for one release (dual-write) OR drops immediately (backend-only, no external reader) — **drop immediately** since nothing outside the backend reads these columns.
- [ ] **Step 3:** Sweep the code; the `/current-phase` and `/current-voting-phase` responses keep the `phase` key (derived from `state`) so the frontend is unchanged.
- [ ] **Step 4:** Test `test/voting_state.test.js`: open a round (`state='suggesting'`), assert `/current-phase`-shaped derivation returns `phase='suggestion'`; move to `voting`; close; assert transitions never leave a contradictory pair (there is only one column now).
- [ ] **Step 5:** Migrate, test, `node --check`, boot smoke, commit: `"Collapse voting_rounds phase and status into a single state column"`.

---

## Sub-step C: Collapse `sessions.is_active`+`is_live` → `status` (frontend-coupled)

**Rationale (§4.2):** `is_active` is dead (one read, never set to 0); `is_live` + `ended_at` overlap. Target: `sessions.status ENUM('draft','live','ended')`; `ended_at` stays as an audit timestamp.

This is the only sub-step the frontend reads directly (`Frontend/src/pages/Dashboard.jsx:387-388,435`, `Frontend/src/components/SessionPage.jsx:401`). Roll out safely:

- [ ] **C1 (additive + dual-write, backend):** Migration adds `status ENUM('draft','live','ended') NOT NULL DEFAULT 'draft'`, backfill (`live` where `is_live=1`; `ended` where `ended_at IS NOT NULL`; else `draft`). Every place that writes `is_live` also writes `status` (11 sites: `/start` → `'live'`; `advanceToNext`/reconciler end paths → `'ended'`). Every place that *returns* a session to the client adds `status` to the payload alongside `is_live`. Commit. **Non-breaking** (old `is_live` still maintained).
- [ ] **C2 (frontend reads `status`):** `Dashboard.jsx` filters on `s.status === 'live'`; `SessionPage.jsx:401` `setSessionLive(sessRes.data.status === 'live')`. Build, commit, **deploy frontend**.
- [ ] **C3 (drop old columns, backend):** After C2 is live, migration drops `is_active` and `is_live`; replace remaining backend `is_live` reads with `status='live'`; the reconciler/advance switch to `status`. Commit.
- [ ] Test at each step: `test/session_status.test.js` — start → `status='live'`; reconciler-end → `status='ended'`; assert `is_live` mirror during C1.

---

## Self-Review

- **Coverage:** §4.1 → A; §4.6 → B; §4.2 → C; Phase-1 first-song deadline gap → A Step 5.
- **Placeholders:** the voting sweep (B) is specified as a mechanical rule set over an enumerated grep, not 52 pasted edits — appropriate for a rename-style collapse; the transformation rules are exact.
- **Ordering/consistency:** response shapes for `/playback-sync` and `/current-phase` are explicitly preserved so A and B need no frontend change; only C touches the frontend, and only after dual-write.

## Risks

- **A:** `startedAt` is second-precision vs the old ms `video_start_time`; clients derive position and the >2s drift poll absorbs a ≤1s offset. Acceptable.
- **B:** a wide mechanical sweep — grep must be exhaustive; the `test/voting_state.test.js` plus boot smoke guard load-time, but request-time voting flows should be smoke-tested on deploy.
- **C:** the column drop is the one irreversible-ish, frontend-coupled step; do it only after the frontend reading `status` is deployed. Dual-write in C1 makes the window safe.
