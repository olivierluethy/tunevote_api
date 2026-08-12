# Issue-Backlog Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub issues #45 (bug) and #18, #24, #27, #39, #43, #44, #46, #50 (features) for TuneVote.

**Architecture:** Additive Knex migrations for schema; new logic in `services/`; new endpoints as Express routers in `routes/`; realtime via `lib/io.js`/`socket.js`/`services/broadcast.js`; React UI in `../tunevote_frontend/src/`. Pure logic is unit-tested through `test/run.js`; endpoint/DB/socket paths are verified manually in the deploy env.

**Tech Stack:** Node/Express, MySQL (mysql2 pool `require("../db")`), Knex migrations, socket.io, OpenAI (`services/openai.js`), React + Vite + Tailwind.

## Global Constraints

- Migrations are idempotent and `INFORMATION_SCHEMA`-guarded; `down` is one-way (throws), matching `migrations/20260728000002_shout_reactions_and_edit.js`.
- DB access via `const pool = require("../db")` and `pool.query(sql, params)` (never string-interpolate SQL).
- Socket access via `const { getIO } = require("../lib/io")`.
- Genre values come from the single fixed list in `services/genres.js` — never hard-code genre strings elsewhere.
- Guest vs user identity: `user_id` for logged-in, `guest_id`/`guest_token` for guests; endpoints already resolve identity via existing auth helpers — reuse them, do not invent new auth.
- Frontend: read the target component fully before editing; follow its existing hooks/state/style. No new state-management library.
- Do not auto-close any GitHub issue from code; issues close only after manual Verify passes.

---

## Task 0: Shared migrations + genres module

**Files:**
- Create: `migrations/20260812000001_genre_column.js`
- Create: `migrations/20260812000002_participants_cohost_role.js`
- Create: `migrations/20260812000003_sessions_ai_genre.js`
- Create: `migrations/20260812000004_polls.js`
- Create: `services/genres.js`
- Test: `test/genres.test.js`

**Interfaces:**
- Produces: `services/genres.js` exports `GENRES` (string[]), `isGenre(g)` → bool, `classifyGenre(title, artist?)` → Promise<string> (one of GENRES, defaults `"Other"`).

- [ ] **Step 1: Write `services/genres.js`** — export the fixed list and helpers:

```js
const { openai, CHAT_MODEL } = require("./openai");

const GENRES = [
  "Pop", "Hip-Hop/Rap", "Rock", "Electronic/Dance", "R&B/Soul", "Latin",
  "Country", "Jazz/Blues", "Classical", "Metal", "Folk/Acoustic",
  "Reggae/Dancehall", "Schlager/Volksmusik", "Other",
];
const SET = new Set(GENRES);
const isGenre = (g) => typeof g === "string" && SET.has(g);

async function classifyGenre(title, artist = "") {
  if (!openai || !title) return "Other";
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      messages: [{
        role: "user",
        content:
          `Classify this song into EXACTLY ONE genre from this list: ${GENRES.join(", ")}.\n` +
          `Song: "${title}"${artist ? ` by ${artist}` : ""}.\n` +
          `Reply with only the genre string, nothing else.`,
      }],
    });
    const raw = (res.choices?.[0]?.message?.content || "").trim();
    const hit = GENRES.find((g) => g.toLowerCase() === raw.toLowerCase())
      || GENRES.find((g) => raw.toLowerCase().includes(g.toLowerCase()));
    return hit || "Other";
  } catch (e) {
    console.warn("classifyGenre failed:", e.message);
    return "Other";
  }
}
module.exports = { GENRES, isGenre, classifyGenre };
```

- [ ] **Step 2: Test `isGenre`** (pure, no network) in `test/genres.test.js`:

```js
const assert = require("assert");
const { isGenre, GENRES } = require("../services/genres");
assert.strictEqual(isGenre("Pop"), true);
assert.strictEqual(isGenre("Nonsense"), false);
assert.strictEqual(GENRES.includes("Other"), true);
console.log("genres ok");
```
Run: `node test/genres.test.js` → prints `genres ok`.

