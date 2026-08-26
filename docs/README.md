# TuneVote — Documentation (Start Here)

This folder is the written record of the major work done on TuneVote. It exists so
that **before we change or "fix" anything, we can check what was already done, how,
and why** — and so a **new teammate can get productive fast**.

> **Scope note:** these docs span *both* repos — the backend `tunevote_api` and the
> frontend `tunevote_frontend`. Everything described here is **deployed to production**
> (`app.tunevote.com` / `api.tunevote.com`) unless a section says otherwise.

---

## 🔎 "Is this bug already fixed?" — read this first

Most reported issues are already solved. **Before debugging, search the two bug
registries** (Ctrl-F the symptom):

1. **[Engineering Journal → §2 Fixed-bugs registry](2026-07-ENGINEERING-JOURNAL.md#2-fixed-bugs-registry)**
   — the foundational fixes (playback reliability, "stuck live" sessions, song-switch
   races, DB source-of-truth, the mini-player, the dev/prod setup). Bugs #1–#12.
2. **[Realtime/Recs/Now-Playing → §2](2026-07-04-realtime-recommendations-and-nowplaying-fixes.md#2-fixed-bugs-registry)**
   — the later round (live viewer count, stale-token guest downgrade, AI suggestions,
   YouTube mapping/quota, session rename, cross-device sync, now-playing waveform,
   never-ending playback, mini-player redesign). Items §2.1–§2.11.

Each entry has **symptom → root cause → fix → commit → status** (✅ fixed / ⚠️ mitigated
/ 🔵 known-open). If it's ✅, read the fix instead of re-investigating.

---

## 👋 New to the team? Read in this order

1. **[Engineering Journal](2026-07-ENGINEERING-JOURNAL.md)** — start with its §1 TL;DR,
   §9 Current architecture, and §13 Glossary. This is the backbone: what the app is,
   how the backend/frontend are structured, and the core playback/voting/liveness flows.
2. **[Architecture & Database analysis](2026-07-04-architecture-and-database-analysis.md)**
   — the *why* behind the reliability refactor (the redundant, drift-prone state and the
   race conditions it removed). Read this before touching playback or the schema.
3. **[Realtime, Recommendations & Now-Playing fixes](2026-07-04-realtime-recommendations-and-nowplaying-fixes.md)**
   — the continuation: everything built after the refactor.

---

## 📚 Document index

| Document | What's in it | Read when… |
|---|---|---|
| **[2026-07-ENGINEERING-JOURNAL.md](2026-07-ENGINEERING-JOURNAL.md)** | **Part 1.** The global persistent player + mini-player, `SessionPage` split, the YouTube DOM-crash fix, the **backend modularization** (`index.js` 6,406 → ~170 lines), and the **playback/DB reliability refactor** (atomic `advanceToNext`, crash-safe reconciler, heartbeat, source-of-truth collapse). Bug registry #1–#12, schema/migrations, tests, dev+prod runbooks, glossary. | Understanding the foundation, the architecture, or the DB schema. |
| **[2026-07-04-realtime-recommendations-and-nowplaying-fixes.md](2026-07-04-realtime-recommendations-and-nowplaying-fixes.md)** | **Part 2.** Live viewer count, auth/guest fixes, AI recommendation quality, YouTube mapping + quota ceiling, live session rename, cross-device playback sync, the **now-playing waveform**, **never-ending playback (server AI auto-fill)**, and the **mini-player glassmorphism redesign**. Bug registry §2.1–§2.11, current deploy runbook, commit reference, key files. | Looking up a recent feature/bug, or the current deploy procedure. |
| **[2026-07-04-architecture-and-database-analysis.md](2026-07-04-architecture-and-database-analysis.md)** | The honest deep-dive that motivated the refactor: redundant state, race conditions, and the single-source-of-truth plan. | Before changing playback logic or the database schema. |
| **[2026-08-26-database-security-architecture.md](2026-08-26-database-security-architecture.md)** | Securing the DB layer (issue #53): MySQL bound to loopback, phpMyAdmin de-published (compose `admin` profile + SSH tunnel), credentials moved out of the repo, plus the VPS runbook (nginx/DNS/firewall/rotation) and acceptance-criteria map. | Administering the production DB, or changing anything that touches DB exposure. |
| **[superpowers/plans/](superpowers/plans/)** | The step-by-step implementation plans: Phase 1 (reliability), Phase 2 (source-of-truth collapse), and **C3b** (the one gated cleanup still to do — drop `is_active`/`is_live`). | Executing a planned change, or picking up C3b. |
| **[../scripts/2026-07-04-reliability-refactor-prod.sql](../scripts/2026-07-04-reliability-refactor-prod.sql)** | Plain-SQL counterpart of the reliability migrations (reference/fallback). | Applying schema changes by hand. |

---

## ⚡ Quick facts (cheat sheet)

- **Repos:** backend `olivierluethy/tunevote_api`, frontend `olivierluethy/tunevote_frontend`.
- **Prod:** single Ubuntu box `salade@72.167.49.141` (password SSH, `sudo`); app under
  **root's PM2** (`tunevote_api`); nginx serves the frontend from **`/var/www/TuneVote/dist`**;
  MySQL is **local** on the box.
- **Deploy the frontend by building LOCALLY and shipping `dist`** (the prod box OOM-kills /
  races `vite build`). Full runbook: [Part 2 §4](2026-07-04-realtime-recommendations-and-nowplaying-fixes.md#4-deploy-runbook).
- **PWA cache gotcha:** after a frontend deploy, **hard-refresh** (or the service worker
  serves the old bundle) before concluding a change "didn't work".
- **Golden rules the codebase follows:** one source of truth per fact, the **server is
  authoritative** for playback, every state transition is **atomic**, and the system
  **self-heals** (the reconciler).

---

## ➕ Keeping these docs current

When you finish a meaningful change, **add a bug-registry row / section to Part 2** (or a
new dated doc if it's a big new theme) with symptom → cause → fix → commit, and add the
commit to its reference table. Keep this README's index in sync. One source of truth —
so the next person (or the next AI session) doesn't re-solve a solved problem.
