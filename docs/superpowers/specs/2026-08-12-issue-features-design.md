# TuneVote — Issue-Backlog Features Design (2026-08-12)

Design for the 8 not-started feature ideas plus 1 confirmed bug identified in the
`OPEN_ISSUES_AUDIT.md` audit. Scope: GitHub issues **#45, #18, #24, #27, #39, #43,
#44, #46, #50** in `olivierluethy/tunevote_api`.

Conventions followed: Express routers in `routes/`, business logic in `services/`,
realtime via `lib/io.js` + `services/broadcast.js` + `socket.js`, schema changes as
timestamped Knex migrations in `migrations/`, React (Vite) UI in
`../tunevote_frontend/src/`.

Testing reality: unit-testable pure logic is covered by the existing `test/run.js`
harness. Endpoint/DB/socket behaviour requires a running MySQL + socket server
(the deploy environment); each feature lists manual verification steps.

---

## Shared schema migrations

New timestamped Knex migrations (additive, reversible):

1. `youtube_video_cache.genre VARCHAR(40) NULL` — AI-assigned genre (#39, #43).
2. `session_participants.role` ENUM extended to `('host','co-host','user','guest')` (#24).
3. `sessions.ai_genre VARCHAR(40) NULL` — host-chosen recommendation genre (#39).
4. `polls`, `poll_options`, `poll_votes` tables (#44):
   - `polls(id, question VARCHAR(255), is_active TINYINT DEFAULT 0, created_at)`
   - `poll_options(id, poll_id FK, label VARCHAR(120), sort INT)`
   - `poll_votes(id, poll_id FK, option_id FK, voter_key VARCHAR(64), created_at,
     UNIQUE(poll_id, voter_key))`
   - Seed one example active poll.

Fixed genre list (single source, shared by classifier + host dropdown + ranking),
defined in `services/genres.js`:
`Pop, Hip-Hop/Rap, Rock, Electronic/Dance, R&B/Soul, Latin, Country, Jazz/Blues,
Classical, Metal, Folk/Acoustic, Reggae/Dancehall, Schlager/Volksmusik, Other`.

---

## #45 — Guest not recognized on "Start a Session" (bug)

**Root cause.** `Home.jsx` "Start a Session" navigates to `/dashboard` without a
`guestToken`; `GET /sessions` requires one to return public sessions, so the list is
empty until a token is minted on first join.

**Fix.** Frontend helper `ensureGuestToken()` (in the existing api/util module) that
returns the stored `guestToken` or mints one via the existing guest endpoint and
persists it. Call it before navigating from Home's "Start a Session", and defensively
on Dashboard mount before the public-sessions fetch. No backend change if a
guest-mint endpoint already exists; otherwise add `POST /auth/guest`.

**Verify.** Fresh browser (no localStorage) → Home → Start a Session → public
sessions render immediately; `guestToken` present in localStorage.

---

## #18 — Ephemeral emoji reactions on the playing song

**Realtime.** New socket event `song_reaction { sessionId, emoji }` handled in
`socket.js`; server validates emoji against a small allow-list and rebroadcasts
`song_reaction_broadcast { emoji }` to the session room. Per-socket rate limit
(~5/sec, token bucket in memory).

**Frontend.** A reaction bar (5 emojis: 😍 🔥 👏 🎉 😴) over the player in the session
view; tap emits the socket event and triggers a local float animation; received
broadcasts spawn the same floating animation. No persistence, no stats weight.

**Verify.** Two clients in a live session; reactions from one appear floating on both.

---

## #24 — Roles: Host / Co-Host / Member

**Permissions.** New helper `services/permissions.js#isHostOrCoHost(session, userId)`
and `isHost(...)`. Replace the current host-only checks with `isHostOrCoHost` on:
start/stop round, rename session, delete/manage queue items, send invites, kick
guests. Deleting the session and promoting/demoting co-hosts stays **host-only**.

**API.** `PATCH /sessions/:id/participants/:participantId/role` (host-only), body
`{ role: 'co-host' | 'user' }`. Only logged-in participants (not guests) can become
co-host. Emits `participant_role_changed { participantId, role }` to the room.

**Frontend.** `ParticipantsModal` shows, for the host, a promote/demote control per
logged-in participant; a "Co-Host" badge next to co-hosts; co-hosts render the host
control surface. Role updates arrive live via the socket event.

**Verify.** Host promotes a member → that member gains host controls and can start a
round; host demotes → controls disappear; guests never promotable.

---

## #27 — Regenerate bad AI suggestions (live-user majority)

**API.** `POST /proposals/:roundId/regenerate-vote` (auth: live user or guest).
Server keeps an in-memory `Map<roundId, Set<voterKey>>` of rejections plus a
`regeneratedRounds` set. On each vote it recomputes the live-user count for the
session; when `rejections > liveUsers/2` and the round has not regenerated yet, it:
archives the round's `status='suggested', item_source='ai'` items, calls
`generateAiSuggestions` again with the rejected titles added to the exclusion list,
marks the round regenerated, and broadcasts a proposals refresh. Only once per round.

**Frontend.** During the suggestion phase, a "👎 Not feeling these" button showing
`rejections / liveUsers`; disabled after the current user has voted. On regeneration,
the proposals list refreshes via the existing socket path.

**Verify.** In a live session with N live users, >N/2 rejections triggers exactly one
regeneration; new AI titles differ from the rejected ones.

---

## #39 — Host chooses the AI genre

**API.** `PATCH /sessions/:id/ai-genre` (host/co-host), body `{ genre|null }` validated
against the fixed genre list; stored in `sessions.ai_genre`.
`services/recommendations.js` uses `ai_genre` (when set) to steer the prompt instead
of the random `EXPLORATION_ANGLES` pick; when null, current random behaviour stays.

**Frontend.** Single-select genre dropdown (options = fixed list + "Any") in the live
host controls; change persists via the endpoint and affects the next round.

**Verify.** Set genre → next AI suggestions reflect it; "Any" restores random angles.

---

## #43 — Genre ranking over a time period

**Data.** `services/genres.js#classifyGenre(title, artist)` calls `services/openai.js`
to return exactly one genre from the fixed list. Invoked on cache-miss when a video is
first written to `youtube_video_cache` (in `routes/youtube.js`), storing `genre`.
Optional `scripts/backfill-genres.js` to tag existing rows in batches.

**API.** `GET /stats/genre-ranking?window=week|month|all` aggregates play counts by
genre over the window, joining `session_song_listens` (fallback
`playback_history`) → `youtube_video_cache.genre`, returning ranked
`[{genre, plays, share}]`.

**Frontend.** A genre-ranking panel in the existing rankings/stats UI with a window
toggle.

**Verify.** After some tagged plays, the endpoint returns a sensible ranking; window
toggle changes results.

---

## #44 — Live anonymous home-page poll

**API.** `GET /polls/active` → `{ id, question, options:[{id,label,votes}], total }`.
`POST /polls/:id/vote { optionId }` with a `voter_key` = user public_id, else guest
token, else an anonymous localStorage id sent by the client; UNIQUE`(poll_id,
voter_key)` rejects double votes server-side. New vote broadcasts `poll_results
{ pollId, options, total }` to a `home` socket room.

**Frontend.** Home poll card: options as buttons before voting; animated percentage
bars after; localStorage guard hides the buttons once voted; live updates via socket.

**Admin.** Polls are seeded/edited via SQL (documented); `is_active` selects the one
shown. Exactly one active poll at a time.

**Verify.** Vote once → bars update live across two tabs; second vote from same
identity is rejected.

---

## #46 — Live song trends in search results

**API.** `GET /trends?videoIds=a,b,c` → `{ [videoId]: { pct, dir } }` where `dir ∈
{up,down,flat}`. Momentum per video = (plays+votes in last 7d) vs (previous 7d); pct =
signed percentage change; flat within a small deadband. Only cached videos have data;
unknown ids return `dir:'flat', pct:0`.

**Frontend.** After search results render, `SearchPanel` batch-requests trends for the
visible video ids and shows a coloured arrow + % per row (green up / red down / grey
flat).

**Verify.** A song with more plays in the last 7 days than the prior 7 shows a green
up arrow with a positive %.

---

## #50 — "Polar Moment" rank-gap stat

**Leaderboard.** Score = total votes given by a user (aggregated from `votes` joined
to `users`). `GET /stats/polar-moment` (auth) returns
`{ rank, myScore, above: { name, score } | null, gap, suggestion }` where `above` is
the user one rank higher, `gap = above.score - myScore`, and `suggestion` is a short
computed hint (e.g. "Vote in ~N more rounds to pass <name>").

**Frontend.** A "Polar Moment" stat card on the profile/stats page showing rank, the
competitor above, the gap, and the suggestion.

**Verify.** For a mid-leaderboard user the card shows the correct next-higher
competitor and gap; the top user shows a "you're #1" state.

_(Note: this leaderboard aggregation also effectively satisfies open issue #42
"ranking of people with most given votes", which remains open and out of this batch.)_

---

## Build order

1. Shared migrations + `services/genres.js` fixed list.
2. #45 bug fix (isolated, fast).
3. Genre classifier + `youtube_video_cache.genre` tagging (#39, #43 data).
4. #24 roles (permissions helper + endpoint + UI).
5. #27 regenerate.
6. #44 polls.
7. #46 trends.
8. #18 emoji reactions.
9. #50 Polar Moment.

## Testing summary

- Unit (test/run.js): trend momentum math, polar-moment gap/suggestion, majority
  threshold, genre-response parsing, poll percentage math, `isHostOrCoHost`.
- Manual/integration (deploy env): each feature's Verify block above.
- Each GitHub issue is closed only after its Verify steps pass in the deploy env; code
  landing in the repo is "ready for verification", not auto-closed.
