# TuneVote — Engineering Journal (July 2026)

**What this document is:** a complete, plain-language record of a large block of
work done on TuneVote in early July 2026 — every fix, refactor, and deploy, with
the *why* behind each. It spans **both repos** (`tunevote_api` backend +
`tunevote_frontend` frontend).

**How to use it:**
- **"Is this bug already fixed?"** → jump to [§2 Fixed-bugs registry](#2-fixed-bugs-registry).
  Each row has the symptom, the root cause, the fix, and the commit. If a bug you're
  chasing is listed as ✅ Fixed, don't re-investigate from scratch — read the fix first.
- **New to the team?** → read [§1 TL;DR](#1-tldr), then [§9 Current architecture](#9-current-architecture)
  and [§13 Glossary](#13-glossary).
- **Planning more work?** → [§11 Open items / not yet done](#11-open-items--not-yet-done)
  is the backlog; [§12 Related documents](#12-related-documents) links the deep-dives.

**Golden rule this work followed:** one source of truth per fact, server is
authoritative, every state transition is atomic, and the system self-heals.

---

## 1. TL;DR

Three big themes, all shipped to production and verified live on `app.tunevote.com` / `api.tunevote.com`:

1. **Persistent, YouTube/radio-style player (frontend).** Audio used to stop the
   moment you left a session screen, and switching sessions "kicked you out." Playback
   now lives in one global provider that survives navigation, with a persistent
   bottom banner ("mini-player") that shows the current song, an **Up Next** you can
   vote on, and a **queue overlay** to vote / suggest songs — all without changing pages.
2. **Backend modularization.** `index.js` went from **6,406 lines** to **~170**. The
   monolith was split into 20 focused modules (`routes/*`, `services/*`, `utils/*`,
   `lib/io.js`, `socket.js`, `db.js`).
3. **Playback/DB reliability refactor.** Rewrote the core so "sessions stay live
   after they're killed," song-switch race conditions, post-restart freezes, and lag
   are structurally impossible. Backed by a full [architecture analysis](#12-related-documents)
   and an integration-test suite. Collapsed redundant, drift-prone database state into
   single sources of truth.

Everything below is the detail.

---

## 2. Fixed-bugs registry

> The most useful table in this doc. **Before debugging a reported issue, check here.**
> Status ✅ = fixed & deployed. ⚠️ = mitigated / partially addressed. 🔵 = known, not yet fixed.

| # | Symptom (what users/devs saw) | Root cause | Fix | Where | Status |
|---|---|---|---|---|---|
| 1 | Audio **stops when you tap "back"** / leave the session screen; user effectively kicked out | Player + playback state lived inside the `SessionPage` route, which unmounts on navigation | Lifted all playback into a global `PlaybackProvider` mounted once at the app root; it never unmounts | FE `46b1f18`, `20314a3`, `f9656a3` | ✅ |
| 2 | **Switching sessions** kicks you out of the old one but doesn't cleanly start the new one | No hand-off logic; two sessions could tangle | `joinLive()` now tears down the old session (leave-live + socket + player) before joining the new one — only one session ever active | FE `46b1f18` | ✅ |
| 3 | **React crash** (`NotFoundError: insertBefore/removeChild`) when navigating between sessions; mini-player never appeared | The YouTube IFrame API *replaces* the `<div>` React rendered with an `<iframe>`; once that node became a permanent sibling of the routes, React's DOM ops threw | Give YouTube a **disposable child node** created imperatively inside a stable React-owned wrapper; React never reconciles the swapped node | FE `604e5f6`, `f7beb43` | ✅ |
| 4 | **"Session gets killed but the app still shows it live"** | `is_live` only flipped to 0 via narrow app-logic paths or a `DELETE`; nothing reset it on crash/restart; no participant heartbeat; frontend mirrored the stuck flag | (a) crash-safe **reconciler** ends dead sessions + rebuilds timers on boot; (b) **participant heartbeat** (`last_seen`) so liveness self-heals; (c) collapsed liveness into `sessions.status`, read by the frontend | BE `120172c`, `ac75a67`, `c57daa5`, `8fea276`; FE `7074c3e` | ✅ |
| 5 | **Song-switch bugs / double-skip / two songs "playing"** and general lag at the DB boundary | `advanceToNext` did 5+ non-atomic `SELECT`→`UPDATE`s with no lock; two timers (or timer + manual) raced | Rewrote `advanceToNext` as **one locked transaction** (`SELECT … FOR UPDATE`) with **compare-and-swap** ("only advance if item X is still playing") | BE `4342520` | ✅ |
| 6 | Playback **freezes after a deploy/restart**; songs never advance | Song advancement ran only on **in-memory `setTimeout`s**, lost on restart | DB stores a durable deadline (`sessions.current_plays_until`); the reconciler advances overdue sessions and rebuilds every timer on boot | BE `386e7c5`, `120172c` | ✅ |
| 7 | Clients **lag / get force-jumped** in playback | Wrong default song duration (180s) + stale "current song" when server timers froze | Server is authoritative on start time (`started_at`); position is always derived (`now − started_at`), never stored; reconciler keeps "current" fresh | BE `a1e7222`, `4342520` | ✅ |
| 8 | Local dev: **backend can't reach MySQL** ("Access denied for user 'user'") | A system **MariaDB** was squatting port 3306, blocking the TuneVote Docker `mysql` container from publishing it | Stop MariaDB, recreate the container publishing 3306 (data preserved in its named volume) — see [§10](#10-running-locally-dev) | one-off (dev) | ✅ |
| 9 | Prod deploy: `git pull` fails, prod stuck on old code | Both prod repos had an **expired GitHub token** embedded in their `origin` URL, and pointed at the old `BaskLash/*` repos | Repointed `origin` to the live `olivierluethy/*` repos with a working token | prod ops | ✅ |
| 10 | Participant `is_live` **not decremented on disconnect** (contributes to stuck-live) | The socket `disconnect` handler reads the token from **headers**, but the client sends it via socket.io **`auth`** → identity unresolved → no DB update | The new **heartbeat** handler reads `auth` correctly and the reaper drops stale participants regardless; the disconnect handler itself still reads headers | BE `ac75a67` (mitigation) | ⚠️ |
| 11 | `proposals.js` emits `req.io?.to(...).emit(...)` that do nothing | `req.io` is never set by any middleware → optional-chaining makes them silent no-ops (pre-existing) | Left as-is (no behavior change); documented for cleanup | — | 🔵 |
| 12 | Local frontend talks to **prod API** even in dev | `Frontend/.env` `VITE_API_URL=https://api.tunevote.com/` and many hardcoded `api.tunevote.com` URLs | Not changed (out of scope); noted for a future dev/prod config split | — | 🔵 |

---

## 3. Chronological story (A → Z)

The work happened roughly in this order. Each block below says **what**, **why**, and **how**.

### A. Local dev environment — get the app running (bug #8)
The backend crashed on startup with `Access denied for user 'user'@'localhost'`. A
**system MariaDB** service owned port 3306, so the project's Docker `mysql` container
(which has the real `tunevote` data) couldn't publish its port. Fix: stop MariaDB,
recreate the container publishing `3306:3306` reusing its existing data volume. Frontend
(Vite) already ran on `:5173`, backend on `:4000`.

### B. Global persistent player + mini-player (bugs #1, #2)
Goal: audio should keep playing while you browse other sessions (YouTube-style).
- Created **`PlaybackProvider`** (`Frontend/src/context/PlaybackContext.jsx`) — owns the
  single YouTube IFrame player, the live-playback socket for the *active* session, and all
  playback state (current song, volume, mute, play/pause, voting phase, breaks). Mounted
  **once** at the app root in `main.jsx`, so it survives route changes.
- Created **`MiniPlayer`** — the persistent bottom banner, visible whenever a session is
  active and you're *not* on that session's screen. Tapping it returns you; ✕ leaves.
- `SessionPage` stopped owning the player; it now reads state from the provider and delegates
  control (join/leave/volume/mute) to it. The "switch session" hand-off lives in `joinLive()`.

### C. SessionPage component split
`SessionPage.jsx` was ~2,700 lines. Extracted presentational pieces into
`Frontend/src/components/session/`: `SessionHeader`, `NowPlayingCard`, `VotingBanner`,
`QueuePreview`, `SearchPanel`, and 4 modals (`BreakModal`, `ParticipantsModal`, `QrModal`,
`EditNameModal`). Reduced the file ~43%.

### D. YouTube DOM crash fix (bug #3)
After lifting the player to the always-mounted provider, navigating between sessions threw
React `NotFoundError`s. Cause: `new YT.Player("youtube-player")` *replaces* the React `<div>`
with an `<iframe>`; that mutated node then sat as a permanent sibling of the routes, so React's
insert/remove operations targeted a node that wasn't where its fiber tree expected. Fix: render
a stable React-owned wrapper and hand YouTube a **fresh disposable child** each time — React
never reconciles the swapped node.

### E. Radio-style banner + queue overlay
Extended the mini-player into a "now playing" radio banner:
- **Up Next** segment with cover art + an inline **vote** button (top voting candidate).
- **Open-queue** button → **`QueueOverlay`** modal (no navigation): now-playing indicator,
  live vote candidates with counts + inline voting, the decided up-next queue, and a **song
  search to suggest tracks** — all against the *active* session, from any page.
- The provider gained `queue`/`proposals` state + `voteProposal`, `proposeSong`, `searchSongs`,
  kept live via the `proposals_updated`/`queue_updated` socket events.

### F. Backend modularization (theme #2)
Split `index.js` (6,406 → ~170 lines) into 20 modules, each boot-verified and committed
separately (`e756b1a` … `cfbedd8`). The pattern:
- `db.js` (pool), `lib/io.js` (Socket.IO holder — `init()`/`getIO()`), `socket.js` (connection handler).
- `services/`: `auth`, `playback` (the engine), `broadcast`, `stripe`, `openai`, `mailer`.
- `utils/helpers.js`; `routes/*` (Express routers, one per domain).
- `index.js` stayed the **composition root** — it owns the load-bearing startup order
  (cors → Stripe raw-body webhook → `express.json` → DB check → server + io → route mounts → sockets).

### G. Architecture & DB analysis
Before changing the risky playback/DB code, produced a full honest analysis:
`docs/2026-07-04-architecture-and-database-analysis.md`. It identified the redundant,
drift-prone state and the race conditions that caused the reported bugs. **This is the
"why" behind everything in themes #3 below — read it if you touch playback or the schema.**

### H. Reliability refactor — Phase 1 (bugs #4, #5, #6, #7)
Test-first (see [§8](#8-testing)). Additive & behavior-preserving except where it fixes bugs:
1. **Atomic `advanceToNext`** — locked transaction + compare-and-swap (bug #5).
2. **Crash-safe reconciler** (`services/scheduler.js`) + durable `current_plays_until` — advances
   overdue sessions, rebuilds timers on boot, ends orphaned sessions (bugs #4, #6).
3. **Participant heartbeat** (`last_seen`) + reaper — liveness self-heals (bug #4, #10).

### I. Reliability refactor — Phase 2: collapse redundant state
Each sub-step its own migration + test. See [§7](#7-database-schema--migrations).
- **2A — dropped `playback_sync`.** "Now playing" is derived from the `queue_items` row with
  `status='playing'` (its `started_at`). Removed a whole second source of truth. Response shape
  to clients unchanged.
- **2B — collapsed `voting_rounds.phase` + `.status` → one `state`** (`'suggesting'|'voting'|'closed'`).
  The two columns could contradict each other. `/current-phase` still returns a derived `phase`.
- **2C — collapsed session lifecycle → `sessions.status`** (`'draft'|'live'|'ended'`), replacing the
  dead `is_active` and overlapping `is_live`. Rolled out safely: C1 add + dual-write → C2 frontend
  reads `status` → C3a backend reads `status` → **C3b (drop the old columns) is intentionally NOT
  done yet** — see [§11](#11-open-items--not-yet-done).

### J. Production deployment
Deployed everything to the live server (`salade@72.167.49.141`, app under root's pm2). Steps:
DB backup → fix prod git remotes (expired tokens, bug #9) → `git pull` → `knex migrate:latest`
(4 migrations) → `pm2 restart` → frontend `git pull` + `vite build` into `/var/www/TuneVote/dist`
→ `nginx -s reload`. Verified: schema migrated (backfill 15 draft / 8 live / 10 ended), backend
healthy (MySQL connected, reconciler started, derived endpoints return correct data), and
`app.tunevote.com` serving the new `status`-reading bundle (HTTP 200). Full runbook in [§10](#10-deploying-to-production).

---

## 9. Current architecture

### Backend module map (`tunevote_api`)
```
index.js            ~170  composition root: middleware order, server, io, route mounts, sockets
db.js                     MySQL pool (mysql2/promise), raw parameterized SQL everywhere
lib/io.js                 Socket.IO holder: init(server) once, getIO() at call time
socket.js                 io.on("connection") — heartbeat + disconnect/presence
services/
  playback.js             THE ENGINE: advanceToNext (atomic), startPhaseTimer (voting phases),
                          finalizeListeningForCurrentSong, broadcastLiveParticipants, checkQuorum,
                          createNewPublicSession. Emits via getIO() after commit.
  scheduler.js            reconciler: advance overdue, reap stale participants, end dead sessions;
                          rebuilds work from the DB on boot (crash-safe)
  auth.js                 JWT + token/guest/participant/subscription helpers
  broadcast.js            debounced live-charts + participant-count socket broadcasts
  stripe.js openai.js mailer.js   third-party clients
utils/helpers.js          pure helpers (normalize, parseIsoDuration, getScalar, hashPassword, …)
routes/                   Express routers, one per domain:
  sessions, proposals, invites, profile, artists, auth, oauth, password, billing, youtube
```
DB access is **raw parameterized SQL via the shared pool** (no ORM at runtime; Knex is
migrations-only). Transactions via `pool.getConnection()` + `beginTransaction()` — used
around the playback transition and invite acceptance.

### Frontend structure (`tunevote_frontend`)
```
src/main.jsx                          BrowserRouter → PlaybackProvider → Routes + MiniPlayer
src/context/PlaybackContext.jsx       global playback: player, active-session socket, queue/proposals,
                                      actions (joinLive/leaveLive/vote/propose/search/volume/mute)
src/components/MiniPlayer.jsx         persistent radio banner (Up Next + vote + open queue)
src/components/QueueOverlay.jsx       queue/vote/suggest modal (no navigation)
src/components/SessionPage.jsx        session screen (reads playback from the provider)
src/components/session/*              extracted pieces (header, cards, banner, queue, search, modals)
src/pages/Dashboard.jsx               session list (reads sessions.status === "live")
```

### Key runtime flows
- **Playback position:** server sets `started_at` on the `playing` row and broadcasts it; every
  client derives elapsed time as `now − started_at` and re-seeks on >2s drift (10s poll). Server
  authoritative on *which* song + *when*; client derives position.
- **Song switching:** `advanceToNext(sessionId, expectedItemId)` runs in a locked transaction —
  finalize listen stats → mark current played → pick next (queued, else emergency-promote a voting
  winner) → set next playing + `current_plays_until` → commit → *then* emit + arm the next timer.
- **Voting:** `startPhaseTimer` cycles `voting_rounds.state` suggesting → voting → closed; the winner
  becomes a `queued` item. Timers are in-memory *optimizations*; the reconciler is the durable backstop.
- **Liveness:** `sessions.status='live'` while playing; participants heartbeat `last_seen`; the
  reconciler ends sessions with nothing playable + nobody live, and reaps stale participants.

---

## 7. Database schema & migrations

All migrations are Knex files in `Backend/migrations/`, and a **plain-SQL prod counterpart**
lives in `Backend/scripts/2026-07-04-reliability-refactor-prod.sql` (prod runs `knex migrate:latest`
since the DB is local with full privileges, but the SQL is kept as a reference / fallback).

| Migration | Change | Why |
|---|---|---|
| `…000001_playback_reliability_phase1` | `sessions.current_plays_until`, `session_participants.last_seen`, index | durable deadline (crash recovery) + heartbeat |
| `…000002_drop_playback_sync` | **DROP** `playback_sync` table | it duplicated "now playing" already in `queue_items` |
| `…000003_voting_round_state` | add `voting_rounds.state`, backfill, **DROP** `phase` + `status` | two overlapping status columns could contradict |
| `…000004_sessions_status_additive` | add `sessions.status` (draft/live/ended), backfill | one lifecycle column replacing dead `is_active` + `is_live` |

**Single sources of truth after this work:**
- *Now playing + start time* → the `queue_items` row with `status='playing'` (`video_id`, `started_at`).
- *Session lifecycle* → `sessions.status`. (`is_live`/`is_active` still exist, **dual-written**, pending C3b.)
- *Voting round phase* → `voting_rounds.state`.
- *Playback position* → derived, never stored.

> ⚠️ **`session_participants.is_live` is a DIFFERENT column that STAYS** — don't confuse it with
> `sessions.is_live` (which C3b will drop).

---

## 8. Testing

There was no test harness before. Added a lightweight **integration test** setup that runs against
a real MySQL DB (the local dev container):
- `test/run.js` — runner (`node test/run.js test/<file>.js`), initialises a non-listening Socket.IO so engine emits are no-ops.
- `test/helpers/fixtures.js` — `seedLiveSession` / `cleanupSession` + asserts.
- Tests: `advance.concurrent` (double-advance race), `plays_until` (deadline), `reconciler`
  (overdue advance + boot recovery), `heartbeat` (reaper respects `last_seen`),
  `playback_sync_derive` (derived now-playing), `voting_state` (state collapse via emergency promotion),
  `session_status` (status/is_live dual-write consistency), `harness.smoke`.

Run all: `for t in advance.concurrent plays_until reconciler heartbeat playback_sync_derive voting_state session_status; do node test/run.js test/$t.test.js; done`

**Verification note:** the sandbox used for this work SIGTERMs any long-running port-binding process,
so the *live server* was verified by boot-log ("MySQL connected", "Reconciler started", no errors) +
these integration tests, not by a persistent local server. Full request-level behavior was verified
against production after deploy.

---

## 10. Running locally (dev)
- **DB:** the `tunevote` data lives in a Docker `mysql` container. If the backend can't connect
  (bug #8), a host MariaDB is likely squatting `:3306` — `sudo systemctl stop mariadb`, then recreate
  the container publishing `3306:3306` (reuse volume `tunevote_api_mysql_data`).
- **Backend:** `cd Backend && node index.js` (port 4000). Expect "MySQL connected" + "Reconciler started".
- **Frontend:** `cd Frontend && npm run dev` (Vite, port 5173).
- **Note:** `Frontend/.env` `VITE_API_URL` points at **prod** — local frontend talks to the prod API unless changed (bug #12).

## 10b. Deploying to production
Server `salade@72.167.49.141` (Ubuntu, passwordless sudo; app + repos owned by root, run under
**root's pm2**). DB is **local** MySQL at `127.0.0.1:3306` with full privileges. nginx serves the
frontend directly from **`/var/www/TuneVote/dist`**.

```bash
# --- backup first (destructive DDL) ---
mysqldump --protocol=TCP --single-transaction --no-tablespaces -h 127.0.0.1 -u user -p tunevote > ~/backup.sql
# --- backend (brief maintenance window because migrations drop columns/tables) ---
sudo pm2 stop tunevote_api
sudo git -C /var/www/tunevote_api pull origin main
cd /var/www/tunevote_api && sudo npm install
sudo npx knex migrate:latest        # runs pending migrations
sudo pm2 restart tunevote_api
sudo pm2 logs tunevote_api --lines 30 --nostream   # expect MySQL connected + Reconciler started
# --- frontend ---
cd /var/www/TuneVote && sudo git pull origin main && sudo npm install
sudo pkill -f "vite build"; sudo rm -rf dist && sudo npx vite build   # avoid build races
sudo nginx -s reload
```
Verify: `curl -s https://app.tunevote.com/ | grep index-` (new bundle hash) and
`curl https://api.tunevote.com/sessions/<liveId>/current-phase`.

> The prod git remotes were on `BaskLash/*` with expired tokens; they were repointed to
> `olivierluethy/*` with a working token (bug #9). The stale full reference is corrected in the
> team's private notes.

---

## 11. Open items / not yet done

| Item | Notes |
|---|---|
| **C3b — drop `sessions.is_active` + `is_live`** | The final source-of-truth step. **Un-gated now** (the `status`-reading frontend is deployed), so it's safe whenever. Exact steps + migration ready in `docs/superpowers/plans/2026-07-04-C3b-drop-is_live-READY.md`. Keep `session_participants.is_live`. |
| Disconnect handler reads token from headers, not `auth` (bug #10) | Heartbeat/reaper mitigates, but fixing the disconnect handler to read `socket.handshake.auth` would make immediate leave cleaner. |
| `req.io?` no-op emits in `proposals.js` (bug #11) | Dead code; either wire a `req.io` middleware or remove. |
| `VITE_API_URL` → prod in dev (bug #12) | Add a proper dev/prod config split so local dev hits local API. |
| Large routers | `routes/sessions.js` and `routes/profile.js` are still big; can be split further if desired. |
| Secrets hygiene | Tokens are embedded in git remotes and `.env`; rotate periodically (the SSH password + a GitHub token were shared in chat during deploy — rotate those). |
| Reconciler for multi-instance | Currently single-process. To scale to multiple backend instances, guard `reconcileOnce` with a MySQL advisory lock so exactly one instance ticks. |

---

## 12. Related documents
- **Architecture & DB analysis** (the "why"): `docs/2026-07-04-architecture-and-database-analysis.md`
- **Phase 1 plan** (atomic advance, reconciler, heartbeat): `docs/superpowers/plans/2026-07-04-playback-reliability-phase1.md`
- **Phase 2 plan** (source-of-truth collapse): `docs/superpowers/plans/2026-07-04-source-of-truth-collapse-phase2.md`
- **C3b ready-to-run** (final column drop, gated): `docs/superpowers/plans/2026-07-04-C3b-drop-is_live-READY.md`
- **Prod SQL** (plain-DDL migration counterpart): `scripts/2026-07-04-reliability-refactor-prod.sql`

---

## 13. Glossary
- **Session** — a live room where participants add/vote on songs and hear them in sync.
- **Queue item** (`queue_items`) — a song (or a "pause"/break) in a session. Its `status`
  (`queued`/`playing`/`played`/`suggested`/`archived`) is its lifecycle; the `playing` row is "now playing".
- **Voting round** (`voting_rounds`) — a suggest→vote cycle whose winner becomes the next queued song.
  Its `state` is `suggesting`/`voting`/`closed`.
- **Reconciler** — a ~2s server loop (`services/scheduler.js`) that makes the DB the authority:
  advances overdue songs, ends dead sessions, reaps stale participants, and rebuilds timers after a restart.
- **Mini-player / banner** — the persistent bottom bar (frontend) showing the *active playback session*
  (not necessarily the page you're on).
- **Compare-and-swap** — "only do X if the state is still what I expect", used to make `advanceToNext` idempotent.
- **Dual-write** — during a schema transition, write both the old column (`is_live`) and the new one
  (`status`) so old and new code/clients coexist safely until the old column is dropped.
```

*Journal covers work through 2026-07-04. Keep appending as work continues.*
