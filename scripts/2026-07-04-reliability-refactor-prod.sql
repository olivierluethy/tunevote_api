-- =============================================================================
-- TuneVote — Reliability + source-of-truth refactor, PROD schema changes
-- Plain-DDL counterpart of Knex migrations 20260704000001–000004.
-- Prod DB is a privilege-limited shared cPanel host (no CREATE ROUTINE, no
-- INFORMATION_SCHEMA): this file is plain DDL/DML only — no procedures, no guards.
--
-- RUN ONCE, in order. Not idempotent (re-running errors on existing columns).
-- Because it DROPS playback_sync and voting_rounds.phase/status (which the OLD
-- running code still uses), run it inside a short maintenance window:
--   pm2 stop tunevote_api  ->  run this SQL  ->  git pull + npm install  ->  pm2 start
--
-- This deploy KEEPS sessions.is_active / is_live (dual-written) — dropping those
-- is C3b, gated on the frontend that reads `status` being live everywhere.
-- =============================================================================

-- ---- Migration 1: durable playback deadline + participant heartbeat ---------
ALTER TABLE sessions            ADD COLUMN current_plays_until DATETIME NULL;
ALTER TABLE session_participants ADD COLUMN last_seen          DATETIME NULL;
CREATE INDEX idx_sessions_live_deadline ON sessions (is_live, current_plays_until);

-- ---- Migration 2: drop playback_sync (now-playing derived from queue row) ----
DROP TABLE IF EXISTS playback_sync;

-- ---- Migration 3: collapse voting_rounds.phase + status -> state -------------
ALTER TABLE voting_rounds
  ADD COLUMN state ENUM('suggesting','voting','closed') NOT NULL DEFAULT 'suggesting';
UPDATE voting_rounds SET state = CASE
  WHEN status IN ('closed','computed') OR phase = 'closed' THEN 'closed'
  WHEN phase = 'voting' THEN 'voting'
  ELSE 'suggesting'
END;
CREATE INDEX idx_voting_rounds_state ON voting_rounds (session_id, state);
ALTER TABLE voting_rounds DROP COLUMN phase, DROP COLUMN status;

-- ---- Migration 4: add sessions.status (dual-written with is_live) ------------
ALTER TABLE sessions
  ADD COLUMN status ENUM('draft','live','ended') NOT NULL DEFAULT 'draft';
UPDATE sessions SET status = CASE
  WHEN is_live = 1 THEN 'live'
  WHEN ended_at IS NOT NULL THEN 'ended'
  ELSE 'draft'
END;
CREATE INDEX idx_sessions_status ON sessions (status);

-- Sanity checks (optional):
--   SELECT status, COUNT(*) FROM sessions GROUP BY status;
--   SELECT state,  COUNT(*) FROM voting_rounds GROUP BY state;
--   SHOW TABLES LIKE 'playback_sync';   -- should return no rows
