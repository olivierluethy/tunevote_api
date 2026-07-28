# TuneVote — Work Summary

**Date:** 28 July 2026
**Scope:** Frontend (`tunevote_frontend`) + Backend/API (`tunevote_api`)
**Status:** Shipped to production (`app.tunevote.com` / `api.tunevote.com`)

---

## Executive summary

Over this working session I documented the two repositories, closed several
production-affecting bugs, shipped a large set of new statistics/social features,
gave the whole app a cohesive visual redesign, moved the hosting to a cleaner
split architecture, and deployed everything to production with a database backup
and migrations. A few follow-up items are listed at the end.

---

## 1. Documentation & repository hygiene

- Wrote proper **README** files for both repos (they previously contained only
  scaffolding / a list of bookmarks) describing each service's role, setup, env
  vars, and how they relate.
- Added a **deployment runbook** (`DEPLOYMENT.md`) and a **troubleshooting guide**
  (`TROUBLESHOOTING.md`) so future deploys are repeatable and documented.
- Froze the project's historical notes into a structured **archive** document.
- **Security clean-up:** removed committed secrets (a live API key and a 24 MB
  database backup) from version control, added `.env.example` templates, and
  ensured secrets are git-ignored going forward. *(Follow-up: the previously
  exposed keys should be rotated — see §8.)*

## 2. Bug fixes (several were breaking production behaviour)

- **Broken accents/umlauts (mojibake):** the database connection wasn't using the
  `utf8mb4` charset, so characters like ä/é/ü rendered garbled. Fixed the
  connection charset. *(A related production data-repair task remains — see §8.)*
- **Password change was throwing** an error (a missing import) — fixed.
- **Public user profiles returned a 500 error** — a shared stats function wasn't
  wired up correctly; extracted and fixed it.
- **Statistics crash** on accounts with lots of activity (a numeric overflow in a
  streak calculation) — fixed.
- **Config bug:** the backend ignored the database port setting — fixed.
- Small correctness fixes (empty/0-second songs no longer clutter "Top Songs",
  a latent crash in the comments feed, sort menu that didn't actually sort).

## 3. New features

**Profile & listening statistics**
- Voting-behaviour chart, a listening **calendar**, and per-artist "when you
  listened" views.
- "Last listened" indicators and human-readable durations (h/m/s).
- **Profile picture** overhaul: one place to upload a file, **drag & drop**, or
  paste an image link (with one-click paste); plus remove.
- **Password tools:** strength meter, generator, copy, and "email me a new
  password". Users who sign in with Google/Facebook correctly see no password
  section.

**Comments (artist wall)**
- Replaced the single "like" with **thumbs-up / thumbs-down**, added the ability
  to **edit your own comments**, YouTube-style **relative timestamps**, and made
  commenter profiles clickable.

**Song statistics page (new)**
- A dedicated page per song with **live, animated counters** (plays, listeners,
  last played), a **trend + short-term forecast** chart, and **popularity
  rankings** (all-time / month / week / day / hour).
- The rankings are clickable and open a **Top-10 artists** leaderboard per period.
- Added a listening **trend + forecast** to the artist page as well.

**Dashboard**
- Fixed a dropdown menu that appeared cut off, added a **"Hosting" badge** and a
  "hosted by me" sort, and showed the year on session dates.

## 4. Full visual redesign

Redesigned the **Dashboard, Profile, Artist, User, and Song** pages into one
cohesive, modern look (dark theme, consistent colour system, glass panels,
tasteful motion/animations), and put the **real TuneVote logo** in the header.
Also consolidated ~44 hard-coded API URLs into a single configurable value so the
same code runs locally and in production without edits.

## 5. Professional URLs (long IDs)

Artist, user, song, and **session** page URLs now use long unique IDs (similar in
style to a ChatGPT conversation link) instead of small numbers, for a more
professional feel and to avoid exposing sequential IDs. The change is
backwards-compatible (old links still work) and the app's internal logic and
real-time playback were kept untouched.

## 6. Infrastructure — split hosting

- Moved the **frontend off the VPS** onto a GoDaddy **cPanel** account
  (`app.tunevote.com`); the **VPS is now backend-only** (`api.tunevote.com`).
  This is cleaner and frees VPS resources.
- Removed leftover database dumps from the server.
- Documented the new split architecture in the deployment runbook.

## 7. Production deployment

- Committed and pushed all changes to both repositories.
- **Backend → VPS:** synced code, **took a verified database backup first**, ran
  5 schema migrations, restarted the service, and confirmed the new endpoints are
  live.
- **Frontend → cPanel:** built and uploaded; confirmed the live site serves the
  new version with a valid HTTPS certificate.
- Verified end-to-end that production is serving the new features.

## 8. Outstanding / recommended follow-ups

- **Production text-encoding data repair:** some existing song titles were saved
  with double-encoded characters on production (a legacy data issue from earlier
  imports). The connection/pipeline is now hardened, but a **safe, reversible
  data-repair migration** for those existing rows is still to be run (diagnose →
  dry-run → apply with backup). *This is scoped and ready to do next.*
- **Rotate credentials** that were previously exposed in the repo history (the API
  key), and the shared hosting passwords.
- **Minor schema-doc cleanup:** the schema-verification script flags two
  pre-existing items (a table and a column removed by older migrations) where the
  canonical schema file wasn't updated — cosmetic, no runtime impact.
- **Testing:** the session-URL change touches the core real-time flow; a full
  manual pass (create → join → playback sync → share) is recommended.

---

*Prepared as a plain-language overview. Technical detail, commit history, and the
step-by-step deployment procedure are in the repositories' `DEPLOYMENT.md`,
`TROUBLESHOOTING.md`, and git logs.*
