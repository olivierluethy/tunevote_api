/**
 * Phase 2 — Normalize queue_items.
 *
 * Five idempotent steps, every one guarded by INFORMATION_SCHEMA so re-runs
 * are no-ops. Same pattern as the Phase 1 reconciliation migration.
 *
 *   1. Add FK queue_items.video_id → youtube_video_cache.youtube_id
 *      (ON DELETE RESTRICT). Backfills cache from queue row metadata if
 *      possible, aborts loudly if not.
 *
 *   2. Rename queue_items.duration → pause_duration_seconds and NULL it for
 *      music rows. Logs cache/queue duration mismatches but does not abort —
 *      the cache is authoritative going forward.
 *
 *   3. Drop queue_items.title, queue_items.thumbnail, queue_items.played.
 *      Aborts if any row has played=1 XOR status='played' (drift indicator
 *      that needs human review before destroying the column).
 *
 *   4. Add CHECK constraint enforcing the music/pause column population rules.
 *      Pre-validates so the constraint creation itself can never fail.
 *
 *   5. Add indexes (session_id, status), (voting_round_id, status), (status).
 *
 * down() throws — to roll back, restore from backup. Dropping FKs and
 * recreating dropped columns would lose data.
 */

const DB = (knex) => knex.client.config.connection.database;

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
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
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

