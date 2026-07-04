# TuneVote — Architecture & Database Analysis

**Date:** 2026-07-04
**Scope:** Session lifecycle, queue/playback state, backend↔DB interface, playback sync.
**Status:** Analysis & concept only. No code changed. This document is the authoritative guide for the upcoming refactor.
**Method:** Every claim below is backed by the actual code. Citations use `file:line`. Line numbers refer to the current split backend (`routes/`, `services/`, `socket.js`) and `init.sql`.

**Constraints agreed for the recommendation (Section 6):** a breaking schema migration is acceptable (Knex pipeline exists); target a single Node process now but do not hard-depend on in-memory state (multi-instance later); MySQL-only, no new infrastructure.

---

## 1. Current state — how it actually works today

### 1.1 Backend↔DB interface

- The runtime uses **raw parameterized SQL through a `mysql2` pool** — **243 `pool.query()` / `connection.query()` call sites** across `routes/`, `services/`, `socket.js`. There is **no ORM or query builder at runtime**. Knex exists **only for migrations** (`knexfile.js`, `migrations/*`), never in request code.
- **Transactions are almost entirely absent.** Only two flows use them: `createNewPublicSession` (`services/playback.js:735`) and invite-accept (`routes/invites.js:174,488`, the latter with `SELECT … FOR UPDATE`). **The playback state machine — song switching, `is_live` toggling, playback-sync writes — uses no transactions and no row locks.**
- `knexfile.js` sets `multipleStatements: true` on the connection. That is migration-only config, but it is a latent risk if any raw multi-statement string is ever built from user input.

### 1.2 Data model (from `init.sql`)

The tables relevant to live playback:

- **`sessions`** (`init.sql:84–95`): carries **three overlapping lifecycle signals** — `is_active TINYINT DEFAULT 1` (line 88), `is_live TINYINT DEFAULT 0` (line 91), `ended_at TIMESTAMP NULL` (line 90) — plus `is_private`. The schema header itself lists "sessions lifecycle collapse" as a **known-unfinished** cleanup (`init.sql:35–37`).
- **`queue_items`** (`init.sql:167–211`): `status ENUM('queued','playing','played','skipped','archived','suggested')` (line 173), plus `startedAt DATETIME` (line 176) and `playedAt DATETIME` (line 175). Proposals are modeled as `queue_items` with `status='suggested'`. A `CHECK` enforces music-vs-pause shape (lines 202–210). Phase 2 already dropped the old `played` boolean in favor of `status` (header lines 29–30) — good direction, not yet finished.
- **`playback_sync`** (`init.sql:214–223`): a **separate** per-session row (`session_id` PK) holding `current_video_id`, `video_start_time BIGINT` (epoch ms), `is_playing`, and `progress_seconds FLOAT` — the last of which is **never written** (dead column).
- **`voting_rounds`** (`init.sql:244–261`): carries **two overlapping status columns** — `phase ENUM('suggestion','voting','closed')` (line 251) and `status ENUM('open','closed','computed')` (line 256) — plus `phase_ends_at`, `winner_queue_item_id`, durations, `quorum_percent`.
- **`session_participants`** (`init.sql:149–165`): per-participant `is_live TINYINT` (line 157), `joined_at`, `left_at`. **No `last_seen`/heartbeat column.**

### 1.3 Session lifecycle

1. **Create:** `is_live` defaults 0.
2. **Start** (`routes/sessions.js` `/sessions/:id/start`): `DELETE FROM playback_sync` for a clean slate (`:557`), then `UPDATE sessions SET is_live = 1 WHERE id = ?` (`:570`), schedule the first song via an in-memory timer (`:626`), and open the first voting round + `startPhaseTimer(id, roundId, "suggestion", 90)` (`:650`).
3. **Live:** playback advances via `advanceToNext` (below); voting cycles via `startPhaseTimer`.
4. **End paths** (the only ways `is_live` returns to 0):
   - `advanceToNext` finds nothing to play **and** no live participants **and** no open round **and** nothing playing → `UPDATE sessions SET is_live = 0` (`services/playback.js:585–608`).
   - The voting phase timer ends with no live participants → `UPDATE sessions SET is_live = 0, ended_at = NOW() WHERE id = ? AND is_live = 1` (`services/playback.js:219–222`).
   - Host **deletes** the session → `DELETE FROM sessions` (`routes/sessions.js:522`, cascades), with in-memory timer cleanup (`:525–528`).
