/**
 * Reconciliation migration — brings a database matching prod.sql or
 * daddy.sql (or anything in between) into alignment with the canonical
 * init.sql.
 *
 * Designed to be IDEMPOTENT and SAFE to run on populated production data.
 * Every step:
 *   - Checks INFORMATION_SCHEMA before mutating, so re-running is a no-op.
 *   - Validates data preconditions before any column type narrowing.
 *   - Uses ON DELETE clauses identical to init.sql.
 *
 * What this does NOT do (deferred to later phases of the audit):
 *   - Add the FK from queue_items.video_id to youtube_video_cache.youtube_id.
 *   - Drop denormalized columns (queue_items.title/thumbnail/duration).
 *   - Add CHECK constraints for user_id/guest_id mutual exclusion.
 *   - Collapse sessions.is_active/is_live/ended_at into a single state column.
 *
 * Run as part of `npm run migrate:latest` AFTER you have either applied the
 * baseline (fresh DB) or marked it baseline-applied (existing DB).
 */

const DB = (knex) => knex.client.config.connection.database;

// ---- INFORMATION_SCHEMA helpers (all parameterized) -------------------------

async function tableExists(knex, table) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [DB(knex), table],
  );
  return rows.length > 0;
}

async function columnInfo(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB(knex), table, column],
  );
  return rows[0] || null;
}

async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB(knex), table, indexName],
  );
  return rows.length > 0;
}

async function fkExists(knex, table, constraintName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [DB(knex), table, constraintName],
  );
  return rows.length > 0;
}

async function assertColumnFitsVarcharLen(knex, table, column, maxLen) {
  // Returns nothing on success; throws with a clear message if any value
  // would not fit into VARCHAR(maxLen). Skipped if the table or column
  // does not exist yet.
  if (!(await tableExists(knex, table))) return;
  if (!(await columnInfo(knex, table, column))) return;
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS bad
       FROM \`${table}\`
      WHERE \`${column}\` IS NOT NULL
        AND CHAR_LENGTH(\`${column}\`) > ?`,
    [maxLen],
  );
  if (rows[0].bad > 0) {
    throw new Error(
      `[reconcile] Cannot narrow ${table}.${column} to VARCHAR(${maxLen}): ` +
        `${rows[0].bad} row(s) contain longer values. Investigate before re-running.`,
    );
  }
}

// ---- Migration --------------------------------------------------------------

