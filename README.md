<div align="center">
  <img src="assets/logo.png" alt="TuneVote" width="150" height="150" />
  <h1>TuneVote — API</h1>
  <p>
    <b>The real-time engine behind collaborative music voting.</b><br/>
    A server-authoritative backend that runs the voting rounds, keeps every listener's playback in sync, and fills quiet rooms with AI-picked songs.
  </p>
  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
    <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white">
    <img alt="Express 5" src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white">
    <img alt="MySQL 8" src="https://img.shields.io/badge/MySQL-8-4479A1?logo=mysql&logoColor=white">
    <img alt="Socket.IO" src="https://img.shields.io/badge/Socket.IO-realtime-010101?logo=socketdotio&logoColor=white">
    <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-gpt--4o--mini-412991?logo=openai&logoColor=white">
  </p>
  <p><i>The server for the <a href="https://github.com/olivierluethy/tunevote_frontend">TuneVote web client</a>.</i></p>
</div>

---

The **backend** for TuneVote, a real-time collaborative music-listening app. People join a shared listening room ("session"), suggest YouTube songs, and vote in rounds to decide what plays next — with everyone's audio kept in sync across devices.

This repository is the **server**: it owns all business logic, the database, authentication, real-time events, and the server-authoritative playback engine. The companion web client, [`tunevote_frontend`](https://github.com/olivierluethy/tunevote_frontend), is a thin UI that talks to this API over REST + WebSockets.

## What it does

- **Accounts & auth** — email/password signup and login (bcrypt-hashed), stateless **JWT** (7-day expiry) verified per request, plus **Google & Facebook OAuth** with account linking by email. Anonymous **guests** get a UUID token so they can join sessions without registering. Password reset over email.
- **Sessions & voting engine** — hosts create public or private rooms; the app runs repeating rounds of *suggestion phase (90s) → voting phase (60s) → winner*. Winners are chosen with a quorum threshold, then played. All of this is driven by per-session phase timers.
- **Server-authoritative playback** — the currently playing song and its start time are derived from the database (the `queue_items` row with `status='playing'`), and `GET /sessions/:id/playback-sync` returns the server clock so every client can correct for clock skew. A background **reconciler** loop (every 2s) advances finished songs, reaps stale participants, closes empty rooms, and is crash-safe (it rebuilds its work from the DB on boot).
- **AI auto-fill & recommendations** — when an occupied room runs dry, OpenAI generates "Artist – Title" suggestions (seeded by the room's own taste), which are matched against the YouTube cache / YouTube Data API and inserted as votable AI picks.
- **Real-time events** — Socket.IO broadcasts session start, voting-phase changes, round completion, queue/proposal updates, playback sync, live participant counts, and invite acceptances. Clients send heartbeats to maintain presence.
- **Invitations** — email invites for private sessions, with accept/reject/revoke and participant management.
- **Profiles, stats & social** — profile editing, profile images (stored as blobs in the DB), rich listening statistics (win streaks, top songs/artists, listen minutes), public user & artist pages, and a threaded artist "shouts" wall with likes. Gamification badges are seeded in the schema.

## Tech stack

- **Node.js** + **Express 5** (CommonJS), listens on **port 4000**
- **MySQL 8** — runtime queries via a raw **mysql2/promise** pool; **Knex** used only for migrations
- **Socket.IO 4** for real-time
- **jsonwebtoken** + **bcrypt** + **uuid** for auth (users and guests)
- **nodemailer** for email (Gmail transport is the active one)
- **openai** SDK (default model `gpt-4o-mini`) for recommendations/auto-fill
- **@distube/ytdl-core** + YouTube Data API v3 for video metadata & search
- **multer** for profile-image uploads
- **docker-compose** provisions MySQL 8 + phpMyAdmin for local dev (the app itself runs separately)

## Architecture at a glance

```
index.js                # app bootstrap: mounts routers, starts HTTP server + Socket.IO + scheduler
db.js                   # mysql2 connection pool (runtime queries)
knexfile.js             # Knex config — migrations only
lib/io.js               # Socket.IO singleton
socket.js               # Socket.IO handlers (join room, heartbeat, disconnect)
routes/                 # HTTP endpoints, grouped by resource
services/
  auth.js               # resolve user/guest from token
  playback.js           # voting rounds, phase timers, winner + quorum logic
  scheduler.js          # 2s reconciler loop (advance songs, reap participants, AI auto-fill)
  recommendations.js    # AI song suggestions
  openai.js             # OpenAI client wrapper
  mailer.js             # Gmail transport (password reset + invites)
init.sql                # canonical schema — the single source of truth
migrations/             # Knex migrations (idempotent, INFORMATION_SCHEMA-guarded)
docs/                   # engineering journal + architecture notes (start at docs/README.md)
```

## API endpoints

All routers are mounted at the root (no `/api` prefix). Auth is read per-handler from the `Authorization: Bearer <jwt>` and/or `x-guest-token` headers.

**Auth & accounts** — `POST /register`, `POST /login`, `POST /guest/join`
**OAuth** — `GET /auth/google[/callback]`, `GET /auth/facebook[/callback]`
**Password reset** — `POST /forgot-password`, `GET /reset-password/:token`, `POST /reset-password`
**Profile & stats** — `GET|POST /profile`, `POST|DELETE /profile/image`, `GET /profile/user-stats`, `GET /profile/listening-summary`, `GET /profile/recent-listens`, `GET /profile/artist/:artistId/insights`
**Sessions & playback** — `GET|POST /sessions`, `GET|PATCH|DELETE /sessions/:id`, `GET /sessions/:id/queue`, `POST /sessions/:id/queue/add`, `POST /sessions/:id/start`, `POST /sessions/:id/join-live`, `POST /sessions/:id/leave-live`, `GET /sessions/:id/playback-sync`, `GET /sessions/:id/live/stream`
**Voting / proposals / recommendations** — `GET /sessions/:id/current-phase`, `POST|GET /sessions/:id/proposals`, `DELETE /sessions/:sessionId/proposals/:proposalId`, `POST /sessions/:id/proposals/:propId/vote`, `POST /voting-rounds/:id/close`, `GET /sessions/:id/recommendations`, `POST /sessions/:id/recommendations/add`
**Invites & participants** — `POST /sessions/:sessionId/invite`, `GET /sessions/:id/invites/accepted`, `GET /invites/sent`, `GET /invites/received`, `POST /invites/:inviteId/{accept,reject,revoke}`, `GET /sessions/:sessionId/participants`
**Artists / charts / shouts** — `GET /artist/:artistId`, `GET /user/:userId`, `GET /top-today`, `GET /top-weekly-songs`, `GET|POST /artist/:artistId/shouts`, `POST /shouts/:shoutId/like`, `DELETE /shouts/:shoutId`
**YouTube cache** — `GET|POST /youtube-cache`, `GET /youtube-info/:id`

## Database

`init.sql` is the **canonical schema and single source of truth** (the dumps in `archive/` are non-authoritative). Core tables:

- **users** / **guest_users** — registered accounts (with OAuth ids, reset tokens, profile blobs, Stripe subscription columns) and anonymous guests
- **sessions** / **session_participants** / **session_invites** — rooms, presence, and email invites
- **queue_items** — the central row for both proposals and playback (`status`, `item_type` music/pause, `item_source` user/guest/ai, voting round, timings)
- **votes** / **voting_rounds** — upvotes and the per-round state machine (`state`: suggesting/voting/closed, with durations, quorum, winner)
- **artists** / **youtube_video_cache** — canonical song metadata (title, thumbnail, duration) keyed by YouTube id
- **playback_history** / **session_song_listens** — playback log + per-user listen events powering stats
- **badges / user_badges / user_badge_progress** — gamification
- **shouts / shout_likes** — artist fan-wall comments + likes

## Getting started

**Prerequisites:** Node.js 18+, Docker (for local MySQL), and a `.env` file (see below).

```bash
# 1. Install dependencies
npm install

# 2. Start MySQL + phpMyAdmin (phpMyAdmin at http://localhost:8080)
docker compose up -d

# 3. Load the canonical schema, then apply any pending migrations
#    (import init.sql into the `tunevote` database, then:)
npm run migrate:latest

# 4. Run the server (listens on port 4000)
node index.js
```

### Environment variables

Create a `.env` file in the project root:

```env
# Database
DB_HOST=localhost
DB_USER=user
DB_PASSWORD=userpass123!
DB_NAME=tunevote
DB_PORT=3306

# Auth
JWT_SECRET=your_jwt_secret

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=...

# Facebook OAuth
FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
FACEBOOK_CALLBACK_URL=...

# Email (Gmail — used by password reset & invites)
GMAIL_USER=...
GMAIL_APP_PASSWORD=...

# AI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini        # optional, this is the default

# YouTube Data API v3
YOUTUBE_KEY=...

# App
FRONTEND_URL=http://localhost:5173/   # default in prod: https://app.tunevote.com/
NODE_ENV=development
AUTOFILL_DISABLED=false               # set true to turn off AI auto-fill
```

> A secondary cPanel SMTP transport (`email.js`, using `EMAIL_USER` / `EMAIL_PASSWORD`) also exists but is legacy — the active mailer is Gmail (`services/mailer.js`).

### Scripts

| Command | Description |
|---|---|
| `npm run migrate:latest` | Apply all pending Knex migrations |
| `npm run migrate:status` | Show migration status |
| `npm run migrate:up` / `migrate:rollback` | Step migrations up / roll back the last batch |
| `npm run migrate:mark-baseline` | Mark the baseline migration as applied (skips it on `migrate:latest`) |
| `npm run verify-schema` | Check the live DB against canonical `init.sql` (exit 0 = OK) |

Notes:
- There is **no `start` script** — run `node index.js` directly (production uses PM2).
- `npm test` is **not** wired up. The real tests in `test/` run via a custom harness: `node test/run.js`.

## Documentation

See [`docs/`](docs/) for detailed engineering notes — start at [`docs/README.md`](docs/README.md). The engineering journal covers the backend modularization, the playback/DB reliability refactor, and a registry of fixed bugs. Production runs on a single Ubuntu box: the API under PM2 as `tunevote_api`, nginx serving the frontend build, and a local MySQL, with domains `api.tunevote.com` (this API) and `app.tunevote.com` (the frontend).

## Related

- Web client: [`tunevote_frontend`](https://github.com/olivierluethy/tunevote_frontend)

## License

Released under the [MIT License](LICENSE) © Olivier Lüthy. You're free to use, modify and distribute this software, including commercially, as long as the copyright notice and license are included.

## Author

Built by **Olivier Lüthy** — [GitHub](https://github.com/olivierluethy). Part of the [TuneVote](https://github.com/olivierluethy?tab=repositories&q=tunevote) project.