5. **Frontend** reflects the flag verbatim: `setSessionLive(!!sessRes.data.is_live)` (`Frontend/src/components/SessionPage.jsx:401`).

### 1.4 Song switching — `advanceToNext(sessionId)` (`services/playback.js:432–704`)

1. Finalize listening stats for the current song (`:434`, helper `:356–428`), inserting into `session_song_listens`.
2. Find current `status='playing'` row, then `UPDATE queue_items SET status='played', playedAt=NOW()` (`:438–451`).
3. Find next `status='queued'` row, `ORDER BY id ASC LIMIT 1` (`:455–465`).
4. **Emergency auto-promotion** if none queued but an open round exists: pick winner (highest votes → oldest human suggestion → random AI song if live participants), `UPDATE … SET status='queued'`, archive the rest, close the round (`:469–581`).
5. Play next: `UPDATE queue_items SET status='playing', startedAt=NOW()` **and** upsert `playback_sync` (`INSERT … ON DUPLICATE KEY UPDATE`, `:672–677`) with `video_start_time = Date.now()` (`:637`); pause items set `playback_sync … is_playing=0` (`:661–665`). Then schedule the next advance: `sessionTimers[sessionId] = setTimeout(() => advanceToNext(sessionId), safeDurationMs)` with a **default of 180s if duration is null** (`:688–692`).

### 1.5 Playback synchronization

- **Endpoint** `GET /sessions/:id/playback-sync` (`routes/sessions.js:28–41`) simply returns `SELECT current_video_id, video_start_time, is_playing FROM playback_sync WHERE session_id = ?`.
- On advance, the server also emits `playback_sync` over Socket.IO to the room (`services/playback.js:681–686`).
- The **client derives position** as `(Date.now() − video_start_time) / 1000` and re-seeks if it drifts >2s, polling every ~10s (`Frontend/src/context/PlaybackContext.jsx`, `syncPlayback` + the drift interval).
- **Authority split:** the server is authoritative on *which* song and *when it started* (`video_start_time`); the client derives *position*. That part is sound. But *which* song advances only when an **in-memory timer fires** — there is no server-side clock reconciling the DB.

### 1.6 Scheduling

- All advancement is driven by **in-memory `setTimeout`** stored in `sessionTimers` and `phaseTimers` objects (`services/playback.js:14–15`). These are **process memory only**. There is **no persistence, no recovery on boot, no heartbeat**.

---

## 2. What's done well (keep)

- **Position is derived, not stored.** Broadcasting an absolute `video_start_time` (epoch ms) and letting clients compute elapsed time is the correct pattern for A/V sync — it is inherently drift-free at the source (`playback.js:637`, `PlaybackContext` derivation). Keep this; just make `started_at` live on the authoritative row.
- **Single `status` enum on `queue_items`** is the right instinct, and Phase 2 already removed the redundant `played` boolean (`init.sql:29–30`). The direction is correct; it just needs to be finished and the parallel `playback_sync` truth removed.
- **Server-authoritative start time + socket push + client drift-poll** is a reasonable three-layer sync strategy. The bones are good; the missing piece is a server-side reconciler.
- **Proposals-as-queue-items** (`status='suggested'`) is a defensible unification — voting candidates and the queue share one table and one status field.
- **FKs with sensible `ON DELETE` semantics** and the `queue_items` `CHECK` constraint (`init.sql:202–210`) show real schema care.
- **Parameterized queries everywhere** — no string-concatenated SQL in the request path; SQL-injection surface is low.

---

## 3. What's mediocre / could be improved