exports.up = async function up(knex) {
  // 1. ARTISTS — must exist before youtube_video_cache.artist_id can FK to it.
  if (!(await tableExists(knex, "artists"))) {
    await knex.raw(`
      CREATE TABLE artists (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        name_norm VARCHAR(255) NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        channel_id VARCHAR(255) DEFAULT NULL UNIQUE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // 2. YOUTUBE_VIDEO_CACHE — drop spurious title_norm UNIQUE, narrow youtube_id
  //    to VARCHAR(11), add nullable artist_id + FK.
  if (await tableExists(knex, "youtube_video_cache")) {
    if (await indexExists(knex, "youtube_video_cache", "title_norm")) {
      await knex.raw(
        `ALTER TABLE youtube_video_cache DROP INDEX title_norm`,
      );
    }

    const yid = await columnInfo(knex, "youtube_video_cache", "youtube_id");
    if (yid && !/^varchar\(11\)/i.test(yid.COLUMN_TYPE)) {
      await assertColumnFitsVarcharLen(
        knex,
        "youtube_video_cache",
        "youtube_id",
        11,
      );
      await knex.raw(
        `ALTER TABLE youtube_video_cache
           MODIFY COLUMN youtube_id VARCHAR(11) NOT NULL`,
      );
    }

    if (!(await columnInfo(knex, "youtube_video_cache", "artist_id"))) {
      await knex.raw(
        `ALTER TABLE youtube_video_cache
           ADD COLUMN artist_id INT NULL AFTER title_norm`,
      );
    }
    if (!(await fkExists(knex, "youtube_video_cache", "youtube_video_cache_ibfk_1"))) {
      await knex.raw(
        `ALTER TABLE youtube_video_cache
           ADD CONSTRAINT youtube_video_cache_ibfk_1
           FOREIGN KEY (artist_id) REFERENCES artists(id)`,
      );
    }
  }

  // 3. PLAYBACK_HISTORY — table is missing in prod/daddy.
  if (!(await tableExists(knex, "playback_history"))) {
    await knex.raw(`
      CREATE TABLE playback_history (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        youtube_id VARCHAR(11),
        session_id INT NULL,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
        FOREIGN KEY (youtube_id) REFERENCES youtube_video_cache(youtube_id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // 4. QUEUE_ITEMS.video_id — narrow VARCHAR(20) → VARCHAR(11) (prod/daddy).
  if (await tableExists(knex, "queue_items")) {
    const vid = await columnInfo(knex, "queue_items", "video_id");
    if (vid && !/^varchar\(11\)/i.test(vid.COLUMN_TYPE)) {
      await assertColumnFitsVarcharLen(knex, "queue_items", "video_id", 11);
      await knex.raw(
        `ALTER TABLE queue_items
           MODIFY COLUMN video_id VARCHAR(11) DEFAULT NULL`,
      );
    }
  }

  // 5. PLAYBACK_SYNC.current_video_id — narrow → VARCHAR(11) (only daddy
  //    has VARCHAR(20)) and ensure FK to youtube_video_cache exists.
  if (await tableExists(knex, "playback_sync")) {
    const cur = await columnInfo(knex, "playback_sync", "current_video_id");
    if (cur && !/^varchar\(11\)/i.test(cur.COLUMN_TYPE)) {
      await assertColumnFitsVarcharLen(
        knex,
        "playback_sync",
        "current_video_id",
        11,
      );
      await knex.raw(
        `ALTER TABLE playback_sync
           MODIFY COLUMN current_video_id VARCHAR(11) DEFAULT NULL`,
      );
    }
    if (!(await fkExists(knex, "playback_sync", "playback_sync_ibfk_2"))) {
      // Clean any orphans before adding the constraint, otherwise the ALTER
      // will fail. SET NULL semantics mean: if the row would have referenced
      // a missing cache entry, null it out now.
      await knex.raw(`
        UPDATE playback_sync ps
           LEFT JOIN youtube_video_cache yvc
                  ON yvc.youtube_id = ps.current_video_id
            SET ps.current_video_id = NULL
          WHERE ps.current_video_id IS NOT NULL
            AND yvc.youtube_id IS NULL
      `);
      await knex.raw(`
        ALTER TABLE playback_sync
          ADD CONSTRAINT playback_sync_ibfk_2
          FOREIGN KEY (current_video_id)
          REFERENCES youtube_video_cache(youtube_id)
          ON DELETE SET NULL
      `);
    }
  }

  // 6. VOTING_ROUNDS.phase — daddy uses 'suggesting'; canonical is 'suggestion'.
  if (await tableExists(knex, "voting_rounds")) {
    const phase = await columnInfo(knex, "voting_rounds", "phase");
    if (phase && /'suggesting'/i.test(phase.COLUMN_TYPE)) {
      // Step A: add 'suggestion' to the enum so both values are temporarily valid.
      await knex.raw(`
        ALTER TABLE voting_rounds
          MODIFY COLUMN phase
          ENUM('suggesting','suggestion','voting','closed') NOT NULL DEFAULT 'suggestion'
      `);
      // Step B: rewrite data.
      await knex.raw(
        `UPDATE voting_rounds SET phase = 'suggestion' WHERE phase = 'suggesting'`,
      );
      // Step C: drop 'suggesting' from the enum.
      await knex.raw(`
        ALTER TABLE voting_rounds
          MODIFY COLUMN phase
          ENUM('suggestion','voting','closed') NOT NULL DEFAULT 'suggestion'
      `);
    } else if (phase && !/'suggestion'/i.test(phase.COLUMN_TYPE)) {
      // Defensive: phase column exists but in some other shape we don't
      // recognise. Don't silently mutate — bail loudly.
      throw new Error(
        `[reconcile] voting_rounds.phase has unexpected type ${phase.COLUMN_TYPE}; ` +
          `manual investigation required before reconciliation can continue.`,
      );
    } else if (phase) {
      // Already canonical 'suggestion' enum. Make sure default is set.
      await knex.raw(`
        ALTER TABLE voting_rounds
          MODIFY COLUMN phase
          ENUM('suggestion','voting','closed') NOT NULL DEFAULT 'suggestion'
      `);
    }
  }

  // 7. SESSION_PARTICIPANTS.left_at — present in init, missing in prod/daddy.
  if (
    (await tableExists(knex, "session_participants")) &&
    !(await columnInfo(knex, "session_participants", "left_at"))
  ) {
    await knex.raw(
      `ALTER TABLE session_participants
         ADD COLUMN left_at TIMESTAMP NULL AFTER joined_at`,
    );
  }

  // 8. USERS.imageType / imageData — present in init, missing in prod/daddy.
  if (await tableExists(knex, "users")) {
    if (!(await columnInfo(knex, "users", "imageType"))) {
      await knex.raw(
        `ALTER TABLE users ADD COLUMN imageType VARCHAR(255) AFTER updated_at`,
      );
    }
    if (!(await columnInfo(knex, "users", "imageData"))) {
      await knex.raw(
        `ALTER TABLE users ADD COLUMN imageData LONGBLOB AFTER imageType`,
      );
    }
  }

  // 9. SESSION_INVITES.unique_invite — present in init/prod, missing in daddy.
  if (
    (await tableExists(knex, "session_invites")) &&
    !(await indexExists(knex, "session_invites", "unique_invite"))
  ) {
    // Pre-check for duplicates that would block the unique index.
    const [dupes] = await knex.raw(`
      SELECT session_id, email, COUNT(*) AS c
        FROM session_invites
       GROUP BY session_id, email
      HAVING c > 1
       LIMIT 1
    `);
    if (dupes.length > 0) {
      throw new Error(
        `[reconcile] session_invites contains duplicate (session_id, email) ` +
          `rows; cannot add UNIQUE KEY unique_invite. Resolve duplicates first.`,
      );
    }
    await knex.raw(
      `ALTER TABLE session_invites ADD UNIQUE KEY unique_invite (session_id, email)`,
    );
  }

  // 10. SESSION_SONG_LISTENS — missing in prod/daddy.
  if (!(await tableExists(knex, "session_song_listens"))) {
    await knex.raw(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // 11. BADGES + USER_BADGES + USER_BADGE_PROGRESS — missing in prod/daddy.
  if (!(await tableExists(knex, "badges"))) {
    await knex.raw(`
      CREATE TABLE badges (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        key_name VARCHAR(50) NOT NULL UNIQUE,
        title VARCHAR(100) NOT NULL,
        description VARCHAR(255) NOT NULL,
        category ENUM(
          'progression','listener','host','social','engagement','special'
        ) NOT NULL,
        icon VARCHAR(100) DEFAULT NULL,
        color VARCHAR(20) DEFAULT NULL,
        rarity ENUM('common','uncommon','rare','epic','legendary') DEFAULT 'common',
        is_hidden TINYINT(1) DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        available_from DATETIME DEFAULT NULL,
        available_until DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    // Seed canonical badge set (matches init.sql).
    await knex("badges").insert([
      { key_name: "beginner", title: "Beginner", description: "Erste Session gehört", category: "progression", icon: "🌱" },
      { key_name: "regular", title: "Regular", description: "10 Sessions gehört", category: "progression", icon: "🎧" },
      { key_name: "legend", title: "Legende", description: "100 Sessions gehört", category: "progression", icon: "🏆" },
      { key_name: "first_listen", title: "First Listen", description: "Ersten Song gehört", category: "listener", icon: "▶️" },
      { key_name: "music_lover", title: "Music Lover", description: "500 Minuten Musik gehört", category: "listener", icon: "❤️" },
      { key_name: "marathon", title: "Marathon", description: "2 Stunden in einer Session gehört", category: "listener", icon: "⏱️" },
      { key_name: "first_host", title: "First Session", description: "Erste Session erstellt", category: "host", icon: "🎤" },
      { key_name: "session_master", title: "Session Master", description: "10 Sessions erstellt", category: "host", icon: "🎚️" },
      { key_name: "crowd_host", title: "Crowd Host", description: "Session mit 5 Hörern", category: "host", icon: "👥" },
      { key_name: "voter", title: "Voter", description: "10 Votes abgegeben", category: "social", icon: "👍" },
      { key_name: "trendsetter", title: "Trendsetter", description: "Eigener Song 5× gehört", category: "social", icon: "🔥" },
      { key_name: "collaborator", title: "Collaborator", description: "5 gemeinsame Sessions", category: "social", icon: "🤝" },
    ]);
  }

  if (!(await tableExists(knex, "user_badges"))) {
    await knex.raw(`
      CREATE TABLE user_badges (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        badge_id INT NOT NULL,
        awarded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_badge (user_id, badge_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await tableExists(knex, "user_badge_progress"))) {
    await knex.raw(`
      CREATE TABLE user_badge_progress (
        user_id INT NOT NULL,
        badge_id INT NOT NULL,
        current_value INT NOT NULL,
        target_value INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, badge_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // 12. SHOUTS + SHOUT_LIKES — missing in prod/daddy.
  if (!(await tableExists(knex, "shouts"))) {
    await knex.raw(`
      CREATE TABLE shouts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        artist_id INT NOT NULL,
        user_id INT NOT NULL,
        parent_id INT DEFAULT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        is_deleted TINYINT(1) DEFAULT 0,
        deleted_at DATETIME DEFAULT NULL,
        FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES shouts(id) ON DELETE CASCADE,
        INDEX idx_artist (artist_id),
        INDEX idx_parent (parent_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  if (!(await tableExists(knex, "shout_likes"))) {
    await knex.raw(`
      CREATE TABLE shout_likes (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        shout_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_like (shout_id, user_id),
        FOREIGN KEY (shout_id) REFERENCES shouts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
};

exports.down = async function down(/* knex */) {
  // No automatic rollback. Reconciliation creates tables that may have
  // accumulated production data (badges, listens, shouts, artists). Tearing
  // them out blindly would lose data. Roll back manually only if needed.
  throw new Error(
    "Reconciliation migration is one-way. To undo, restore from backup.",
  );
};
