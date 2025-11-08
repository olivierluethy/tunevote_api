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
  thumbnail TEXT,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  is_active TINYINT(1) DEFAULT '1',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  is_live TINYINT(1) DEFAULT '0',
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT sessions_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE session_participants (
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  user_id INT DEFAULT NULL,
  guest_id INT DEFAULT NULL,
  role ENUM('host','guest') NOT NULL,
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

CREATE TABLE queue_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  fk_video_id INT NOT NULL,
  added_by INT DEFAULT NULL,
  guest_id INT DEFAULT NULL,
  status ENUM('queued','playing','played','skipped') DEFAULT 'queued',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  played TINYINT(1) DEFAULT '0',
  playedAt DATETIME DEFAULT NULL,
  startedAt DATETIME DEFAULT NULL,
  duration INT DEFAULT NULL,
  item_type enum('music','pause') NOT NULL DEFAULT 'music',
  description varchar(255) DEFAULT NULL,
  UNIQUE KEY unique_session_video (session_id,fk_video_id),
  KEY added_by (added_by),
  KEY guest_id (guest_id),
  KEY fk_video_id (fk_video_id),
  CONSTRAINT queue_items_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT queue_items_ibfk_2 FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT queue_items_ibfk_3 FOREIGN KEY (guest_id) REFERENCES guest_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_queue_video FOREIGN KEY (fk_video_id) REFERENCES youtube_video_cache (id) ON DELETE RESTRICT
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