- [ ] **Step 3: Write the four migrations.** Follow the idempotent guard pattern from `20260728000002_shout_reactions_and_edit.js` (`columnExists`, and for tables a `SHOW TABLES LIKE`/INFORMATION_SCHEMA guard). Specifics:
  - `genre_column`: `ALTER TABLE youtube_video_cache ADD COLUMN genre VARCHAR(40) NULL` (guarded).
  - `participants_cohost_role`: `ALTER TABLE session_participants MODIFY COLUMN role ENUM('host','co-host','user','guest') NOT NULL` (check current enum first; MODIFY is safe/idempotent).
  - `sessions_ai_genre`: `ALTER TABLE sessions ADD COLUMN ai_genre VARCHAR(40) NULL` (guarded).
  - `polls`: create `polls`, `poll_options`, `poll_votes` (guarded by INFORMATION_SCHEMA table check), schema per spec; then seed one active poll + options **only if `polls` is empty**.

- [ ] **Step 4: Verify migrations** in deploy env: `npm run migrate:latest` then `npm run verify-schema`. Expected: all four apply cleanly, re-running is a no-op.

- [ ] **Step 5: Commit** `git add services/genres.js test/genres.test.js migrations/2026081200000*.js && git commit -m "feat(schema): genre column, co-host role, ai_genre, polls + genres module"`

---

## Task 1: #45 — Guest bootstrap on "Start a Session"

**Files:**
- Modify: `../tunevote_frontend/src/pages/Home.jsx` (the "Start a Session" handlers, ~lines 104-146)
- Modify/inspect: the frontend api/util module that stores `guestToken` (grep `guestToken` in `src/`)
- Possibly modify: `../tunevote_frontend/src/pages/Dashboard.jsx` (mount guard)
- Backend: confirm a guest-mint endpoint exists (grep `guest_token`/`guest` in `routes/`); if none, add `POST /auth/guest` returning `{ guestToken }` (insert into `guest_users`).

**Interfaces:**
- Produces: `ensureGuestToken()` async util → returns existing or newly-minted guest token string, persisted to localStorage.

- [ ] **Step 1:** Grep how `guestToken` is currently created/stored and which endpoint mints it. Read those spots. Record the exact endpoint + storage key.
- [ ] **Step 2:** Implement `ensureGuestToken()` in the existing api util: if token in storage return it; else POST the mint endpoint, store, return.
- [ ] **Step 3:** In `Home.jsx`, make the "Start a Session" action `await ensureGuestToken()` before navigating to `/dashboard`. Add the same guard on `Dashboard.jsx` mount before the public-sessions fetch.
- [ ] **Step 4: Verify** (deploy env, fresh browser/incognito): Home → Start a Session → public sessions render immediately; `guestToken` present in localStorage.
- [ ] **Step 5: Commit** `fix(guest): mint guest token before entering dashboard (closes idea #45)`

---

## Task 2: #39 + #43 — Genre tagging, host genre, genre ranking

**Files:**
- Modify: `routes/youtube.js` (tag genre on cache-miss write)
- Create: `scripts/backfill-genres.js` (batch-tag existing rows)
- Modify: `services/recommendations.js` (use `sessions.ai_genre` to steer prompt; ~lines 79-120)
- Modify: `routes/sessions.js` (add `PATCH /sessions/:id/ai-genre`, host/co-host gated — depends on Task 3 helper; if Task 3 not yet merged, gate host-only for now and widen later)
- Create: `routes/stats.js` (or extend an existing stats route) with `GET /stats/genre-ranking`
- Modify: `index.js` (mount `routes/stats.js` if new)
- Modify: frontend host controls component (grep the AI/round host controls in `src/components/session/`) + a rankings view
- Test: `test/genre_ranking.test.js` (pure aggregation shaping helper)

**Interfaces:**
- Consumes: `services/genres.js#{GENRES,isGenre,classifyGenre}`.
- Produces: `PATCH /sessions/:id/ai-genre {genre|null}`; `GET /stats/genre-ranking?window=week|month|all` → `[{genre, plays, share}]`.

