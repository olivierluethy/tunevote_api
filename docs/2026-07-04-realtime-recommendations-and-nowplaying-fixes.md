# TuneVote — Realtime, Recommendations & Now-Playing Fixes (2026-07-04)

**What this document is:** a complete, plain-language record of a block of work done
on TuneVote on **2026-07-04**, immediately *after* the
[July 2026 Engineering Journal](./2026-07-ENGINEERING-JOURNAL.md). It spans **both
repos** — `tunevote_api` (backend) and `tunevote_frontend` (frontend) — and every item
here was shipped to production (`api.tunevote.com` / `app.tunevote.com`) and, unless
noted, verified live.

**How to use this document:**
- **"Is this bug already fixed?"** → go to [§2 Fixed-bugs registry](#2-fixed-bugs-registry).
  Every entry has the *symptom*, the *root cause*, the *fix*, the *files*, the *commit(s)*,
  and a *verification status*. If the bug you're chasing is listed ✅ **Fixed**, read the
  fix first — don't re-investigate from scratch. If it's ⚠️ **Unconfirmed**, the code is
  shipped but not yet proven at runtime; see the note before re-opening it.
- **New to the team?** → read [§1 TL;DR](#1-tldr), then skim the registry, then
  [§4 Deploy runbook](#4-deploy-runbook) so you can ship safely.
- **Planning more work?** → [§3 Open items & known limitations](#3-open-items--known-limitations)
  is the live backlog.
- **Start at the [documentation index (`docs/README.md`)](./README.md)** for the full map
  of all docs and the "is this bug already fixed?" workflow.
- **Two documents, one story.** This is **Part 2**. The earlier
  [Engineering Journal (Part 1)](./2026-07-ENGINEERING-JOURNAL.md) covers the persistent
  player, the backend modularization and the playback/DB reliability refactor. *This*
  document is the next installment (realtime presence, session rename, AI recommendations
  quality, now-playing/waveform, and the mini-player redesign).

**Design principles this work followed (unchanged from the journal):** one source of
truth per fact; the **server is authoritative**; presence and counts are **derived, not
stored counters**; the system **self-heals**; realtime updates go over the socket layer,
never slow polling.

---

## 1. TL;DR

Ten issues were investigated to root cause and fixed/shipped. In the order they were tackled:

1. **Live viewer count (Twitch-style).** The participant number on session cards was
   stale and only drifted upward. It was already *derived* from presence in the DB, but
   the **decrement was never broadcast**, so the dashboard never went down. Fixed +
   redesigned as a pulsing "N live" badge.
2. **Stale-cookie → guest downgrade (auth).** A leftover/expired login token silently
   turned a returning user into a guest and got clobbered. Now an invalid token is
   cleanly cleared and the user is sent to log in, never downgraded to guest.
3. **New session couldn't be deleted until reload.** `POST /sessions` didn't return
   `hostId`, so the "host actions" (delete) never appeared on the freshly-created card.
   Now the create response matches the list row shape.
4. **AI song suggestions were repetitive.** Same handful of songs every time. Upgraded
   the model, added a full session-wide exclusion list, a taste seed, and a rotating
   exploration angle. Suggestions are now genuinely diverse.
5. **YouTube mapping returned too few / duplicate videos.** AI titles → real YouTube
   IDs dropped songs and could collapse two suggestions onto one clip. Added video-level
   dedup, a bigger candidate pool, a relaxed match, and a **quota guard**.
6. **Session rename took ~30 s to appear for others.** Rename didn't emit a realtime
   event — and, more deeply, the dashboard's socket was being **disconnected on connect**,
   so it received no global broadcasts at all. Both fixed; renames now propagate in ~1 s.
7. **"Unknown"/placeholder flash on song change.** `playback_sync` sent only the video
   id, so the client had to resolve the title over the network → a placeholder flashed.
   The server now sends the title with the event. (Shipped; runtime capture still pending.)
8. **Songs out of sync between listeners (some ahead, some behind).** The position was
   computed from *each device's own clock*, so clock skew put everyone at a different
   spot. Now the server sends its time; the client corrects for its clock offset (P1) and
   uses a millisecond-precise start reference (P2), plus buffering compensation (P3).
9. **Now-playing waveform.** The hard-coded "sound bars" became a SoundCloud-style
   waveform — deterministic shape per song, real progress. (A real audio waveform is
   impossible with YouTube's cross-origin iframe — see §2.9 so nobody re-attempts it.)
10. **Never-ending playback + UI batch.** A session no longer goes silent while someone
    is present: the server (reconciler) auto-fills AI songs into the open voting round and
    the existing advance keeps playing (presence-gated, idempotent, cost-bounded). Plus:
    the waveform is now prominent + in the mini-player, the bottom white void is fixed at
    the root, and AI suggestions are tagged + votable in the mini-player queue.

A recurring, important discovery in item 6: **the dashboard socket was silently dead.**
That single server-side bug also explains why item 1's live count never actually updated
on the dashboard until item 6 landed. See [§2.6](#26-session-rename-slow--dashboard-socket-was-dead).

---

## 2. Fixed-bugs registry

> Legend: ✅ Fixed & verified · ⚠️ Shipped, runtime-unconfirmed · 🧱 Structural limitation deferred

### 2.1 Live viewer count was stale / only grew — ✅ Fixed
- **Symptom:** the participant count next to the person icon on "LIVE NOW" / "OTHER
  SESSIONS" cards was static, kept counting people who had left, and only ever went up.
- **Root cause:** the count is **presence-derived** (`COUNT(*) FROM session_participants
  WHERE is_live = 1`) and the reconciler already reaps stale heartbeats — so the DB
  self-heals correctly. But the realtime **decrement never reached the browser**: the
  reaper (`services/scheduler.js`) and the socket `disconnect` handler flipped
  `is_live = 0` *silently*; only the explicit `join-live` / `leave-live` REST routes
  emitted `participant_count_update`. So an uncleanly-gone user (crash, tab close, lost
  connection) stayed on the displayed number until an unrelated refetch.
- **Fix (backend):** added `broadcastParticipantCount(sessionId)` in
  `services/playback.js` (recomputes the presence count and emits
  `participant_count_update`), and called it on **every** presence transition — the
  reaper (per reaped session), the socket disconnect, and join/leave (refactored to reuse
  the helper).
- **Fix (frontend):** new `components/LiveViewerCount.jsx` — Tailwind-only, dark-mode:
  a pulsing green "alive" dot + person icon + abbreviated count (`1.2K` / `12K` / `1.2M`).
  Used on the dashboard cards (`pages/Dashboard.jsx`) and in the session header
  (`components/session/SessionHeader.jsx`).
- **Important:** this only became visible on the *dashboard* after [§2.6](#26-session-rename-slow--dashboard-socket-was-dead)
  fixed the dead dashboard socket. Inside a session it worked already (that socket carries
  a `sessionId`).
- **Commits:** backend `e4f90f5`; frontend `ae4664d` (+ team's `7074c3e` reading
  `status` instead of `is_live`).

### 2.2 Stale login cookie silently downgraded a user to guest — ✅ Fixed
- **Symptom:** with a leftover login cookie present (but not freshly logged in), opening
  a session logged you in **as a guest**, and the old login was invalidated.
- **Root cause:** an expired `token` in `localStorage` was treated as "logged in"
  everywhere (`isLoggedIn = !!token`, and `getAuthHeaders` always prefers the Bearer
  token over `guestToken`). Entering a session with a stale token 401'd; `SessionPage`
  responded by opening the **guest modal** (unlike the dashboard, which clears the token
  and redirects to login). Joining as guest then stored a `guestToken` but never removed
  the dead `token`, which kept **shadowing** the guest identity → endless 401s.
- **Fix (frontend):** new `src/utils/auth.js` with `resolveAuthFailure({hadToken, status})`
  (returns `clear-and-login` when a token was present, `guest` when genuinely anonymous)
  and `clearUserAuth()`. `SessionPage`'s 401/403 handler now clears a stale token and
  redirects to `/login` (matching the dashboard); the guest modal only shows for tokenless
  visitors. `handleGuestJoin` also purges any leftover user token (defense in depth). Unit
  test: `src/utils/auth.test.mjs` (run: `node src/utils/auth.test.mjs`; no test runner is
  wired into CI).
- **Commits:** frontend `ceaab60` (merged via PR #3 → `93f10da`).

### 2.3 New session not deletable until page reload — ✅ Fixed
- **Symptom:** create a session, immediately try to delete it → nothing happens until the
  page is reloaded.
- **Root cause:** the delete/host actions are gated on `isHost = Number(userId) === s.hostId`.
  `POST /sessions` returned only `id/title/is_private/created_at/host` — **no `hostId`** —
  and the client inserts that response optimistically (`setSessions([res.data, ...])`), so
  the fresh card had `hostId = undefined`, `isHost = false`. `GET /sessions` aliases
  `s.user_id AS hostId`, which is why a reload "fixed" it.
- **Fix (backend):** `POST /sessions` now returns the **same row shape as `GET /sessions`**
  (`hostId`, `host`, `is_live`, `status`, `is_private`, `participant_count`), so the
  optimistically-inserted card is complete — deletable immediately, with its viewer count
  and status.
- **Commit:** backend `be9e183`.

### 2.4 AI song suggestions were repetitive — ✅ Fixed
- **Symptom:** the recommender proposed the same handful of songs over and over.
- **Root cause (four compounding issues in `routes/proposals.js`):**
  1. the prompt **hard-coded example songs** (Dua Lipa / Beyoncé / Khalid) that the model
     anchored on and repeated;
  2. it only excluded the **current queue** (`queued`/`playing`), so already-played and
     earlier-round songs came back;
  3. **no taste/genre context** → it fell back to generic global top-40;
  4. **`gpt-3.5-turbo`, temp 0.7, no penalties, no per-call variation** → same input,
     same output.
- **Fix (backend):**
  - model is now **env-configurable** (`OPENAI_MODEL`), default **`gpt-4o-mini`**
    (`services/openai.js` exports `CHAT_MODEL`);
  - **comprehensive exclusion list**: every title the session has ever touched, across all
    rounds and statuses (capped at 200, newest first);
  - **taste seed** from human-added songs (`item_source IN ('user','guest')`) steers
    recommendations toward the room's actual vibe;
  - a **rotating random "exploration angle"** per call (genre/era/region) so identical DB
    state still yields variety;
  - example songs replaced with placeholder formats (anti-anchoring);
  - `presence_penalty` / `frequency_penalty` + higher temperature.
- **Verified live:** logs showed diverse, on-angle picks (e.g. Tom Misch, Hiatus Kaiyote,
  D'Angelo for a soul/funk angle) and the angle rotating across calls.
- **Commit:** backend `b1a276c`.

### 2.5 YouTube mapping returned too few / duplicate videos — ✅ Fixed (+ 🧱 quota limit)
- **Symptom:** the AI title → YouTube video step often returned fewer than the 3 needed
  suggestions, and could map two distinct AI titles onto the **same** clip.
- **Root cause (`routes/proposals.js` mapping loop):**
  - **no video-level dedup** — two suggestions could best-match the same cached video, and
    a suggestion could map onto a video already in the session;
  - the **hard 80 Levenshtein threshold** + aggressive title normalization dropped songs
    that didn't match cleanly — disproportionately the obscure/international tracks the new
    diversity angles request;
  - only `needed` candidates were requested, so one unmappable title meant a short result;
  - the whole cache was re-queried **inside** the per-suggestion loop.
- **Fix (backend):** preload the cache once + the set of `video_id`s already used in this
  session; never map onto an already-used or already-chosen video (dedup by `youtubeId`);
  request a **candidate pool** (`needed + 5`) and stop once `needed` map; relax the search
  match to **70** and accept a lower ratio when the artist name is clearly present in the
  YouTube title (rescues international/deep-cut matches).
- **Follow-up quota guard:** the `needed + 5` pool meant up to ~8 YouTube **search** calls
  per recommendation (each ~100 quota units), which the diversity angles (obscure = cache
  miss = search) can exhaust fast (observed **403 quota** errors). Added a per-call
  **search budget** (`needed + 1`): cache hits are free and unlimited; only cache-miss
  suggestions consume the budget.
- **Commits:** backend `fa4bd82` (mapping), `5088dd4` (quota guard).
- **See also:** [§3](#3-open-items--known-limitations) — the YouTube Data API daily quota
  is a **structural bottleneck** for this feature. Not solved; options deferred by product.

### 2.6 Session rename slow (~30 s) + dashboard socket was dead — ✅ Fixed
- **Symptom:** when the host renames a session, other users see the new name only after a
  long delay (~30 s).
- **Root cause (two layers):**
  1. the rename endpoint (`PATCH /sessions/:id`) only wrote the DB and returned — **no
     realtime event** — so others learned the new name on their next poll.
  2. **The deeper bug:** `socket.js` disconnected **any socket without a `sessionId`**
     immediately. The dashboard connects a socket *without* a `sessionId` (it's a global
     listener), so it was killed on connect and received **no global broadcasts at all**.
     This is *also* why [§2.1](#21-live-viewer-count-was-stale--only-grew----fixed)'s live
     count never updated on the dashboard.
- **Fix (backend):** `socket.js` now treats session-less connections as **global
  listeners** — kept connected (no room, no presence) instead of disconnected;
  `PATCH /sessions/:id` emits `session_renamed { sessionId, title }`.
- **Fix (frontend):** `pages/Dashboard.jsx` and `components/session/SessionHeader.jsx`
  listen for `session_renamed` and update the title in place.
- **Verified end-to-end:** a session-less socket now stays connected **and** received a
  real `session_renamed` on a live rename (test exit 0; original title restored).
- **Commits:** backend `e120470`; frontend `83be256`.

### 2.7 "Unknown"/placeholder flash on song change — ⚠️ Shipped, runtime-unconfirmed
- **Symptom:** on a song change the new title often showed a placeholder ("Unknown" /
  "Loading…") and didn't display cleanly.
- **Root cause:** the `playback_sync` event carried only the video id, so the client had
  to resolve the title afterwards (metadata cache → `/youtube-info`). Until that
  round-trip returned, the now-playing UI showed a placeholder — worst for songs added
  *after* the client seeded its cache. **Empirically confirmed it is *not* a data
  problem:** the prod cache has 0 rows with an empty/"Unknown" title and 0 music queue
  items without a cached title (of ~99,000 rows).
- **Fix (backend):** the server already has the resolved title at every emit point; it now
  includes it as `current_title` in all three `playback_sync` payloads
  (`services/playback.js` song-advance + pause, `routes/sessions.js` session-start).
- **Fix (frontend):** `context/PlaybackContext.jsx` `syncPlayback` reads `current_title`
  and shows it immediately, caching it for the mini-player / MediaSession.
- **Why "Unconfirmed":** the exact deployed code emits `current_title` and the frontend
  bundle reads it, but I could **not capture a real `playback_sync` at runtime** (no
  session currently has a playing + queued item, and a synthetic forced advance didn't
  deliver to the out-of-band test socket). Also, the in-app placeholder in code is
  "Loading…", not literally "Unknown" — so if the literal word "Unknown" persists it may
  come from a **different surface** (OS lock-screen/MediaSession, or a stale PWA bundle).
  **To confirm:** watch a real song change after a hard refresh (see PWA-cache note in §3),
  or tell the team exactly *where* "Unknown" appears (app card / mini-player / lock screen)
  with a screenshot.
- **Commits:** backend `d5eb174`; frontend `c618703`.

### 2.8 Songs out of sync between participants (some ahead, some behind) — ✅ Fixed (P1+P2); ⚠️ runtime-unconfirmed with 2 devices
- **Symptom:** when several people are in the same live session, the song is at
  different positions on different devices — some far ahead, some noticeably
  delayed — and it varies per device/session.
- **Root cause (empirically narrowed):** every client computed the playback
  position as `elapsed = (Date.now()[device] − video_start_time[server]) / 1000`
  in all four sync paths (join, 10s drift poll, resume, tab-visibility). The only
  per-device variable is the device's own `Date.now()`, so a device whose local
  clock is off by N seconds plays N seconds ahead/behind everyone else. The
  server side was checked and is **not** at fault: Node and MySQL are both UTC and
  agree to <1s (verified on prod), so there is no timezone/server-clock bug. A
  secondary, smaller issue: the socket events sent the exact `Date.now()` (ms)
  while `GET /playback-sync` derived the start from `startedAt` (second-resolution
  DATETIME) → the two references disagreed by up to ~1s, so a client jumped on
  each drift poll.
- **Fix P1 — clock-offset correction (the big one):** the server now sends
  `server_time` (its `Date.now()`) in every sync payload (3 `playback_sync` socket
  emits, `session_started`, and `GET /playback-sync`). The client estimates its
  offset to the server clock — RTT-compensated on the timed GETs, one-way from
  pushed events — and computes position as `serverNow() − video_start_time`. Every
  device converges to the server clock regardless of its local clock.
- **Fix P2 — millisecond-precise, consistent reference:** added
  `queue_items.started_at_ms` (BIGINT), written with the exact ms start value at
  every song start; `GET /playback-sync` returns
  `COALESCE(started_at_ms, UNIX_TIMESTAMP(startedAt)*1000)`, so the GET and socket
  paths now return an identical ms-precise start time (no more ~1s poll jitter).
- **Verified:** on prod, `GET /playback-sync` returns `server_time` and a
  ms-precise `video_start_time` matching `started_at_ms` (not the truncated
  second). **Not yet confirmed** with two devices that have differing clocks in a
  live playing session (couldn't fabricate headlessly) — confirm by having two
  people watch one session (hard-refresh first for the PWA cache).
- **Files:** backend `services/playback.js`, `routes/sessions.js` (+ `init.sql`,
  migration `20260705000001_queue_items_started_at_ms`, `scripts/2026-07-05-…`);
  frontend `context/PlaybackContext.jsx` (`syncClock`/`serverNow`).
- **Commits:** backend `cea3ff7` (P1), `227b44f` (P2); frontend `76385d3` (P1).
- **P3 done (frontend `9a6d797`):** buffering compensation — a one-shot seek ~2.5s
  after each song change once the player has buffered (seek only, no player rebuild)
  — and a tighter drift poll (10s→5s, tolerance 2s→1.5s). **Deliberately NOT done:**
  a server-side periodic `playback_sync` tick, because that event's client handler
  rebuilds the YouTube player (`createPlayer`), so periodic emits would interrupt
  audio every few seconds. **Still open (optional):** fold the current playback state
  into the `join-live` response to remove the join round-trip/race (low impact — the
  socket is already in the room by then).

### 2.9 Now-playing waveform visualizer — ✅ Shipped (deterministic shape + real progress)
- **Goal:** replace the hard-coded decorative "sound bars" with a waveform that
  reflects the song.
- **Key finding — a REAL audio waveform is infeasible with YouTube playback (do not
  re-attempt without changing the audio source):**
  - Audio plays in a **cross-origin YouTube iframe**, so the browser **cannot** tap it
    with the Web Audio API (`AnalyserNode`) — no live FFT of the real sound is possible.
  - `wavesurfer.js` needs the audio samples/file, which YouTube doesn't provide.
  - **Server-side extraction was tested on prod and is blocked:** `@distube/ytdl-core`
    4.16.12 can't decipher current YouTube stream URLs ("Could not parse decipher
    function") and the audio download returns **403** (datacenter-IP bot-check); there's
    **no `ffmpeg`/`audiowaveform`** installed. A `yt-dlp`+`ffmpeg` pipeline might work but
    risks continued 403s, violates YouTube ToS, and loads the 2 GB box. Product chose not
    to go there.
- **What shipped (the honest "good fake"):** `components/session/SongWaveform.jsx` — a
  SoundCloud-style bar waveform whose **shape is deterministic per song** (seeded PRNG
  from the video id → stable, distinct per track, never random-flickers) and whose
  **progress is real**, driven by the clock-offset-corrected `getPlaybackProgress()`.
  Played bars light emerald; the playhead glows while playing, calms when paused. Shown
  in the Now-Playing card (`NowPlayingCard`, wired from `SessionPage`). It is NOT the
  real audio and is labelled as such.
- **Commit:** frontend `893f2d6`. (A teammate separately added a mini-player live
  progress bar, `7960331`.)

### 2.10 Never-ending playback + prominent/mini-player waveform + AI-tagged queue + dark bg — ✅ Shipped (auto-fill mechanism verified; song insertion gated by YouTube quota)
- **Goals:** (a) waveform bigger in the now-playing card and also in the mini-player;
  (b) no white void at the page bottom; (c) a session should never go silent while
  someone is present — auto-fill AI songs and keep playing; (d) AI suggestions
  visible + votable + tagged in the mini-player queue.
- **(a) Waveform** — `SongWaveform` got a configurable `heightClass`; larger in
  `NowPlayingCard`, and it replaced the mini-player's linear progress bar. Frontend
  `3acda53`.
- **(b) White void** — root cause: no dark background on the document root. Fixed in
  `index.css` (`@layer base`): `html/body/#root` are `bg-slate-950` + `min-h-screen`
  so the dark fills the whole viewport and overscroll; dashboard bottom padding
  bumped so the last card clears the taller mini-player. Frontend `3acda53`.
- **(d) AI queue UI** — `QueueOverlay` already showed votable `suggested` proposals;
  added a sparkle **"AI" badge** for `item_source==='ai'`, and the mini-player queue
  dot now reflects any votable suggestions. Frontend `3acda53`.
- **(c) Never-ending playback (the big one) — server-authoritative, additive:**
  - **Most of the machinery already existed:** `advanceToNext` is idempotent
    (`FOR UPDATE` + compare-and-swap) with an emergency-promote path (highest-voted →
    user/guest → **random AI**); a voting round is (almost) always open; presence
    (`is_live`/`last_seen` + reaper) already counts mini-player-only users.
  - **The one gap:** nothing generated AI suggestions server-side when the round ran
    dry (it was client-triggered only). New `services/recommendations.js` extracts
    `generateAiSuggestions(sessionId, roundId, count)` (the GET endpoint keeps its own
    copy for now — consolidation is a follow-up). The reconciler gains a phase 4:
    for a **live session with is_live participants present** whose queue has run dry
    (nothing queued AND the open round has no suggestions), it generates AI into the
    **already-open** round as votable `suggested`/`ai` items, off the tick
    (non-blocking), single-flight, with a **cooldown+back-off** (30s after a real
    fill, 5min after an empty/error result — so a quota-blocked generation can't loop
    OpenAI). It never creates rounds or touches the phase-timer state machine (avoids
    double-round races), and never calls `advanceToNext(null)` directly (which could
    race the phase-1 advance and skip a song) — instead it nudges `current_plays_until`
    (guarded to sessions with nothing playing) so the single serialized phase-1 advance
    promotes one. Presence-gated ⇒ empty sessions are ended by phase 3, never
    auto-filled (no zombies / no spend). Kill switch: `AUTOFILL_DISABLED=true`. Backend
    `02cc84e` + `86c6704`.
  - **Verified on prod:** auto-fill fires for a dry+present session (OpenAI log),
    and injecting AI suggestions + the nudge promotes one to `playing` (revive+play
    end-to-end). ⚠️ **Real song insertion depends on the YouTube Data API quota** —
    OpenAI returns titles but the title→video mapping (search) is quota-limited and
    often `403`s, so generation can yield 0 songs (see §3). When songs map (cache hits
    / fresh quota) it fills and plays; when quota is out, the cooldown prevents a spend
    loop but no new songs appear.
  - **Known edge (documented, not a bug):** after an emergency-promote closes a round,
    there's a brief window with no open round until the phase timer creates the next
    one (~≤150s); auto-fill only fills existing open rounds (safe), so a very short song
    ending in that window can briefly idle. Robust gap-free coverage would need
    hardening the voting-round timer state machine (a larger, riskier change).
- **Commits:** backend `02cc84e`, `86c6704`; frontend `3acda53`.

### 2.11 Mini-player visual redesign — premium glassmorphism + motion — ✅ Shipped
- **Goal:** the persistent bottom banner looked flat and generic. Make it feel
  premium and *alive* (tasteful motion) and fully responsive on phone — **visual
  only**, with 100% of the existing controls/behaviour and the `usePlayback()`
  data contract unchanged.
- **What shipped** (`components/MiniPlayer.jsx`, `tailwind.config.js`):
  - **Frosted-glass floating pill** — layered `slate-900→950` gradient,
    `backdrop-blur`, state-coloured border, top sheen, and a **breathing ambient
    glow** behind it that reacts to state (emerald = playing, amber = on a break,
    dim = idle/waiting).
  - **Live equalizer bars** over the album art while actively playing (calm when
    paused/idle); **play/pause icon morph**; hover-glow + press-scale on every
    control; **vote-count pop**; **Up-Next cross-fade** on track change; spring
    slide-up entrance/exit.
  - New Tailwind keyframes `equalize`, `shimmer`, `ambient-glow`.
  - **Fully responsive:** Up-Next details collapse below `md` (access via the
    Queue button, whose dot signals votable suggestions), thumb-sized controls,
    graceful truncation; checked at ~375 px / 768 px / desktop.
  - **Accessibility:** every animation gated by `prefers-reduced-motion`
    (framer presets collapse to opacity; CSS animations use `motion-reduce:`).
- **Note on the progress bar:** the same pass first added a *linear* live progress
  bar (`getPlaybackProgress()`, server-authoritative, read-only — commit `7960331`);
  it was then **replaced by the deterministic waveform** in the mini-player (see
  §2.10). `getPlaybackProgress()` remains and now drives the waveform's real progress.
- **Deploy footnote:** this was the deploy that surfaced the **zombie `vite build`
  overwriting `dist` with the pre-pull bundle** (symptom: hash changed but UI didn't).
  Root-caused and fixed by **building locally and shipping `dist`** — now the
  recommended path in [§4](#4-deploy-runbook).
- **Commit:** frontend `7e8002d` (redesign) + `7960331` (progress getter).

---

## 3. Open items & known limitations

- **🧱 YouTube Data API quota (from §2.5).** The free quota (~10,000 units/day ≈ 100
  searches) is a real ceiling — diversity pushes obscure songs that miss the cache and
  require a search (100 units each). During this session's testing it hit **403 (quota
  exceeded)**, which makes AI suggestions return 0 mapped songs until the daily reset
  (~midnight Pacific). The `needed + 1` search budget slows the burn; the growing cache
  reduces searches over time. **Deferred options** (product decided not yet): request a
  quota increase in Google Cloud, or hold **multiple API keys and rotate** to the next
  unused one when one hits its limit.
- **⚠️ Now-playing fix runtime confirmation (from §2.7).** Shipped but not observed on a
  real song change. Confirm on the next naturally-active session.
- **PWA cache caveat (affects how you *test* any frontend change).** The app is a PWA with
  a service worker (`vite-plugin-pwa`, `generateSW`). After a deploy, returning devices may
  serve the **old bundle** until the service worker updates (often needs a reload or two).
  When verifying a frontend fix, **hard-refresh / clear cache** first, or you may be looking
  at stale code.
- **🔐 Secrets to rotate.** Two secrets were exposed in plaintext during this work and
  should be rotated when convenient: the `salade` SSH password, and the GitHub PAT
  (`ghp_…`) embedded in both prod repos' `.git/config` remote URLs and the local remotes.
- **No frontend test runner.** `src/utils/auth.test.mjs` runs only via `node`, not in CI.
  Wiring in Vitest (or a `"test": "node src/utils/auth.test.mjs"` script) is a small
  follow-up.

---

## 4. Deploy runbook

Verified facts about the production environment (corrects some older notes):

- **Server / access:** SSH `salade@72.167.49.141`, **password auth only** (no usable key);
  `salade` has **sudo**. Both app repos and the app process are **root-owned**, so all
  deploy steps run under `sudo` (git as root avoids the "dubious ownership" block).
- **Backend:** `/var/www/tunevote_api` (root:root). Remote `olivierluethy/tunevote_api`.
  App runs under **root's PM2** (`/root/.pm2`), process name **`tunevote_api`**.
  Deploy: `git merge --ff-only origin/main && npm install && pm2 restart tunevote_api`.
  Boot health: logs show `⏱️ Reconciler started`, `✅ MySQL connected`, `Server läuft…`;
  `pm2 describe tunevote_api` → `unstable restarts: 0`.
- **Frontend:** `/var/www/TuneVote` (root:root). Remote `olivierluethy/tunevote_frontend`.
  **nginx docroot is `/var/www/TuneVote/dist`** (per `/etc/nginx/sites-available/app.tunevote.com`,
  SPA fallback `try_files … /index.html`) — **not** `/var/www/html`. Build command is
  `vite build`. **Prod keeps an uncommitted local edit** in `package.json` pinning
  `vite-plugin-pwa` to `^0.19.8` (the committed `^1.1.0` doesn't build on prod's node v20)
  — **preserve it**; a fast-forward pull leaves it intact, and **skip `npm install`** unless
  a change adds deps. Zero-downtime build+swap:
  `./node_modules/.bin/vite build --outDir dist_new --emptyOutDir` then
  `mv dist dist_prev && mv dist_new dist`. No nginx reload needed for a static swap.
- **⚠️ The prod box (2 GB RAM, no swap) OOM-kills the vite build** now that the
  frontend has grown — observed 2026-07-05, even with a temporary 2 GB swapfile the
  build was `Killed`. **Reliable workaround: build the frontend LOCALLY and upload
  the `dist`.** Local build → `tar czf - -C dist . | ssh … 'cat > /tmp/d.tgz'` →
  on prod `sudo`: extract into `dist_new` (`tar xzf … --no-same-owner`), then
  `mv dist dist_prev && mv dist_new dist && chown -R root:root dist`. The output is
  equivalent (URLs are hard-coded, not env-baked; the `vite-plugin-pwa` version only
  affects build-time, not runtime). **2026-07-05: a permanent 2 GB swapfile was added**
  to the box (`/swapfile`, in `/etc/fstab`, `vm.swappiness=10`) as general OOM
  resilience for the app/DB — but **local-build-and-ship stays the recommended deploy
  path** because prod SSH is flaky on long commands and an interrupted `vite build`
  leaves a zombie that can overwrite `dist` with the pre-pull bundle. Beware that
  `setsid`+SSH race: `sudo pkill -9 -f 'vite build'` before retrying, and verify the
  served JS actually contains a symbol you just added (`grep -rl … dist/assets/`).
- **Database:** MySQL is **local on the app server** (container), reachable as the app's
  `user`. It has full privileges on `tunevote.*`.
- **Public health checks:** `curl https://app.tunevote.com/` → 200;
  `curl https://api.tunevote.com/sessions` → 401 (correct unauthenticated response).

---

## 5. How this work was verified (for reproducibility)

- **Backend:** `node --check` on every edited file, plus a module `require()` to catch
  import errors, before every commit.
- **Frontend:** `npm run build` (must compile) + `eslint` on changed files; pre-existing
  lint noise was distinguished from newly-introduced errors.
- **Realtime, end-to-end:** a `socket.io-client` connected to prod from a Node script was
  used to prove (a) the dashboard's session-less socket stays connected after §2.6, and
  (b) a real `session_renamed` event is received on a live rename.
- **Data-level claims** (e.g. "no 'Unknown' titles exist") were checked by querying the
  **prod database directly** via the app's own `db` pool, not assumed.
- **Recommendations:** exercised the real endpoint on a test session and read the prod
  logs to confirm the model, the rotating angle, and the actual songs returned.

---

## 6. Commit reference

**Backend — `tunevote_api` (all on `main`, deployed):**

| Commit | Summary |
|---|---|
| `e4f90f5` | broadcast live participant count on reap & disconnect (§2.1) |
| `be9e183` | `POST /sessions` returns full list row shape (§2.3) |
| `b1a276c` | diversify AI song suggestions (§2.4) |
| `fa4bd82` | YouTube mapping: fill `needed`, avoid duplicate videos (§2.5) |
| `5088dd4` | cap live YouTube searches per call — quota guard (§2.5) |
| `e120470` | live session rename + keep dashboard socket connected (§2.6) |
| `d5eb174` | send song title with `playback_sync` (§2.7) |
| `02cc84e` | server-authoritative AI auto-fill (never-ending playback) (§2.10) |
| `86c6704` | auto-fill cooldown + back-off (prevent OpenAI spend loop) (§2.10) |
| `cea3ff7` | send `server_time` for client clock-offset correction (§2.8, P1) |
| `227b44f` | millisecond-precise, consistent song start reference (§2.8, P2) |

**Frontend — `tunevote_frontend` (all on `main`, deployed):**

| Commit | Summary |
|---|---|
| `ae4664d` | Twitch-style live viewer count on session cards (§2.1) |
| `7074c3e` | read session `status` instead of `is_live` (team; supports §2.1) |
| `ceaab60` | don't downgrade a returning user to guest on a stale token (§2.2) — via PR #3 `93f10da` |
| `83be256` | reflect session rename in real time (§2.6) |
| `c618703` | use server-sent title on song change (§2.7) |
| `76385d3` | correct playback position for device clock skew (§2.8, P1) |
| `9a6d797` | faster sync convergence — buffering comp + tighter poll (§2.8, P3) |
| `893f2d6` | now-playing waveform visualizer (deterministic shape + real progress) (§2.9) |
| `3acda53` | prominent + mini-player waveform, full-height dark bg, AI-tagged queue (§2.10) |
| `7e8002d` | mini-player glassmorphism redesign with live animations (§2.11) |
| `7960331` | mini-player live song progress getter/bar (§2.11; superseded by §2.10 waveform) |

---

## 7. Key files touched (where to look next time)

**Backend**
- `services/playback.js` — `broadcastParticipantCount`, `broadcastLiveParticipants`,
  `advanceToNext` (emits `playback_sync` with `current_title`).
- `services/scheduler.js` — reconciler: reaps stale heartbeats and broadcasts the new count.
- `socket.js` — connection handler; session-less = global listener; heartbeat & disconnect.
- `routes/sessions.js` — `GET/POST/PATCH /sessions`, `join-live`/`leave-live`, session start.
- `routes/proposals.js` — AI recommendations endpoint (prompt, exclusion, taste, mapping).
- `routes/youtube.js` — `/youtube-info/:id`, `/youtube-cache`.
- `services/openai.js` — OpenAI client + `CHAT_MODEL` (env `OPENAI_MODEL`).

**Frontend**
- `context/PlaybackContext.jsx` — global playback, `syncPlayback`, metadata resolution.
- `components/LiveViewerCount.jsx` — the Twitch-style badge.
- `components/MiniPlayer.jsx`, `components/session/NowPlayingCard.jsx`,
  `components/session/SessionHeader.jsx` — now-playing / header surfaces.
- `pages/Dashboard.jsx` — sessions overview, dashboard socket listeners.
- `components/SessionPage.jsx` — session detail, socket handlers, auth-failure handling.
- `utils/auth.js` (+ `utils/auth.test.mjs`) — auth-failure decision.

---

*Written 2026-07-04. If you fix or re-open any item here, update its status in
[§2](#2-fixed-bugs-registry) so the registry stays trustworthy.*
