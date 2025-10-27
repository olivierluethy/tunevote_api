### Database: `tunevote`

#### Table: `guest_users`
```sql
CREATE TABLE `guest_users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `guest_token` char(36) NOT NULL,
  `nickname` varchar(50) DEFAULT 'Gast',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `guest_token` (`guest_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

#### Table: `playback_sync`
```sql
CREATE TABLE `playback_sync` (
  `session_id` int NOT NULL,
  `current_video_id` varchar(20) DEFAULT NULL,
  `progress_seconds` float DEFAULT '0',
  `is_playing` tinyint(1) DEFAULT '0',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `video_start_time` bigint DEFAULT NULL,
  PRIMARY KEY (`session_id`),
  CONSTRAINT `playback_sync_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

#### Table: `queue_items`
```sql
CREATE TABLE `queue_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` int NOT NULL,
  `video_id` varchar(20) NOT NULL,
  `title` varchar(150) NOT NULL,
  `thumbnail` varchar(255) DEFAULT NULL,
  `added_by` int DEFAULT NULL,
  `guest_id` int DEFAULT NULL,
  `status` enum('queued','playing','played','skipped') DEFAULT 'queued',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `played` tinyint(1) DEFAULT '0',
  `playedAt` datetime DEFAULT NULL,
  `startedAt` datetime DEFAULT NULL,
  `duration` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_session_video` (`session_id`,`video_id`),
  KEY `added_by` (`added_by`),
  KEY `guest_id` (`guest_id`),
  CONSTRAINT `queue_items_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `queue_items_ibfk_2` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `queue_items_ibfk_3` FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

#### Table: `sessions`
```sql
CREATE TABLE `sessions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `title` varchar(100) NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `is_live` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

#### Table: `session_participants`
```sql
CREATE TABLE `session_participants` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `guest_id` int DEFAULT NULL,
  `role` enum('host','guest') NOT NULL,
  `joined_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `is_live` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_participant` (`session_id`,`user_id`),
  UNIQUE KEY `unique_guest` (`session_id`,`guest_id`),
  KEY `user_id` (`user_id`),
  KEY `guest_id` (`guest_id`),
  CONSTRAINT `session_participants_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `session_participants_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `session_participants_ibfk_3` FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

#### Table: `users`
```sql
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `email` varchar(100) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### Notes:
- The schema includes five tables: `guest_users`, `playback_sync`, `queue_items`, `sessions`, and `session_participants`, `users`.
- Foreign key constraints ensure referential integrity, with cascading deletes where applicable.
- The `queue_items` table uses an `ENUM` for the `status` column with values: `'queued'`, `'playing'`, `'played'`, `'skipped'`.
- The `session_participants` table uses an `ENUM` for the `role` column with values: `'host'`, `'guest'`.
- All tables use the `InnoDB` engine and `utf8mb4` character set with `utf8mb4_0900_ai_ci` collation.