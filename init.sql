CREATE DATABASE IF NOT EXISTS tunevote 
  CHARACTER SET utf8mb4 
  COLLATE utf8mb4_general_ci;

USE tunevote;

-- =======================================
-- USERS: App-Benutzer (Hosts, Gäste)
-- =======================================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =======================================
-- SESSIONS: Musiksessions / Räume
-- =======================================
CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,                     -- Host (Session-Ersteller)
  title VARCHAR(255) NOT NULL,
  access_code VARCHAR(12) UNIQUE,           -- z. B. für QR-Beitritt, optional
  is_active BOOLEAN DEFAULT TRUE,           -- beendet oder nicht
  current_item_id INT DEFAULT NULL,         -- aktuell gespielter Song
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =======================================
-- SESSION_PARTICIPANTS: Wer ist in welcher Session
-- =======================================
CREATE TABLE IF NOT EXISTS session_participants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  role ENUM('host', 'guest') DEFAULT 'guest',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_participant (session_id, user_id)
);

-- =======================================
-- QUEUE_ITEMS: Songs oder Pausen
-- =======================================
CREATE TABLE IF NOT EXISTS queue_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,                  
  video_id VARCHAR(20),                     -- YouTube Video-ID (optional)
  title VARCHAR(255) NOT NULL,              
  thumbnail VARCHAR(255),
  position INT NOT NULL DEFAULT 0,
  added_by INT NULL,                        -- kann bei Anonymen NULL sein
  is_pause BOOLEAN DEFAULT FALSE,
  pause_duration INT DEFAULT 30,            -- Sekunden
  play_count INT DEFAULT 0,                 -- Statistik
  total_votes INT DEFAULT 0,                -- Cache für Ranking (Performance)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);

-- =======================================
-- VOTES: Likes / Dislikes pro Queue-Item
-- =======================================
CREATE TABLE IF NOT EXISTS votes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  queue_item_id INT NOT NULL,
  user_id INT NOT NULL,
  vote TINYINT NOT NULL CHECK (vote IN (0, 1)),   -- 1=Like, 0=Dislike
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_vote (queue_item_id, user_id)
);

-- =======================================
-- PLAYBACK_SYNC: für synchronisierte Wiedergabe
-- =======================================
CREATE TABLE IF NOT EXISTS playback_sync (
  session_id INT PRIMARY KEY,
  current_video_id VARCHAR(20),
  progress_seconds INT DEFAULT 0,           -- aktueller Fortschritt im Song
  is_playing BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guest_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  guest_token CHAR(36) NOT NULL UNIQUE,   -- z. B. UUID v4
  nickname VARCHAR(50) DEFAULT NULL,      -- optionaler Name
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

/* Dann änderst du queue_items und votes, damit sie entweder user_id oder guest_id speichern können: 
ALTER TABLE queue_items
  ADD COLUMN guest_id INT DEFAULT NULL,
  ADD FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE SET NULL;

ALTER TABLE votes
  ADD COLUMN guest_id INT DEFAULT NULL,
  ADD FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE SET NULL;


*/