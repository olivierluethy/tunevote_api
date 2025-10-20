CREATE DATABASE IF NOT EXISTS tunevote CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE tunevote;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,                  -- wer die Session erstellt hat
  title VARCHAR(255) NOT NULL,          -- optional: Name der Session
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,               -- welche Session
  video_id VARCHAR(20) NOT NULL,         -- YouTube Video-ID
  title VARCHAR(255) NOT NULL,           -- Titel des Songs
  thumbnail VARCHAR(255),                -- Thumbnail-URL
  position INT NOT NULL DEFAULT 0,       -- Reihenfolge in der Queue
  added_by INT NOT NULL,                 -- welcher Benutzer hat vorgeschlagen
  is_pause BOOLEAN DEFAULT FALSE,        -- wenn es eine Pause ist
  pause_duration INT DEFAULT 30,         -- Dauer in Sekunden
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  queue_item_id INT NOT NULL,
  user_id INT NOT NULL,
  vote TINYINT NOT NULL,                -- 1 = like / 0 = dislike
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_vote (queue_item_id, user_id)
);
