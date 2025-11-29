CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  reset_token VARCHAR(64),
  reset_token_expiry DATETIME,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE guest_users (
  id INT NOT NULL AUTO_INCREMENT,
  guest_token CHAR(36) NOT NULL,
  nickname VARCHAR(50) DEFAULT 'Gast',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY guest_token (guest_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE youtube_video_cache (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  youtube_id VARCHAR(255) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  title_norm VARCHAR(255) NOT NULL UNIQUE,
  duration INT DEFAULT NULL,
  thumbnail TEXT,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  is_active TINYINT(1) DEFAULT '1',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL DEFAULT NULL,
  is_live TINYINT(1) DEFAULT '0',
  is_private TINYINT(1) DEFAULT 0,
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT sessions_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_invites (
  id INT NOT NULL AUTO_INCREMENT,

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

  PRIMARY KEY (id),

  -- Ein User kann für dieselbe Session nicht mehrfach eingeladen werden
  unique_invite (session_id, email),

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
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  user_id INT DEFAULT NULL,
  guest_id INT DEFAULT NULL,
  role ENUM('host', 'user','guest') NOT NULL,
  joined_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  is_live TINYINT(1) DEFAULT '0',
  PRIMARY KEY (id),
  UNIQUE KEY unique_participant (session_id,user_id),
  UNIQUE KEY unique_guest (session_id,guest_id),
  KEY user_id (user_id),
  KEY guest_id (guest_id),
  CONSTRAINT session_participants_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT session_participants_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT session_participants_ibfk_3 FOREIGN KEY (guest_id) REFERENCES guest_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `queue_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `session_id` INT NOT NULL,
  `video_id` VARCHAR(20),
  `title` VARCHAR(150) NOT NULL,
  `thumbnail` VARCHAR(255) DEFAULT NULL,
  `added_by` INT DEFAULT NULL,
  `guest_id` INT DEFAULT NULL,
  `status` ENUM('queued','playing','played','skipped','archived','suggested') DEFAULT 'queued',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `played` TINYINT(1) DEFAULT '0',
  `playedAt` DATETIME DEFAULT NULL,
  `startedAt` DATETIME DEFAULT NULL,
  `duration` INT DEFAULT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `item_type` ENUM('music','pause') NOT NULL DEFAULT 'music',
  `item_source` ENUM('user','guest','ai') DEFAULT 'user',
  `voting_round_id` INT DEFAULT NULL,

  PRIMARY KEY (`id`),

  KEY `session_video` (`session_id`,`video_id`),
  KEY `added_by` (`added_by`),
  KEY `guest_id` (`guest_id`),

  CONSTRAINT `queue_items_ibfk_1` 
    FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,

  CONSTRAINT `queue_items_ibfk_2` 
    FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,

  CONSTRAINT `queue_items_ibfk_3` 
    FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE playback_sync (
  session_id INT NOT NULL,
  current_video_id VARCHAR(11) DEFAULT NULL,
  progress_seconds FLOAT DEFAULT 0,
  is_playing TINYINT(1) DEFAULT 0,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  video_start_time BIGINT DEFAULT NULL,
  PRIMARY KEY (session_id),
  CONSTRAINT playback_sync_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT playback_sync_ibfk_2 FOREIGN KEY (current_video_id) REFERENCES youtube_video_cache(youtube_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =============================================
-- 6. Votes (Upvotes für Vorschläge)
-- =============================================
CREATE TABLE votes (
    id INT AUTO_INCREMENT PRIMARY KEY,
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
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  started_by_user_id INT NULL,
  started_by_guest_id INT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ends_at TIMESTAMP NULL,
  phase ENUM('suggestion','voting','closed') DEFAULT 'suggestion',
  phase_ends_at DATETIME NULL,
  suggestion_duration INT DEFAULT 90,
  voting_duration INT DEFAULT 60;
  max_suggestions INT DEFAULT 10,
  status ENUM('open','closed','computed') DEFAULT 'open',
  winner_queue_item_id INT NULL,
  quorum_percent FLOAT DEFAULT 0.66,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;