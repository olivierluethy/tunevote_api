/**
 * Add youtube_video_cache.genre — the AI-assigned genre used by the host genre
 * selector (idea #39) and genre ranking (idea #43).
 *
 * Idempotent — guarded by INFORMATION_SCHEMA so re-runs are no-ops.
 */

const DB = (knex) => knex.client.config.connection.database;

async function columnExists(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB(knex), table, column],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await columnExists(knex, "youtube_video_cache", "genre"))) {
    await knex.raw(
      `ALTER TABLE youtube_video_cache ADD COLUMN genre VARCHAR(40) NULL`,
    );
  }
};

exports.down = async function down() {
  throw new Error(
    "genre_column migration is one-way. Restore from backup to roll back.",
  );
};
