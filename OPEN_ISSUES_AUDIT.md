# TuneVote API — Issue Audit (2026-08-12)

Every open and closed GitHub issue in `olivierluethy/tunevote_api` was cross-checked against the actual API (`tunevote_api`) and frontend (`tunevote_frontend`) code. This file lists the **issues that are NOT fully complete** and therefore remain **open**.

## Summary of actions taken

| Action | Issues |
|--------|--------|
| **Closed** (were open, verified fully done) | #20, #21, #23, #49 |
| **Reopened** (were closed, not actually done) | #7 |
| Confirmed correctly closed (genuinely done) | #1, #2, #3, #4, #5, #6, #8, #9, #10, #11, #12, #14, #15, #16, #19, #28, #29, #30, #31, #32, #35, #36, #37, #40, #41, #47, #48, #52 |

**Result: 18 open, 32 closed.**

A ⭐ marks ideas worth preserving (valuable feature ideas not yet built) so none get lost.

---

## Still open — not yet complete (18 issues)

### 🟡 Partially done (core built, pieces missing)

#### #7 — Private/public sessions → paid private sessions ⭐ *(reopened)*
- **Done:** public vs. private sessions fully work (`is_private` honored, `routes/sessions.js:206-212`).
- **Missing:** the *monetization* — paid private sessions is not wired. Only a dormant Stripe migration exists (`migrations/20260512000001_users_stripe_subscription.js`), with no Stripe/paywall usage anywhere.

#### #13 — On voting, verify remaining participants also have `is_live = 1`
- **Done:** vote endpoint validates session-live + voting-phase (`routes/proposals.js:1092-1157`).
- **Missing:** the voter's own `is_live=1` is never checked; session restart (`/start`) does not reset `session_participants.is_live=0` (only the natural-end path in `services/playback.js:199-267` does).

#### #17 — Guest adds song to an empty (Guest-started) session → autolive
- **Done:** frontend hides Start until queue is non-empty; queue/add blocked while live (`routes/sessions.js:484-489`).
- **Missing:** backend `/start` (`routes/sessions.js:579-605`) has no guard against starting with an empty queue — root cause only mitigated in the UI.

#### #22 — Always keep a background stream in the desktop browser tab ⭐
- **Done:** Media Session API + visibility-driven resync (`PlaybackContext.jsx:859-937`).
- **Missing:** the wake-lock / hidden keep-alive trick to stop desktop background-tab throttling. *(Note: the issue's own proposed snippet is flawed — a YouTube watch URL can't be a `<video>.src` — so keep the goal, not the code.)*

#### #25 — Weekly TuneVote session summary e-mail (`/session/summary`)
- **Done:** on-demand aggregation endpoints exist (`routes/profile.js:504` listening-summary, `routes/artists.js:199` top-weekly-songs).
- **Missing:** the actual **scheduled** weekly summary email — no cron job (`services/scheduler.js` only reconciles), no summary mail is ever sent (`services/mailer.js` is transactional-only).

#### #26 — Max 5 proposals per queue, max 3 AI proposals ⭐
- **Done:** the max-3-AI cap is enforced (`routes/proposals.js:147-171`, `services/scheduler.js:180`).
- **Missing:** no 5-per-queue (or per-participant) cap on user/guest proposals; `POST /proposals` has no such limit.

#### #42 — Ranking of people with most given votes
- **Done:** all per-profile voting metrics computed (`services/userStats.js:101-289`).
- **Missing:** the headline **cross-user leaderboard** ("most given votes" / "most earned points") — no leaderboard endpoint exists.

#### #51 — "Add song" hint when a song can't be found via search
- **Done:** a persistent "Paste a YouTube link" affordance is always available (`SearchPanel.jsx:38-68`).
- **Missing:** no explicit *not-found* message on a zero-result search to point the user toward pasting a link (only an analytics event `search_no_results` fires).

### 🔵 Verified but kept open by request

#### #38 — Close session only after all songs are fully played
- **Implemented** in `services/playback.js:602-642` (`advanceToNext` ends only when no next item, no live users, no open round, nothing playing).
- Kept open because the issue body itself notes it is **fixed-but-untested** — verify live before closing.

### 🔴 Not started — valuable ideas to preserve

#### #18 — Emoji reactions on songs while a queue item is playing ⭐
No mechanism lets participants emoji-react to the currently playing song. The `shout_reactions` migration targets the social shout feed, not live songs.

#### #24 — Role management like Clash of Clans ⭐
Roles are fixed at join to `host`/`user`/`guest` (`init.sql:163`); no member/elder/co-leader hierarchy, promotion/demotion, or delegated invite/admit rights.

#### #27 — Handle generally bad AI song suggestions (e.g. vote to regenerate) ⭐
No feature anywhere to flag/vote-to-regenerate poor AI suggestions.

#### #39 — Host can choose the AI genre ⭐
Genre is only a randomly rotated internal `EXPLORATION_ANGLES` value (`services/recommendations.js:64-77`); the host cannot select a genre — no param, UI, or DB field.

#### #43 — Genre ranking over a time period ⭐
No genre data is captured or ranked; "genre" appears only inside AI prompt text. Still an open research question about how to source genres.

#### #44 — Live anonymous polls on the home page ⭐
No poll table, endpoint, or component in API or frontend.

#### #46 — Live song trends in the song search ⭐
Search result rows show only thumbnail + title + Add (`SearchPanel.jsx:86-114`); no rising-green/falling-red trend indicator. Trend charts exist only on detail pages, not in search.

#### #50 — Stats → "Polar Moment" (predictive competitor-overtake stat) ⭐
The predictive stat advising when a user should be active to overtake their next-ranked competitor does not exist.

### 🐞 Confirmed bug — still open

#### #45 — On home page → "Start a Session" → guest not correctly recognized
Confirmed. A visitor with no `guestToken` yet is sent straight to `/dashboard` (`Home.jsx:104-146`) without one being bootstrapped, so public sessions don't appear until a token is created on first join (`routes/sessions.js:73-100`, `Dashboard.jsx:135/176`).

---

## Closed this session (verified fully done)

| # | Title | Evidence |
|---|-------|----------|
| #20 | Mute persists for the whole session | `PlaybackContext.jsx:698-700, 784-799, 237-240` — mute persisted per-session in localStorage, re-applied per song |
| #21 | Research: recognized as a YouTube stream | `PlaybackContext.jsx:859-937` — Media Session API background/lock-screen playback realizes the research goal |
| #23 | Keep stream open during search | `main.jsx:57-153`, `PlaybackContext.jsx:982-994` — player at app root survives browsing/searching |
| #49 | Password change endpoint | `routes/profile.js:158-234` — authenticated change via POST /profile with current-password verification |

## Reopened this session

| # | Title | Reason |
|---|-------|--------|
| #7 | Paid private sessions | Public/private done, but the paid part was never wired (only a dormant Stripe migration) |

---

*Audit method: 6 parallel agents each read the issue text (`gh issue view`) and searched the API + frontend code for real evidence of implementation. Verdicts: DONE / PARTIAL / NOT_DONE with file:line evidence.*