- [ ] **Step 1:** In `routes/youtube.js`, at the point a new `youtube_video_cache` row is inserted (grep the INSERT), call `classifyGenre(title)` and store `genre`. Keep it non-blocking-safe: if classify throws, insert with `genre=NULL` (never fail the request).
- [ ] **Step 2:** Write `scripts/backfill-genres.js`: select cached rows where `genre IS NULL` in batches, classify, update. Log progress. Idempotent.
- [ ] **Step 3:** In `recommendations.js`, when the session's `ai_genre` is set, replace the random `angle` with `include tracks in the ${ai_genre} genre`; when null keep the random `EXPLORATION_ANGLES` pick. Load `ai_genre` via a small query on the session.
- [ ] **Step 4:** Add `PATCH /sessions/:id/ai-genre`: validate body genre with `isGenre` (or null to clear), `UPDATE sessions SET ai_genre=?`. Return the new value.
- [ ] **Step 5:** Write the ranking aggregation. Prefer `session_song_listens` joined to `youtube_video_cache.genre`; fallback `playback_history`. Group by genre within the window (`week`=7d, `month`=30d, `all`). Compute `share = plays/total`. Extract the shaping (rows → sorted `[{genre,plays,share}]`) into a pure helper and unit-test it in `test/genre_ranking.test.js`.
- [ ] **Step 6:** Frontend: add the single-select genre dropdown (options = `GENRES` + "Any") to host controls, wired to the PATCH endpoint; add a genre-ranking panel with a week/month/all toggle calling the endpoint.
- [ ] **Step 7: Verify** (deploy env): play a few songs (genres populate), set host genre → next AI round reflects it; `GET /stats/genre-ranking?window=week` returns a ranked list.
- [ ] **Step 8: Commit** `feat(genre): AI genre tagging, host genre steer, genre ranking (ideas #39,#43)`

---

## Task 3: #24 — Host / Co-Host / Member roles

**Files:**
- Create: `services/permissions.js`
- Modify: `routes/sessions.js`, `routes/proposals.js`, `routes/invites.js` (swap host-only checks for `isHostOrCoHost` on: start/stop round, rename, delete/manage queue items, invites, kick guest)
- Create endpoint in `routes/sessions.js`: `PATCH /sessions/:id/participants/:participantId/role`
- Modify: `services/broadcast.js` (emit `participant_role_changed`)
- Modify: `../tunevote_frontend/src/components/session/ParticipantsModal.jsx` + host-control gating in the session view
- Test: `test/permissions.test.js`

**Interfaces:**
- Produces: `services/permissions.js#isHost(session, userId)` and `isHostOrCoHost(session, participantsOrRoleLookup, userId)` → bool. Socket event `participant_role_changed { participantId, role }`.