- **Raw SQL with zero abstraction (243 sites).** Not wrong, but the same query shapes (fetch current playing row, count live participants, etc.) are duplicated across files. There is no data-access layer, so a schema change means hunting dozens of hand-written queries. A thin repository module (`db/sessionRepo.js`, `db/queueRepo.js`) would localize this.
- **`playback_sync.progress_seconds` is dead** (`init.sql:217`, never written). Dead columns invite future confusion ("is this the position?").
- **`safeDurationMs` default of 180s** (`playback.js:688–692`) is a guess. If `youtube_video_cache.duration` is NULL, a 3-minute song and a 6-minute song both get 180s — the server advances at the wrong time and every client is force-corrected. Duration should be reliably populated at cache time.
- **Voting-round winner selection has three fallback tiers** inline in `advanceToNext` (`:487–533`) — highest votes, then oldest human suggestion, then random AI. This business logic is entangled with the state transition; it is hard to test and reason about in isolation.
- **`is_private` gating and participant bookkeeping** are spread across routes and the socket handler with slightly different queries (`sessions.js:786,874`, `playback.js:121,517,586`). Consistent, but duplicated.

---

## 4. What's definitely bad / must be re-solved

Each item below would not pass professional review, with the reason.

### 4.1 Two independent sources of truth for "what's playing"
`queue_items.status='playing'` + `startedAt` **and** `playback_sync.current_video_id` + `video_start_time` + `is_playing` encode the **same fact in two tables**, updated by **separate, non-atomic statements** (`playback.js:667–668` then `:672–677`). If one write succeeds and the other doesn't (crash, error, race), the session is internally inconsistent: a row says "playing" while `playback_sync` says otherwise, or vice-versa. **Professionally, one fact has one home.** Two writable copies of the same state is the defining anti-pattern here.

### 4.2 Three redundant session-liveness flags, one of them dead
`is_active` (line 88), `is_live` (line 91), `ended_at` (line 90). `is_active` is read exactly once (`routes/proposals.js:100`) and **never set to 0 anywhere** — it is decorative. `is_live` and `ended_at` overlap (`ended_at` is set alongside `is_live=0` in only one of the two end paths, `playback.js:219–222`, but *not* the other at `:606`). So `ended_at` is populated inconsistently. **Three columns for one concept, updated in different places, is guaranteed to drift.**

### 4.3 No transaction/lock around the core transition
`advanceToNext` does `SELECT playing row` → `UPDATE … played` → `SELECT next` → `UPDATE … playing` → upsert `playback_sync` as **five+ separate autocommitted statements** (`playback.js:438–692`). Two concurrent invocations (two timers after a restart, a timer racing a manual trigger, or the phase timer racing the song timer) both read the same "playing" row and both advance — **double-skip, or two rows left `status='playing'`.** This is the classic check-then-act race, unguarded. Professional systems wrap this in a transaction with `SELECT … FOR UPDATE` on the session, plus compare-and-swap.

### 4.4 In-memory timers as the only scheduler
`sessionTimers`/`phaseTimers` live in process memory (`playback.js:14–15`) with **no persistence and no boot recovery.** On any deploy, crash, or pm2 restart, **every live session freezes**: the song never advances, the round never closes, and — critically — the code path that would set `is_live=0` **never runs**. The DB is left asserting `is_live=1` with nothing driving it. This is not resilient by any professional standard; scheduled work that matters must survive a restart.

### 4.5 No participant heartbeat
`session_participants.is_live` flips to 1 on join-live and to 0 only on a **clean** socket `disconnect` (`socket.js:68–72`). Real clients die uncleanly (network loss, tab close during sleep, server restart). Without a `last_seen` heartbeat and a reaper, `is_live=1` participant rows accumulate forever, which in turn keeps the session's liveness checks (`playback.js:586`) believing users are present. **Liveness with no heartbeat is liveness that only ever leaks upward.**

### 4.6 Two status columns on `voting_rounds`
`phase` and `status` (`init.sql:251,256`) are updated by different statements (`playback.js:33–39` sets `phase`; `:549–551` sets `status`). They can land in contradictory combinations (`phase='voting'` with `status='closed'`). **One state machine needs one column.**

### 4.7 `DELETE`-as-teardown loses history and races timers
Host "kill" is a hard `DELETE FROM sessions` (`sessions.js:522`). It cascades away all queue/vote/listen history, and if a timer fires between the delete and its cleanup (`:525–528`), `advanceToNext` runs against a session that no longer exists (queries affect 0 rows, but the emitted socket events and the emergency-promotion logic still execute). Ending a session should be a **status transition**, not a destructive delete.

