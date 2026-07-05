-- =============================================================================
-- TuneVote — Canonical Database Schema (Phase 1)
-- =============================================================================
-- This file is the SINGLE SOURCE OF TRUTH for the TuneVote database schema.
-- Historical phpMyAdmin dumps live in archive/ and are NOT authoritative.
--
-- Phase 1 reconciliation decisions (do not change without a migration):
--   * youtube_id is VARCHAR(11) everywhere it appears
--     (youtube_video_cache.youtube_id, queue_items.video_id,
--      playback_sync.current_video_id, playback_history.youtube_id).
--     Real YouTube video IDs are exactly 11 base64url characters.
--   * voting_rounds.phase ENUM uses 'suggestion' (NOT 'suggesting').
--     The application code at index.js lines 444 and 3117 writes 'suggestion'.
--   * youtube_video_cache.title_norm is NOT UNIQUE. Two different videos can
--     share a normalized title (covers, re-uploads, regional variants); the
--     production dump's UNIQUE on title_norm is a bug and is not present here.
--   * session_participants.left_at exists (production dump is missing it;
--     index.js line 3322 writes to it).
--   * artists, playback_history, session_song_listens, badges, user_badges,
--     user_badge_progress, shouts, shout_likes are part of the canonical
--     schema even though they were absent from the prod dump.
--
-- Phase 2 reconciliation decisions (applied here):
--   * queue_items no longer carries title, thumbnail, or duration for music
--     rows. Music metadata is read by JOIN-ing youtube_video_cache via
--     queue_items.video_id (now a real FK, ON DELETE RESTRICT).
--   * The queue_items.duration column is renamed pause_duration_seconds and
--     populated only for item_type='pause' rows.
--   * The queue_items.played boolean is dropped — status='played' is the
--     single source of truth.
--   * A CHECK constraint enforces that music rows have video_id and no
--     pause_duration_seconds, and pause rows have pause_duration_seconds
--     and no video_id.
--
-- Later audit phases (CHECK constraints on user_id/guest_id, sessions
-- lifecycle collapse, users.imageData extraction, etc.) are NOT applied
-- here. They will be introduced via separate Knex migrations.
-- =============================================================================

CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  reset_token VARCHAR(64),
  reset_token_expiry DATETIME,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  imageType varchar(255),
  imageData longblob,
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE guest_users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guest_token CHAR(36) NOT NULL,
  nickname VARCHAR(50) DEFAULT 'Gast',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY guest_token (guest_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE artists (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  name_norm VARCHAR(255) NOT NULL,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  channel_id VARCHAR(255) DEFAULT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE youtube_video_cache (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  youtube_id VARCHAR(11) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  title_norm VARCHAR(255) NOT NULL,
  artist_id INT NULL,
  duration INT DEFAULT NULL,
  thumbnail TEXT,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (artist_id) REFERENCES artists(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  is_active TINYINT(1) DEFAULT '1',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL DEFAULT NULL,
  is_live TINYINT(1) DEFAULT '0',
  is_private TINYINT(1) DEFAULT 0,
  KEY user_id (user_id),
  CONSTRAINT sessions_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE playback_history (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  youtube_id VARCHAR(11),
  session_id INT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (youtube_id) REFERENCES youtube_video_cache(youtube_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_invites (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  invited_by_user_id INT NOT NULL,

  -- Eingeladene Person:
  email VARCHAR(255) NOT NULL,
  invited_user_id INT NULL,

  -- Status: Modell A
  status ENUM('pending', 'accepted', 'rejected', 'revoked')
    NOT NULL DEFAULT 'pending',

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL,

  accepted_at TIMESTAMP NULL,
  rejected_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,

  -- Ein User kann für dieselbe Session nicht mehrfach eingeladen werden
  UNIQUE KEY unique_invite (session_id, email), -- <-- HIER IST DIE KORREKTUR

  -- Performance-Indizes
  INDEX idx_invited_user (invited_user_id),
  INDEX idx_invited_by (invited_by_user_id),
  INDEX idx_session (session_id),
  INDEX idx_status (status),

  -- Foreign Keys
  FOREIGN KEY (session_id)
    REFERENCES sessions(id) ON DELETE CASCADE,

  FOREIGN KEY (invited_by_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  FOREIGN KEY (invited_user_id)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_participants (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  user_id INT DEFAULT NULL,
  guest_id INT DEFAULT NULL,
  role ENUM('host', 'user','guest') NOT NULL,
  joined_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMP NULL,
  is_live TINYINT(1) DEFAULT '0',
  UNIQUE KEY unique_participant (session_id,user_id),
  UNIQUE KEY unique_guest (session_id,guest_id),
  KEY user_id (user_id),
  KEY guest_id (guest_id),
  CONSTRAINT session_participants_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT session_participants_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT session_participants_ibfk_3 FOREIGN KEY (guest_id) REFERENCES guest_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `queue_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `session_id` INT NOT NULL,
  `video_id` VARCHAR(11) DEFAULT NULL,
  `added_by` INT DEFAULT NULL,
  `guest_id` INT DEFAULT NULL,
  `status` ENUM('queued','playing','played','skipped','archived','suggested') DEFAULT 'queued',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `playedAt` DATETIME DEFAULT NULL,
  `startedAt` DATETIME DEFAULT NULL,
  `started_at_ms` BIGINT DEFAULT NULL,
  `pause_duration_seconds` INT DEFAULT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `item_type` ENUM('music','pause') NOT NULL DEFAULT 'music',
  `item_source` ENUM('user','guest','ai') DEFAULT 'user',
  `voting_round_id` INT DEFAULT NULL,

  KEY `session_video` (`session_id`,`video_id`),
  KEY `added_by` (`added_by`),
  KEY `guest_id` (`guest_id`),
  KEY `idx_session_status` (`session_id`,`status`),
  KEY `idx_round_status` (`voting_round_id`,`status`),
  KEY `idx_status` (`status`),

  CONSTRAINT `queue_items_ibfk_1`
    FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,

  CONSTRAINT `queue_items_ibfk_2`
    FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,

  CONSTRAINT `queue_items_ibfk_3`
    FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE SET NULL,

  CONSTRAINT `queue_items_ibfk_4`
    FOREIGN KEY (`video_id`) REFERENCES `youtube_video_cache` (`youtube_id`) ON DELETE RESTRICT,

  CONSTRAINT `ck_queue_items_kind` CHECK (
    (`item_type` = 'music'
       AND `video_id` IS NOT NULL
       AND `pause_duration_seconds` IS NULL)
    OR
    (`item_type` = 'pause'
       AND `video_id` IS NULL
       AND `pause_duration_seconds` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE playback_sync (
  session_id INT NOT NULL PRIMARY KEY,
  current_video_id VARCHAR(11) DEFAULT NULL,
  progress_seconds FLOAT DEFAULT 0,
  is_playing TINYINT(1) DEFAULT 0,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  video_start_time BIGINT DEFAULT NULL,
  CONSTRAINT playback_sync_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT playback_sync_ibfk_2 FOREIGN KEY (current_video_id) REFERENCES youtube_video_cache(youtube_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =============================================
-- 6. Votes (Upvotes für Vorschläge)
-- =============================================
CREATE TABLE votes (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    queue_item_id INT NOT NULL,
    user_id INT NULL,
    guest_id INT NULL,
    vote TINYINT(1) DEFAULT 1, -- nur Upvote (1), Downvote später möglich
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (queue_item_id) REFERENCES queue_items(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE CASCADE,
    
    UNIQUE KEY unique_vote_user (queue_item_id, user_id),
    UNIQUE KEY unique_vote_guest (queue_item_id, guest_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE voting_rounds (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  started_by_user_id INT NULL,
  started_by_guest_id INT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ends_at TIMESTAMP NULL,
  phase ENUM('suggestion','voting','closed') NOT NULL DEFAULT 'suggestion',
  phase_ends_at DATETIME NULL,
  suggestion_duration INT DEFAULT 90,
  voting_duration INT DEFAULT 60,
  max_suggestions INT DEFAULT 10,
  status ENUM('open','closed','computed') DEFAULT 'open',
  winner_queue_item_id INT NULL,
  quorum_percent FLOAT DEFAULT 0.66,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_song_listens (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,

  session_id INT NOT NULL,
  queue_item_id INT NOT NULL,

  user_id INT NULL,
  guest_id INT NULL,

  listened_from DATETIME NOT NULL,
  listened_to DATETIME NOT NULL,

  listen_seconds INT NOT NULL,
  completed TINYINT(1) DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CHECK (
    (user_id IS NOT NULL AND guest_id IS NULL)
    OR
    (user_id IS NULL AND guest_id IS NOT NULL)
  ),

  INDEX idx_session_song (session_id, queue_item_id),
  INDEX idx_user (user_id),
  INDEX idx_guest (guest_id),

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE badges (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,

  -- Eindeutiger technischer Key (für Backend-Logik)
  key_name VARCHAR(50) NOT NULL UNIQUE,

  -- Anzeige
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL,

  -- Einordnung
  category ENUM(
    'progression',
    'listener',
    'host',
    'social',
    'engagement',
    'special'
  ) NOT NULL,

  -- Darstellung (Frontend)
  icon VARCHAR(100) DEFAULT NULL,     -- z. B. Emoji oder Icon-Key
  color VARCHAR(20) DEFAULT NULL,     -- z. B. hex oder CSS-Name

  -- Metadaten
  rarity ENUM('common','uncommon','rare','epic','legendary')
    DEFAULT 'common',

  -- Flags
  is_hidden TINYINT(1) DEFAULT 0,      -- Secret / Überraschungs-Badges
  is_active TINYINT(1) DEFAULT 1,      -- deaktivierbar ohne Löschen

  -- Zeitliche Einschränkung (optional)
  available_from DATETIME DEFAULT NULL,
  available_until DATETIME DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_badges (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  badge_id INT NOT NULL,
  awarded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY unique_user_badge (user_id, badge_id),

  FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  FOREIGN KEY (badge_id)
    REFERENCES badges(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_badge_progress (
  user_id INT NOT NULL,
  badge_id INT NOT NULL,
  current_value INT NOT NULL,
  target_value INT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id, badge_id),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO badges (key_name, title, description, category, icon) VALUES
('beginner', 'Beginner', 'Erste Session gehört', 'progression', '🌱'),
('regular', 'Regular', '10 Sessions gehört', 'progression', '🎧'),
('legend', 'Legende', '100 Sessions gehört', 'progression', '🏆'),

('first_listen', 'First Listen', 'Ersten Song gehört', 'listener', '▶️'),
('music_lover', 'Music Lover', '500 Minuten Musik gehört', 'listener', '❤️'),
('marathon', 'Marathon', '2 Stunden in einer Session gehört', 'listener', '⏱️'),

('first_host', 'First Session', 'Erste Session erstellt', 'host', '🎤'),
('session_master', 'Session Master', '10 Sessions erstellt', 'host', '🎚️'),
('crowd_host', 'Crowd Host', 'Session mit 5 Hörern', 'host', '👥'),

('voter', 'Voter', '10 Votes abgegeben', 'social', '👍'),
('trendsetter', 'Trendsetter', 'Eigener Song 5× gehört', 'social', '🔥'),
('collaborator', 'Collaborator', '5 gemeinsame Sessions', 'social', '🤝');

CREATE TABLE shouts (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    artist_id INT NOT NULL,
    user_id INT NOT NULL,
    parent_id INT DEFAULT NULL, -- für Antworten
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Optional: um Löschungen/Moderation zu unterstützen
    is_deleted TINYINT(1) DEFAULT 0,
    deleted_at DATETIME DEFAULT NULL,

    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES shouts(id) ON DELETE CASCADE,
    
    INDEX idx_artist (artist_id),
    INDEX idx_parent (parent_id),
    INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shout_likes (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    shout_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY unique_like (shout_id, user_id),

    FOREIGN KEY (shout_id) REFERENCES shouts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
