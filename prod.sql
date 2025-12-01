-- phpMyAdmin SQL Dump
-- version 5.2.3
-- https://www.phpmyadmin.net/
--
-- Host: mysql
-- Generation Time: Nov 30, 2025 at 10:00 PM
-- Server version: 8.0.44
-- PHP Version: 8.3.26

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `tunevote`
--

-- --------------------------------------------------------

--
-- Table structure for table `guest_users`
--

CREATE TABLE `guest_users` (
  `id` int NOT NULL,
  `guest_token` char(36) NOT NULL,
  `nickname` varchar(50) DEFAULT 'Gast',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `playback_sync`
--

CREATE TABLE `playback_sync` (
  `session_id` int NOT NULL,
  `current_video_id` varchar(11) DEFAULT NULL,
  `progress_seconds` float DEFAULT '0',
  `is_playing` tinyint(1) DEFAULT '0',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `video_start_time` bigint DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `playback_sync`
--



-- --------------------------------------------------------

--
-- Table structure for table `queue_items`
--

CREATE TABLE `queue_items` (
  `id` int NOT NULL,
  `session_id` int NOT NULL,
  `video_id` varchar(20) DEFAULT NULL,
  `title` varchar(150) NOT NULL,
  `thumbnail` varchar(255) DEFAULT NULL,
  `added_by` int DEFAULT NULL,
  `guest_id` int DEFAULT NULL,
  `status` enum('queued','playing','played','skipped','archived','suggested') DEFAULT 'queued',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `played` tinyint(1) DEFAULT '0',
  `playedAt` datetime DEFAULT NULL,
  `startedAt` datetime DEFAULT NULL,
  `duration` int DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `item_type` enum('music','pause') NOT NULL DEFAULT 'music',
  `item_source` enum('user','guest','ai') DEFAULT 'user',
  `voting_round_id` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `queue_items`
--



-- --------------------------------------------------------

--
-- Table structure for table `sessions`
--

CREATE TABLE `sessions` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `title` varchar(100) NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `ended_at` timestamp NULL DEFAULT NULL,
  `is_live` tinyint(1) DEFAULT '0',
  `is_private` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `sessions`
--



-- --------------------------------------------------------

--
-- Table structure for table `session_invites`
--

CREATE TABLE `session_invites` (
  `id` int NOT NULL,
  `session_id` int NOT NULL,
  `invited_by_user_id` int NOT NULL,
  `email` varchar(255) NOT NULL,
  `invited_user_id` int DEFAULT NULL,
  `status` enum('pending','accepted','rejected','revoked') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL,
  `accepted_at` timestamp NULL DEFAULT NULL,
  `rejected_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `session_invites`
--



-- --------------------------------------------------------

--
-- Table structure for table `session_participants`
--

CREATE TABLE `session_participants` (
  `id` int NOT NULL,
  `session_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `guest_id` int DEFAULT NULL,
  `role` enum('host','user','guest') NOT NULL,
  `joined_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `is_live` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `session_participants`
--



-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int NOT NULL,
  `username` varchar(50) NOT NULL,
  `email` varchar(100) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `reset_token` varchar(64) DEFAULT NULL,
  `reset_token_expiry` datetime DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `users`
--



-- --------------------------------------------------------

--
-- Table structure for table `votes`
--

CREATE TABLE `votes` (
  `id` int NOT NULL,
  `queue_item_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `guest_id` int DEFAULT NULL,
  `vote` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `voting_rounds`
--

CREATE TABLE `voting_rounds` (
  `id` int NOT NULL,
  `session_id` int NOT NULL,
  `started_by_user_id` int DEFAULT NULL,
  `started_by_guest_id` int DEFAULT NULL,
  `started_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `ends_at` timestamp NULL DEFAULT NULL,
  `phase` enum('suggestion','voting','closed') DEFAULT 'suggestion',
  `phase_ends_at` datetime DEFAULT NULL,
  `suggestion_duration` int DEFAULT '90',
  `voting_duration` int DEFAULT '60',
  `max_suggestions` int DEFAULT '10',
  `status` enum('open','closed','computed') DEFAULT 'open',
  `winner_queue_item_id` int DEFAULT NULL,
  `quorum_percent` float DEFAULT '0.66',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `youtube_video_cache`
--

CREATE TABLE `youtube_video_cache` (
  `id` int NOT NULL,
  `youtube_id` varchar(255) NOT NULL,
  `title` varchar(255) NOT NULL,
  `title_norm` varchar(255) NOT NULL,
  `duration` int DEFAULT NULL,
  `thumbnail` text,
  `cached_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `youtube_video_cache`
--


--
-- Indexes for dumped tables
--

--
-- Indexes for table `guest_users`
--
ALTER TABLE `guest_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guest_token` (`guest_token`);

--
-- Indexes for table `playback_sync`
--
ALTER TABLE `playback_sync`
  ADD PRIMARY KEY (`session_id`),
  ADD KEY `playback_sync_ibfk_2` (`current_video_id`);

--
-- Indexes for table `queue_items`
--
ALTER TABLE `queue_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `session_video` (`session_id`,`video_id`),
  ADD KEY `added_by` (`added_by`),
  ADD KEY `guest_id` (`guest_id`);

--
-- Indexes for table `sessions`
--
ALTER TABLE `sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `session_invites`
--
ALTER TABLE `session_invites`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_invite` (`session_id`,`email`),
  ADD KEY `idx_invited_user` (`invited_user_id`),
  ADD KEY `idx_invited_by` (`invited_by_user_id`),
  ADD KEY `idx_session` (`session_id`),
  ADD KEY `idx_status` (`status`);

--
-- Indexes for table `session_participants`
--
ALTER TABLE `session_participants`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_participant` (`session_id`,`user_id`),
  ADD UNIQUE KEY `unique_guest` (`session_id`,`guest_id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `guest_id` (`guest_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `votes`
--
ALTER TABLE `votes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_vote_user` (`queue_item_id`,`user_id`),
  ADD UNIQUE KEY `unique_vote_guest` (`queue_item_id`,`guest_id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `guest_id` (`guest_id`);

--
-- Indexes for table `voting_rounds`
--
ALTER TABLE `voting_rounds`
  ADD PRIMARY KEY (`id`),
  ADD KEY `session_id` (`session_id`);

--
-- Indexes for table `youtube_video_cache`
--
ALTER TABLE `youtube_video_cache`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `youtube_id` (`youtube_id`),
  ADD UNIQUE KEY `title_norm` (`title_norm`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `guest_users`
--
ALTER TABLE `guest_users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `queue_items`
--
ALTER TABLE `queue_items`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=17;

--
-- AUTO_INCREMENT for table `sessions`
--
ALTER TABLE `sessions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `session_invites`
--
ALTER TABLE `session_invites`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `session_participants`
--
ALTER TABLE `session_participants`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `votes`
--
ALTER TABLE `votes`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `voting_rounds`
--
ALTER TABLE `voting_rounds`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `youtube_video_cache`
--
ALTER TABLE `youtube_video_cache`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=39657;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `playback_sync`
--
ALTER TABLE `playback_sync`
  ADD CONSTRAINT `playback_sync_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `playback_sync_ibfk_2` FOREIGN KEY (`current_video_id`) REFERENCES `youtube_video_cache` (`youtube_id`) ON DELETE SET NULL;

--
-- Constraints for table `queue_items`
--
ALTER TABLE `queue_items`
  ADD CONSTRAINT `queue_items_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `queue_items_ibfk_2` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `queue_items_ibfk_3` FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `sessions`
--
ALTER TABLE `sessions`
  ADD CONSTRAINT `sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `session_invites`
--
ALTER TABLE `session_invites`
  ADD CONSTRAINT `session_invites_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_invites_ibfk_2` FOREIGN KEY (`invited_by_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_invites_ibfk_3` FOREIGN KEY (`invited_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `session_participants`
--
ALTER TABLE `session_participants`
  ADD CONSTRAINT `session_participants_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_participants_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_participants_ibfk_3` FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `votes`
--
ALTER TABLE `votes`
  ADD CONSTRAINT `votes_ibfk_1` FOREIGN KEY (`queue_item_id`) REFERENCES `queue_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `votes_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `votes_ibfk_3` FOREIGN KEY (`guest_id`) REFERENCES `guest_users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `voting_rounds`
--
ALTER TABLE `voting_rounds`
  ADD CONSTRAINT `voting_rounds_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;