---

## 5. Root-cause analysis of the observed bugs

### 5.1 "Session gets killed but the app still shows it live"
This is not one bug; it is the predictable output of Section 4. `is_live=1` is written in exactly one place (`sessions.js:570`) and cleared in only three narrow, easily-missed paths (`playback.js:219,606`; `DELETE`). The frontend mirrors the flag directly (`SessionPage.jsx:401`). So any of the following leaves a permanently-"live" session:

1. **Process restart / crash / deploy.** In-memory timers vanish (§4.4). The `is_live=0` code paths live *inside* `advanceToNext`/`startPhaseTimer`, which now never fire. `is_live` stays 1 forever. **This is the most likely primary cause.**
2. **Unclean disconnects.** With no heartbeat (§4.5), the last participant's `is_live` never drops to 0, so the `noActiveUsers` check (`playback.js:586`) never becomes true, so the session-end branch never runs.
3. **The end condition is a 3-way AND across three separate SELECTs** (`playback.js:585–608`). It only ends a session when *no users AND no open voting AND nothing playing* are simultaneously true at one instant — a narrow window that live sessions rarely hit cleanly, and which races participant churn (§4.5, agent's race #2).
4. **`DELETE` vs a firing timer** (§4.7): a resurrected `advanceToNext` can re-touch state around a half-deleted session.

**Root cause:** liveness is *inferred from scattered, non-atomic application checks and in-memory timers* instead of being an *authoritative, self-healing state owned by the database*. There is no component whose job is "reconcile reality → mark dead sessions dead."

### 5.2 "Stubborn bugs and lag at the backend↔DB interface and in song switching"
- **Lag** comes from the wrong-duration default (§3, 180s) and from clients being force-seeked by the 10s drift poll when the server's notion of "current song" is stale (frozen timers). When the server clock and DB disagree, every client gets corrected — visible as jumps/lag.
- **Song-switch bugs** are the unguarded races (§4.3, agent's races #1/#3/#6): double-advance, two `playing` rows, `phase`/`status` contradictions, promotion from the wrong round.
- **Interface fragility**: five+ autocommitted writes per transition (§4.1/§4.3) means partial failures leave inconsistent rows that later reads trust.

---

## 6. Recommended new structure

Design goals: **one fact → one home**, **DB is authoritative**, **every transition atomic**, **liveness self-heals**, **survives restart**, **MySQL-only**, **multi-instance-ready**.

### 6.1 Schema (breaking migration, via Knex)

```sql
-- SESSIONS: collapse is_active/is_live/ended_at into one state machine.
ALTER TABLE sessions
  ADD COLUMN status ENUM('draft','live','ended') NOT NULL DEFAULT 'draft';
--  ended_at stays as a plain audit timestamp (not a liveness signal).
--  Drop is_active and is_live after backfill:
--    status='live'  where is_live=1
--    status='ended' where is_live=0 and ended_at IS NOT NULL
--    status='draft' otherwise
ALTER TABLE sessions DROP COLUMN is_active, DROP COLUMN is_live;

-- QUEUE_ITEMS: status stays the single truth for a song's lifecycle.
--  Keep started_at ONLY on the row that is 'playing' (position authority).
--  played_at stays as audit only. Add a per-session guarantee:
CREATE UNIQUE INDEX ux_one_playing_per_session
  ON queue_items (session_id, (CASE WHEN status='playing' THEN 1 END));
--  (or enforce "at most one playing row" in the transaction; see 6.3)

-- Drop the parallel truth entirely:
DROP TABLE playback_sync;   -- current song + start come from the 'playing' row

-- VOTING_ROUNDS: one state column.
ALTER TABLE voting_rounds
  ADD COLUMN state ENUM('suggesting','voting','closed') NOT NULL DEFAULT 'suggesting';
ALTER TABLE voting_rounds DROP COLUMN phase, DROP COLUMN status;

-- PARTICIPANTS: add a heartbeat so liveness self-heals.
ALTER TABLE session_participants
  ADD COLUMN last_seen DATETIME NULL;

-- SCHEDULING: make deadlines durable so a restart can rebuild timers.
ALTER TABLE sessions        ADD COLUMN current_plays_until DATETIME NULL; -- when the playing song ends
--  voting_rounds.phase_ends_at already exists; reuse it as the round deadline.
```

Result: **current song** = the one `queue_items` row with `status='playing'` (`video_id`, `started_at`). **Position** = `now − started_at`, never stored. **Is-playing** = derived (`status='playing'` music row, session `status='live'`, not on a pause). **Session liveness** = `sessions.status`. **Round state** = `voting_rounds.state`.

### 6.2 The `/playback-sync` endpoint becomes a derivation

```sql
SELECT qi.video_id                        AS current_video_id,
       UNIX_TIMESTAMP(qi.started_at)*1000 AS video_start_time,
       (s.status='live' AND qi.item_type='music') AS is_playing
FROM sessions s
JOIN queue_items qi
  ON qi.session_id = s.id AND qi.status='playing'
WHERE s.id = ?;
```

No second table, nothing to keep in sync. The socket `playback_sync` emit sends the same derived shape. The client keeps deriving position exactly as today — **no frontend change required** to the sync contract.

### 6.3 Song switching becomes atomic + idempotent

`advanceToNext(sessionId, expectedCurrentItemId?)`:

```
BEGIN
  SELECT id, status FROM sessions WHERE id=? FOR UPDATE;         -- serialize per session
  SELECT id FROM queue_items
    WHERE session_id=? AND status='playing' FOR UPDATE;          -- lock current
  -- compare-and-swap: if a caller passed expectedCurrentItemId and it no
  -- longer matches, abort — someone already advanced. (idempotent)
  UPDATE queue_items SET status='played', played_at=NOW()
    WHERE id=<current> AND status='playing';                     -- guarded
  <pick next: queued row, else run winner-selection service>
  UPDATE queue_items SET status='playing', started_at=NOW()
    WHERE id=<next>;
  UPDATE sessions SET current_plays_until = NOW() + INTERVAL <dur> SECOND
    WHERE id=?;
COMMIT
-- only AFTER commit: emit playback_sync, (re)arm the in-memory timer.
```

Because the session row is locked `FOR UPDATE`, two concurrent advances serialize; the second sees the already-advanced state and no-ops. Winner-selection moves into its own pure-ish service function (`services/voting.js`) that takes a round id and returns a winner id — testable in isolation.

### 6.4 Server-authoritative, crash-safe scheduling (the reconciler)

A single module `services/scheduler.js` owns time:

- **In-memory `setTimeout` stays** — but only as a latency optimization. The **durable truth** is `sessions.current_plays_until` and `voting_rounds.phase_ends_at`.
- A **reconciler interval** (~2s) runs:
  ```
  -- advance overdue songs
  SELECT id FROM sessions
    WHERE status='live' AND current_plays_until < NOW();      -> advanceToNext(id)
  -- close overdue voting phases
  SELECT id, ... FROM voting_rounds
    WHERE state IN ('suggesting','voting') AND phase_ends_at < NOW();  -> advancePhase()
  -- self-heal liveness: end sessions with no live participants past a grace window
  UPDATE sessions SET status='ended', ended_at=NOW()
    WHERE status='live'
      AND NOT EXISTS (SELECT 1 FROM session_participants sp
                      WHERE sp.session_id=sessions.id AND sp.is_live=1
                        AND sp.last_seen > NOW() - INTERVAL 30 SECOND)
      AND <nothing queued/suggested/playing>;
  -- reap stale participants
  UPDATE session_participants SET is_live=0
    WHERE is_live=1 AND last_seen < NOW() - INTERVAL 30 SECOND;
  ```
- **On boot**, the reconciler simply runs immediately: it rebuilds every timer from `current_plays_until`/`phase_ends_at`. Freezes after restart become impossible, and "stuck live" self-heals within one grace window.
- **Multi-instance later:** wrap each reconciler pass in a MySQL advisory lock (`SELECT GET_LOCK('tunevote:reconciler', 0)`) or a leased "scheduler owner" row, so exactly one instance ticks. No new infra. Designed-for now, not required now.

### 6.5 Heartbeat

The socket connection pings (or any request from the session page updates) `session_participants.last_seen = NOW()` every ~10s. Clean disconnect still sets `is_live=0` immediately; the reconciler catches everything else. Liveness now decays correctly instead of only leaking up.

### 6.6 Ending / killing a session

"Kill" and natural end both become `UPDATE sessions SET status='ended', ended_at=NOW()` inside a transaction, plus timer cleanup — **never a `DELETE`** (keep history; add a separate, explicit "archive/delete" admin action if truly needed). The frontend reads `status`, not three flags.

---

## 7. Prioritized refactoring roadmap

Ordered by impact-per-risk. Each step is independently shippable and leaves the app working.

1. **Atomic `advanceToNext` (transaction + `FOR UPDATE` + compare-and-swap).** *Highest impact, contained.* Kills the double-advance / two-playing-rows / phase-vs-status races (§4.3, §4.6) without any schema change. Do this first — it stops active corruption.
2. **The reconciler + `current_plays_until` + boot recovery** (`services/scheduler.js`). *Kills the #1 root cause of "stuck live" and post-restart freezes* (§5.1). Add `current_plays_until` (additive), write it in the transaction, run the interval. In-memory timers become an optimization.
3. **Participant heartbeat (`last_seen`) + reaper.** Makes liveness self-heal (§4.5). Small, additive, big reliability win.
4. **Collapse session lifecycle → `sessions.status`.** Backfill, switch reads/writes, drop `is_active`/`is_live` (§4.2). Frontend switches from `is_live` to `status`.
5. **Drop `playback_sync`; derive `/playback-sync` from the `playing` row** (§4.1). Removes the second source of truth. Sync contract to clients is unchanged.
6. **Collapse `voting_rounds.phase`+`status` → `state`** (§4.6); extract winner-selection into `services/voting.js`.
7. **Housekeeping:** ensure `youtube_video_cache.duration` is always populated (fixes the 180s default/lag, §3); remove dead `progress_seconds`; introduce thin repository modules to de-duplicate the 243 raw queries.
8. **Ending = status transition, not `DELETE`** (§4.7); add explicit archive path.

Steps 1–3 alone should eliminate the reported symptoms. Steps 4–6 remove the structural redundancy so the bugs cannot come back.

---

## 8. Risks & open questions

- **Migration & backfill risk.** Dropping `is_active`/`is_live`/`playback_sync` is breaking. Needs a backfill migration and a coordinated deploy (frontend must switch to `status` in the same release). Mitigation: ship the additive columns (`status`, `current_plays_until`, `last_seen`) first, dual-read for one release, then drop the old columns.
- **"At most one `playing` row" enforcement.** MySQL's functional unique-index trick (§6.1) works on 8.0+; confirm the engine version, otherwise enforce purely in the locked transaction.
- **Reconciler cadence vs. load.** A 2s interval scanning `WHERE status='live'` is trivial at current scale; confirm indexes (`sessions(status, current_plays_until)`, `voting_rounds(state, phase_ends_at)`). Revisit if session counts grow large.
- **Multi-instance timing.** The advisory-lock approach means one instance ticks; if that instance is slow, advances lag slightly. Acceptable now; revisit if/when horizontal scaling is real.
- **Pause items and `is_playing` derivation.** Confirm the intended client behavior during a `pause` item (silent gap vs. countdown) so the derived `is_playing` matches product intent.
- **Guest churn & heartbeat.** Guests on flaky mobile connections will flip `is_live` on/off; tune the 30s grace window against real reconnect behavior.
- **Open question:** should `voting_round`/queue history survive a session "kill"? The recommendation assumes yes (status transition, keep rows). Confirm before implementing step 8.
- **Out of scope here:** the exposed secrets noted elsewhere (git-embedded tokens, `.env`) and the frontend's prod-pointing `VITE_API_URL` are operational concerns, not part of this data-layer refactor, but should be tracked separately.

---

*End of analysis. No code was modified in producing this document.*
