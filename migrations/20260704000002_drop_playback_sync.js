/**
 * Drop the playback_sync table. "Now playing" + start time are now derived
 * from the queue_items row with status='playing' (video_id + startedAt), which
 * is the single source of truth. The /playback-sync endpoint derives the same
 * {current_video_id, video_start_time, is_playing} shape from that row.
 */
exports.up = async (knex) => {
  await knex.schema.dropTableIfExists("playback_sync");
};

exports.down = async (knex) => {
  await knex.raw(`CREATE TABLE playback_sync (
    session_id INT NOT NULL PRIMARY KEY,
    current_video_id VARCHAR(11) DEFAULT NULL,
    progress_seconds FLOAT DEFAULT 0,
    is_playing TINYINT(1) DEFAULT 0,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    video_start_time BIGINT DEFAULT NULL,
    CONSTRAINT playback_sync_ibfk_1 FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
};