async function checkConstraintExists(knex, table, constraintName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' LIMIT 1`,
    [DB(knex), table, constraintName],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await tableExists(knex, "queue_items"))) {
    throw new Error("[phase2] queue_items table missing — run Phase 1 first");
  }
  if (!(await tableExists(knex, "youtube_video_cache"))) {
    throw new Error(
      "[phase2] youtube_video_cache missing — run Phase 1 first",
    );
  }

  // =========================================================================
  // STEP 1 — Add FK queue_items.video_id → youtube_video_cache.youtube_id.
  // =========================================================================
  if (!(await fkExists(knex, "queue_items", "queue_items_ibfk_4"))) {
    // 1a. Find rows that violate the FK we are about to add.
    //     Only music rows can have a video_id (pause rows are NULL by
    //     contract; if a pause row somehow has a video_id, it's a data bug
    //     we want to know about, but it can still be backfilled).
    const [orphans] = await knex.raw(`
      SELECT qi.id, qi.video_id, qi.title, qi.thumbnail, qi.duration,
             qi.item_type
        FROM queue_items qi
        LEFT JOIN youtube_video_cache yvc
               ON yvc.youtube_id = qi.video_id
       WHERE qi.video_id IS NOT NULL
         AND yvc.youtube_id IS NULL
    `);

    // 1b. Try to backfill the cache from the orphan's stored metadata.
    //     Required: a 11-char video_id and at least a non-empty title.
    const unfixable = [];
    for (const row of orphans) {
      const vid = (row.video_id || "").trim();
      const title = (row.title || "").trim();
      if (vid.length !== 11 || title.length === 0) {
        unfixable.push({
          id: row.id,
          video_id: row.video_id,
          reason:
            vid.length !== 11
              ? `video_id length ${vid.length}`
              : "missing title — cannot reconstruct cache row",
        });
        continue;
      }
      const titleNorm = title
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      try {
        await knex.raw(
          `INSERT INTO youtube_video_cache
             (youtube_id, title, title_norm, thumbnail, duration)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             title = VALUES(title),
             title_norm = VALUES(title_norm),
             thumbnail = COALESCE(VALUES(thumbnail), thumbnail),
             duration = COALESCE(VALUES(duration), duration)`,
          [vid, title, titleNorm, row.thumbnail || null, row.duration || null],
        );
      } catch (err) {
        unfixable.push({ id: row.id, video_id: vid, reason: err.message });
      }
    }
    if (unfixable.length > 0) {
      const detail = unfixable
        .slice(0, 25)
        .map((u) => `  queue_items.id=${u.id} video_id=${u.video_id}: ${u.reason}`)
        .join("\n");
      const more =
        unfixable.length > 25 ? `\n  ...and ${unfixable.length - 25} more` : "";
      throw new Error(
        `[phase2 step 1] Cannot add FK queue_items.video_id → ` +
          `youtube_video_cache.youtube_id: ${unfixable.length} orphan ` +
          `row(s) could not be backfilled.\n${detail}${more}\n` +
          `Resolve manually (delete the rows or repair video_id) and re-run.`,
      );
    }

    // 1c. Add the FK. Pause rows keep video_id IS NULL — that's allowed.
    await knex.raw(`
      ALTER TABLE queue_items
        ADD CONSTRAINT queue_items_ibfk_4
        FOREIGN KEY (video_id)
        REFERENCES youtube_video_cache(youtube_id)
        ON DELETE RESTRICT
    `);
  }

  // =========================================================================
  // STEP 2 — Rename duration → pause_duration_seconds, NULL it for music rows.
  // =========================================================================
  const durationCol = await columnInfo(knex, "queue_items", "duration");
  const pauseCol = await columnInfo(
    knex,
    "queue_items",
    "pause_duration_seconds",
  );

  if (durationCol && !pauseCol) {
    // 2a. Log mismatches between qi.duration and yvc.duration for music rows.
    //     Don't abort — cache is authoritative once we drop qi.duration.
    const [mismatches] = await knex.raw(`
      SELECT qi.id, qi.video_id,
             qi.duration   AS queue_duration,
             yvc.duration  AS cache_duration
        FROM queue_items qi
        JOIN youtube_video_cache yvc
          ON yvc.youtube_id = qi.video_id
       WHERE qi.item_type = 'music'
         AND qi.duration IS NOT NULL
         AND yvc.duration IS NOT NULL
         AND qi.duration <> yvc.duration
       LIMIT 50
    `);
    if (mismatches.length > 0) {
      console.warn(
        `[phase2 step 2] ${mismatches.length} music row(s) have ` +
          `qi.duration ≠ yvc.duration. Cache value will be authoritative.`,
      );
      for (const m of mismatches.slice(0, 10)) {
        console.warn(
          `  id=${m.id} video_id=${m.video_id}: queue=${m.queue_duration}s, cache=${m.cache_duration}s`,
        );
      }
    }

    // 2b. Rename. CHANGE COLUMN re-types in place.
    await knex.raw(`
      ALTER TABLE queue_items
        CHANGE COLUMN duration pause_duration_seconds INT DEFAULT NULL
    `);

    // 2c. NULL it out for music rows. Pause rows keep their value.
    await knex.raw(`
      UPDATE queue_items
         SET pause_duration_seconds = NULL
       WHERE item_type = 'music'
         AND pause_duration_seconds IS NOT NULL
    `);
  } else if (durationCol && pauseCol) {
    // Partially-applied state: both columns exist. Bail loudly.
    throw new Error(
      `[phase2 step 2] queue_items has both duration and pause_duration_seconds ` +
        `columns; partial migration state. Resolve manually before re-running.`,
    );
  }

  // =========================================================================
  // STEP 3 — Drop title, thumbnail, played.
  // =========================================================================
  const playedCol = await columnInfo(knex, "queue_items", "played");
  if (playedCol) {
    // 3a. played = 1 ⟺ status = 'played'. Abort on drift.
    const [drift] = await knex.raw(`
      SELECT COUNT(*) AS cnt
        FROM queue_items
       WHERE (played = 1 AND status <> 'played')
          OR (played = 0 AND status = 'played')
    `);
    if (drift[0].cnt > 0) {
      const [examples] = await knex.raw(`
        SELECT id, status, played
          FROM queue_items
         WHERE (played = 1 AND status <> 'played')
            OR (played = 0 AND status = 'played')
         LIMIT 10
      `);
      const lines = examples
        .map((r) => `  id=${r.id} status=${r.status} played=${r.played}`)
        .join("\n");
      throw new Error(
        `[phase2 step 3] ${drift[0].cnt} queue_items row(s) have ` +
          `played ≠ (status='played'). Cannot drop the played column safely.\n` +
          `Sample rows:\n${lines}\n` +
          `Resolve drift (UPDATE either status or played to align) and re-run.`,
      );
    }
    await knex.raw(`ALTER TABLE queue_items DROP COLUMN played`);
  }

  if (await columnInfo(knex, "queue_items", "title")) {
    await knex.raw(`ALTER TABLE queue_items DROP COLUMN title`);
  }
  if (await columnInfo(knex, "queue_items", "thumbnail")) {
    await knex.raw(`ALTER TABLE queue_items DROP COLUMN thumbnail`);
  }

  // =========================================================================
  // STEP 4 — CHECK constraint for music/pause column population.
  // =========================================================================
  if (!(await checkConstraintExists(knex, "queue_items", "ck_queue_items_kind"))) {
    // 4a. Pre-validate — the ALTER will succeed iff every existing row
    //     satisfies the predicate.
    const [bad] = await knex.raw(`
      SELECT COUNT(*) AS cnt
        FROM queue_items
       WHERE NOT (
         (item_type = 'music'
            AND video_id IS NOT NULL
            AND pause_duration_seconds IS NULL)
         OR
         (item_type = 'pause'
            AND video_id IS NULL
            AND pause_duration_seconds IS NOT NULL)
       )
    `);
    if (bad[0].cnt > 0) {
      const [examples] = await knex.raw(`
        SELECT id, item_type, video_id, pause_duration_seconds
          FROM queue_items
         WHERE NOT (
           (item_type = 'music'
              AND video_id IS NOT NULL
              AND pause_duration_seconds IS NULL)
           OR
           (item_type = 'pause'
              AND video_id IS NULL
              AND pause_duration_seconds IS NOT NULL)
         )
         LIMIT 10
      `);
      const lines = examples
        .map(
          (r) =>
            `  id=${r.id} type=${r.item_type} video_id=${r.video_id} pause_dur=${r.pause_duration_seconds}`,
        )
        .join("\n");
      throw new Error(
        `[phase2 step 4] ${bad[0].cnt} queue_items row(s) violate the ` +
          `kind invariant. Cannot add CHECK constraint.\n` +
          `Sample rows:\n${lines}\n` +
          `Likely fix: pause rows missing pause_duration_seconds, or music ` +
          `rows missing video_id.`,
      );
    }
    await knex.raw(`
      ALTER TABLE queue_items
        ADD CONSTRAINT ck_queue_items_kind CHECK (
          (item_type = 'music'
             AND video_id IS NOT NULL
             AND pause_duration_seconds IS NULL)
          OR
          (item_type = 'pause'
             AND video_id IS NULL
             AND pause_duration_seconds IS NOT NULL)
        )
    `);
  }

  // =========================================================================
  // STEP 5 — Indexes recommended by audit section E9.
  // =========================================================================
  if (!(await indexExists(knex, "queue_items", "idx_session_status"))) {
    await knex.raw(
      `CREATE INDEX idx_session_status ON queue_items (session_id, status)`,
    );
  }
  if (!(await indexExists(knex, "queue_items", "idx_round_status"))) {
    await knex.raw(
      `CREATE INDEX idx_round_status ON queue_items (voting_round_id, status)`,
    );
  }
  if (!(await indexExists(knex, "queue_items", "idx_status"))) {
    await knex.raw(`CREATE INDEX idx_status ON queue_items (status)`);
  }
};

exports.down = async function down() {
  throw new Error(
    "Phase 2 migration is one-way (drops columns and adds RESTRICT FK). " +
      "Restore from backup to roll back.",
  );
};
