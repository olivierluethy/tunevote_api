#!/usr/bin/env node
/**
 * verify-schema.js — regression check for canonical init.sql.
 *
 * Connects to the database described by knexfile.js and verifies that its
 * actual schema matches the canonical Phase 1 expectations:
 *   - All canonical tables exist.
 *   - Critical column types match (the ones touched by reconciliation).
 *   - Critical indexes / FKs exist (and the spurious ones don't).
 *
 * Exit code 0 = schema matches. Exit code 1 = drift detected (with report).
 *
 * This is a Phase 1 check. It deliberately does NOT yet enforce the FKs and
 * normalization changes that later phases of the audit will introduce.
 */

const knexLib = require("knex");
const config = require("../knexfile");

// ---------------------------------------------------------------------------
// Canonical expectations (Phase 1)
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = [
  "users",
  "guest_users",
  "artists",
  "youtube_video_cache",
  "sessions",
  "playback_history",
  "session_invites",
  "session_participants",
  "queue_items",
  "playback_sync",
  "votes",
  "voting_rounds",
  "session_song_listens",
  "badges",
  "user_badges",
  "user_badge_progress",
  "shouts",
  "shout_likes",
];

// Columns whose exact type the reconciliation is responsible for.
// Format: [table, column, expected COLUMN_TYPE regex]
const EXPECTED_COLUMN_TYPES = [
  ["youtube_video_cache", "youtube_id", /^varchar\(11\)$/i],
  ["queue_items", "video_id", /^varchar\(11\)$/i],
  ["playback_sync", "current_video_id", /^varchar\(11\)$/i],
  ["playback_history", "youtube_id", /^varchar\(11\)$/i],
  [
    "voting_rounds",
    "phase",
    /^enum\('suggestion','voting','closed'\)$/i,
  ],
  // Phase 2: renamed column.
  ["queue_items", "pause_duration_seconds", /^int(\(\d+\))?$/i],
];

// Columns that must exist (presence-only check).
const EXPECTED_COLUMNS_PRESENT = [
  ["session_participants", "left_at"],
  ["users", "imageType"],
  ["users", "imageData"],
  ["youtube_video_cache", "artist_id"],
];

// Columns that MUST NOT exist (Phase 2 dropped them from queue_items).
const FORBIDDEN_COLUMNS = [
  ["queue_items", "title"],
  ["queue_items", "thumbnail"],
  ["queue_items", "duration"], // renamed → pause_duration_seconds
  ["queue_items", "played"],
];

// Indexes that MUST exist.
const EXPECTED_INDEXES = [
  ["session_invites", "unique_invite"],
  ["youtube_video_cache", "youtube_id"], // unique on youtube_id
  // Phase 2 audit-recommended indexes.
  ["queue_items", "idx_session_status"],
  ["queue_items", "idx_round_status"],
  ["queue_items", "idx_status"],
];

// Indexes that MUST NOT exist (spurious in prod/daddy).
const FORBIDDEN_INDEXES = [
  ["youtube_video_cache", "title_norm"],
];

// FKs that MUST exist.
const EXPECTED_FKS = [
  ["youtube_video_cache", "youtube_video_cache_ibfk_1"], // artist_id → artists.id
  ["queue_items", "queue_items_ibfk_1"], // session_id → sessions.id
  ["playback_sync", "playback_sync_ibfk_2"], // current_video_id → youtube_video_cache.youtube_id
  // Phase 2 FK.
  ["queue_items", "queue_items_ibfk_4"], // video_id → youtube_video_cache.youtube_id
];

// CHECK constraints that MUST exist.
const EXPECTED_CHECKS = [
  ["queue_items", "ck_queue_items_kind"], // music ↔ video_id; pause ↔ pause_duration_seconds
];

// ---------------------------------------------------------------------------

async function getDB(knex) {
  return knex.client.config.connection.database;
}

async function listTables(knex, db) {
  const [rows] = await knex.raw(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [db],
  );
  return rows.map((r) => r.TABLE_NAME);
}

async function getColumn(knex, db, table, column) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [db, table, column],
  );
  return rows[0] || null;
}

async function hasIndex(knex, db, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [db, table, name],
  );
  return rows.length > 0;
}

async function hasFk(knex, db, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [db, table, name],
  );
  return rows.length > 0;
}

async function hasCheck(knex, db, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' LIMIT 1`,
    [db, table, name],
  );
  return rows.length > 0;
}

async function main() {
  const env = process.env.NODE_ENV || "development";
  const knex = knexLib(config[env]);
  const problems = [];

  try {
    const db = await getDB(knex);
    const present = new Set(await listTables(knex, db));

    // 1. Tables
    for (const t of EXPECTED_TABLES) {
      if (!present.has(t)) problems.push(`MISSING TABLE: ${t}`);
    }

    // 2. Column types
    for (const [t, c, re] of EXPECTED_COLUMN_TYPES) {
      if (!present.has(t)) continue;
      const info = await getColumn(knex, db, t, c);
      if (!info) {
        problems.push(`MISSING COLUMN: ${t}.${c}`);
      } else if (!re.test(info.COLUMN_TYPE)) {
        problems.push(
          `COLUMN TYPE MISMATCH: ${t}.${c} is "${info.COLUMN_TYPE}", ` +
            `expected to match ${re}`,
        );
      }
    }

    // 3. Column presence
    for (const [t, c] of EXPECTED_COLUMNS_PRESENT) {
      if (!present.has(t)) continue;
      const info = await getColumn(knex, db, t, c);
      if (!info) problems.push(`MISSING COLUMN: ${t}.${c}`);
    }

    // 3b. Forbidden columns (Phase 2 dropped these).
    for (const [t, c] of FORBIDDEN_COLUMNS) {
      if (!present.has(t)) continue;
      const info = await getColumn(knex, db, t, c);
      if (info) {
        problems.push(`FORBIDDEN COLUMN PRESENT: ${t}.${c} (drop it)`);
      }
    }

    // 4. Indexes
    for (const [t, idx] of EXPECTED_INDEXES) {
      if (!present.has(t)) continue;
      if (!(await hasIndex(knex, db, t, idx))) {
        problems.push(`MISSING INDEX: ${t}.${idx}`);
      }
    }
    for (const [t, idx] of FORBIDDEN_INDEXES) {
      if (!present.has(t)) continue;
      if (await hasIndex(knex, db, t, idx)) {
        problems.push(`FORBIDDEN INDEX PRESENT: ${t}.${idx} (drop it)`);
      }
    }

    // 5. Foreign keys
    for (const [t, name] of EXPECTED_FKS) {
      if (!present.has(t)) continue;
      if (!(await hasFk(knex, db, t, name))) {
        problems.push(`MISSING FOREIGN KEY: ${t}.${name}`);
      }
    }

    // 6. CHECK constraints
    for (const [t, name] of EXPECTED_CHECKS) {
      if (!present.has(t)) continue;
      if (!(await hasCheck(knex, db, t, name))) {
        problems.push(`MISSING CHECK CONSTRAINT: ${t}.${name}`);
      }
    }

    if (problems.length === 0) {
      console.log(`OK — schema matches canonical init.sql (Phase 1).`);
      process.exit(0);
    }

    console.error(`FAIL — ${problems.length} schema drift item(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error("verify-schema crashed:", err);
  process.exit(2);
});
