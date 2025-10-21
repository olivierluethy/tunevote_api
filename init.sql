-- =============================================
-- Drop the whole database (including all tables)
-- =============================================
DROP DATABASE IF EXISTS tunevote;

-- =============================================
-- TuneVote Datenbank – Alle Tabellen
-- MySQL / MariaDB kompatibel
-- =============================================

-- Datenbank anlegen (falls noch nicht vorhanden)
CREATE DATABASE tunevote CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tunevote;

-- =============================================
-- 1. Benutzer (registrierte User)
-- =============================================
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 2. Gäste (ohne Account)
-- =============================================
CREATE TABLE guest_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guest_token CHAR(36) NOT NULL UNIQUE, -- UUID
    nickname VARCHAR(50) DEFAULT 'Gast',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 3. Sessions
-- =============================================
CREATE TABLE sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(100) NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =============================================
-- 4. Teilnehmer (Host + Gäste)
-- =============================================
CREATE TABLE session_participants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    user_id INT NULL,
    guest_id INT NULL,
    role ENUM('host', 'guest') NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE CASCADE,
    
    UNIQUE KEY unique_participant (session_id, user_id),
    UNIQUE KEY unique_guest (session_id, guest_id)
);

-- =============================================
-- 5. Warteschlange + Vorschläge (queue_items)
-- =============================================
CREATE TABLE queue_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    video_id VARCHAR(20) NOT NULL,           -- YouTube Video-ID (z.B. dQw4w9WgXcQ)
    title VARCHAR(150) NOT NULL,
    thumbnail VARCHAR(255),
    position INT NULL,                       -- NULL = Vorschlag, >0 = in Queue
    added_by INT NULL,                       -- user_id
    guest_id INT NULL,                       -- guest_id
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (guest_id) REFERENCES guest_users(id) ON DELETE SET NULL,
    
    UNIQUE KEY unique_proposal (session_id, video_id, position), -- verhindert Duplikate
    INDEX idx_session_position (session_id, position),
    INDEX idx_session_proposal (session_id)
);

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
);

-- =============================================
-- 7. Playback Sync (für Host-Sync)
-- =============================================
CREATE TABLE playback_sync (
    session_id INT PRIMARY KEY,
    current_video_id VARCHAR(20),
    progress_seconds FLOAT DEFAULT 0,
    is_playing TINYINT(1) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- =============================================
-- Indizes für Performance
-- =============================================
CREATE INDEX idx_sessions_active ON sessions(is_active);
CREATE INDEX idx_queue_position ON queue_items(session_id, position);
CREATE INDEX idx_proposals_votes ON votes(queue_item_id);