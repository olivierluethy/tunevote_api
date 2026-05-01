/**
 * Baseline migration — represents the canonical init.sql schema.
 *
 * Two execution modes:
 *
 *   1. FRESH DATABASE: run `npm run migrate:latest`. This migration executes
 *      init.sql verbatim and the database starts in the canonical state.
 *
 *   2. EXISTING DATABASE (production, dev that already has tables): run
 *      `npm run migrate:mark-baseline` FIRST. That script inserts a row into
 *      knex_migrations claiming this baseline is already applied, so it is
 *      skipped. Then run `npm run migrate:latest` to apply only the
 *      reconciliation migration on top of the existing schema.
 *
 * This split is necessary because Knex has no native "fake" command. Mixing
 * the two would re-CREATE existing tables and fail.
 */

const fs = require("fs");
const path = require("path");

exports.up = async function up(knex) {
  const sqlPath = path.resolve(__dirname, "..", "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  // init.sql contains multiple statements. The connection in knexfile.js
  // sets multipleStatements: true so this runs as a single batch.
  await knex.raw(sql);
};

exports.down = async function down(knex) {
  // Drop in reverse-dependency order. Foreign keys would block a naive drop
  // sequence, so we disable FK checks for the duration of the rollback.
  await knex.raw("SET FOREIGN_KEY_CHECKS = 0");
  const tables = [
    "shout_likes",
    "shouts",
    "user_badge_progress",
    "user_badges",
    "badges",
    "session_song_listens",
    "voting_rounds",
    "votes",
    "playback_sync",
    "queue_items",
    "session_participants",
    "session_invites",
    "playback_history",
    "sessions",
    "youtube_video_cache",
    "artists",
    "guest_users",
    "users",
  ];
  for (const t of tables) {
    await knex.raw(`DROP TABLE IF EXISTS \`${t}\``);
  }
  await knex.raw("SET FOREIGN_KEY_CHECKS = 1");
};