- [ ] **Step 1:** Write `services/permissions.js` with pure predicates. `isHost` = `session.user_id === userId`. `isHostOrCoHost(userId, roleOfUser)` = host OR `roleOfUser === 'co-host'`. Keep signatures simple and data-driven (pass the resolved role in).
- [ ] **Step 2:** Unit-test both predicates in `test/permissions.test.js` (host true; co-host true for isHostOrCoHost, false for isHost; member false; guest false).
- [ ] **Step 3:** Add `PATCH /sessions/:id/participants/:participantId/role` — host-only; body `{role:'co-host'|'user'}`; reject if target is a guest; UPDATE `session_participants.role`; broadcast `participant_role_changed`.
- [ ] **Step 4:** Replace host-only guards on the listed endpoints with a co-host-aware check (resolve the caller's `session_participants.role`, then `isHostOrCoHost`). Keep delete-session and role-change host-only.
- [ ] **Step 5:** Frontend: in `ParticipantsModal`, host sees promote/demote per logged-in participant; show a "Co-Host" badge; co-hosts render host controls; update live on `participant_role_changed`.
- [ ] **Step 6: Verify** (deploy env): host promotes member → member can start a round + rename; demote removes access; guest never promotable.
- [ ] **Step 7: Commit** `feat(roles): co-host role with delegated host powers (idea #24)`

---

## Task 4: #27 — Regenerate AI suggestions (live-user majority)

**Files:**
- Modify: `routes/proposals.js` (new endpoint + in-memory tally)
- Reuse: `services/recommendations.js#generateAiSuggestions` (add optional extra-exclusions param)
- Modify: frontend suggestion-phase UI (the proposals/voting panel in `src/components/`)
- Test: `test/regenerate_threshold.test.js`

**Interfaces:**
- Produces: `POST /proposals/:roundId/regenerate-vote` → `{ rejections, liveUsers, regenerated }`. Pure helper `shouldRegenerate(rejections, liveUsers)` → bool (`rejections > liveUsers/2`).

- [ ] **Step 1:** Add pure `shouldRegenerate(rejections, liveUsers)` (majority strictly over half) and unit-test edge cases (2/3 true, 1/3 false, 2/4 false, 3/4 true, liveUsers 0 → false) in `test/regenerate_threshold.test.js`.
- [ ] **Step 2:** In `proposals.js` add module-level `const rejectionsByRound = new Map()` and `const regeneratedRounds = new Set()`.
- [ ] **Step 3:** Endpoint records the caller's voterKey in the round's Set, counts live users for the session, and if `shouldRegenerate` and not already regenerated: archive the round's `status='suggested' item_source='ai'` items, call `generateAiSuggestions(sessionId, roundId, needed, {excludeTitles: rejectedTitles})`, mark regenerated, broadcast the proposals refresh. Return the tallies.
- [ ] **Step 4:** Extend `generateAiSuggestions` to accept optional `{ excludeTitles }` merged into `allTitles`. Default behaviour unchanged.
- [ ] **Step 5:** Frontend: "👎 Not feeling these" button in the suggestion phase showing `rejections/liveUsers`; disable after voting; list refreshes on the existing socket update.
- [ ] **Step 6: Verify** (deploy env): with N live users, >N/2 rejections → exactly one regeneration, new titles ≠ rejected.
- [ ] **Step 7: Commit** `feat(ai): live-user majority regenerate of AI suggestions (idea #27)`

---

## Task 5: #44 — Live anonymous home-page poll

**Files:**
- Create: `routes/polls.js`; mount in `index.js`
- Modify: `socket.js` (a `home` room + `poll_results` broadcast)
- Create: `../tunevote_frontend/src/components/HomePoll.jsx`; use it in `Home.jsx`
- Test: `test/poll_percent.test.js`

**Interfaces:**
- Produces: `GET /polls/active` → `{id, question, options:[{id,label,votes}], total}`; `POST /polls/:id/vote {optionId, voterKey}`. Pure `pollPercents(options)` → options with `pct`.

- [ ] **Step 1:** Pure `pollPercents(options)` (each `pct = round(votes/total*100)`, total 0 → 0). Unit-test in `test/poll_percent.test.js`.
- [ ] **Step 2:** `routes/polls.js`: `GET /polls/active` (single `is_active=1` poll + option vote counts); `POST /polls/:id/vote` resolves `voterKey` (user public_id | guest token | client-sent anon id), INSERT into `poll_votes` (UNIQUE guard rejects dupes → 409), then emit `poll_results` to `home` room.
- [ ] **Step 3:** Mount router in `index.js`; add `home` room join on socket connect in `socket.js`.
- [ ] **Step 4:** `HomePoll.jsx`: fetch active poll; before-vote shows option buttons; after-vote shows animated `pct` bars; localStorage guard `poll_voted_<id>`; subscribe to `poll_results`.
- [ ] **Step 5: Verify** (deploy env, two tabs): vote once → bars update live in both; re-vote from same identity → rejected.
- [ ] **Step 6: Commit** `feat(polls): live anonymous home-page poll (idea #44)`

---

## Task 6: #46 — Live song trends in search

**Files:**
- Create: `routes/trends.js` (or add to `routes/youtube.js`); mount if new
- Modify: `../tunevote_frontend/src/components/session/SearchPanel.jsx`
- Test: `test/trend_momentum.test.js`

**Interfaces:**
- Produces: `GET /trends?videoIds=a,b,c` → `{ [id]: {pct, dir} }`. Pure `momentum(recent, previous)` → `{pct, dir}` with deadband.

- [ ] **Step 1:** Pure `momentum(recent, previous)`: `pct = previous>0 ? round((recent-previous)/previous*100) : (recent>0?100:0)`; `dir = pct>5?'up':pct<-5?'down':'flat'`. Unit-test in `test/trend_momentum.test.js`.
- [ ] **Step 2:** Endpoint: for the given video ids, count plays (`session_song_listens`/`playback_history`) + votes in last 7d and prior 7d, apply `momentum`, return the map; unknown ids → `{pct:0,dir:'flat'}`.
- [ ] **Step 3:** `SearchPanel.jsx`: after results render, batch-GET trends for visible ids; render a coloured arrow + `pct%` per row (green up / red down / grey flat).
- [ ] **Step 4: Verify** (deploy env): a song with more plays in the last 7d than prior 7d shows green up + positive %.
- [ ] **Step 5: Commit** `feat(search): 7-day trend momentum arrows in search (idea #46)`

---

## Task 7: #18 — Ephemeral emoji reactions

**Files:**
- Modify: `socket.js` (handle + rebroadcast, rate-limited)
- Create: `../tunevote_frontend/src/components/session/ReactionBar.jsx`; mount over the player in the session view
- Test: `test/reaction_ratelimit.test.js`

**Interfaces:**
- Produces: socket `song_reaction {sessionId, emoji}` → server → `song_reaction_broadcast {emoji}`. Pure `allowReaction(bucketState, nowMs)` token-bucket helper.

- [ ] **Step 1:** Pure token-bucket `allowReaction(state, nowMs)` (max ~5 per rolling second). Unit-test allow/deny in `test/reaction_ratelimit.test.js`.
- [ ] **Step 2:** In `socket.js`, handle `song_reaction`: validate emoji ∈ allow-list `["😍","🔥","👏","🎉","😴"]`, apply per-socket rate limit, rebroadcast `song_reaction_broadcast` to the session room.
- [ ] **Step 3:** `ReactionBar.jsx`: five emoji buttons; tap emits + local float animation; incoming `song_reaction_broadcast` spawns a floating emoji. CSS float/fade animation.
- [ ] **Step 4: Verify** (deploy env, two clients): reactions from one float on both; spamming is throttled.
- [ ] **Step 5: Commit** `feat(session): ephemeral emoji reactions on the playing song (idea #18)`

---

## Task 8: #50 — "Polar Moment" rank-gap stat

**Files:**
- Modify: `routes/stats.js` (add `GET /stats/polar-moment`) or `services/userStats.js`
- Modify: frontend profile/stats page
- Test: `test/polar_moment.test.js`

**Interfaces:**
- Produces: `GET /stats/polar-moment` (auth) → `{rank, myScore, above:{name,score}|null, gap, suggestion}`. Pure `polarMoment(leaderboard, userId)` computes the shape from a ranked votes-given list.

- [ ] **Step 1:** Pure `polarMoment(sorted, userId)` where `sorted` = `[{userId,name,score}]` desc: find rank/index, `above = sorted[i-1]||null`, `gap = above ? above.score-myScore : 0`, `suggestion` string. Unit-test: mid-list (correct above+gap), rank 1 (above null, "#1" suggestion), not-found (null). `test/polar_moment.test.js`.
- [ ] **Step 2:** Endpoint: aggregate votes-given per user (`SELECT user_id, COUNT(*) score FROM votes WHERE user_id IS NOT NULL GROUP BY user_id`), join names, sort desc, call `polarMoment` for the caller, return it.
- [ ] **Step 3:** Frontend: a "Polar Moment" card on the profile/stats page rendering rank, the competitor above, the gap, and the suggestion.
- [ ] **Step 4: Verify** (deploy env): a mid-leaderboard user sees the correct next-higher competitor + gap; top user sees the #1 state.
- [ ] **Step 5: Commit** `feat(stats): Polar Moment rank-gap stat (idea #50)`

---

## Self-review notes

- Every spec section maps to a task: #45→T1, #39/#43→T2, #24→T3, #27→T4, #44→T5, #46→T6, #18→T7, #50→T8, shared schema→T0.
- Type consistency: `classifyGenre`, `isGenre`, `GENRES` (T0) reused by T2; `isHostOrCoHost` (T3) used by T2/T4 endpoints (T2's PATCH gates host-only until T3 lands, then widens); `generateAiSuggestions({excludeTitles})` (T4) is a backward-compatible extension.
- Ordering: T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8. T3 before T4 so co-host gating exists; T2 can run before T3 with a temporary host-only gate on its PATCH.
- Backend logic is unit-tested via `node test/<name>.test.js`; DB/socket/UI paths carry manual Verify steps because no DB/socket runs in this workspace.
