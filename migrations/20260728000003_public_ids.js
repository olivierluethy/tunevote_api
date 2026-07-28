/**
 * Long public IDs (UUID) for artists, users, and cached songs, so their page
 * URLs read like a ChatGPT conversation id instead of a small integer.
 *
 * - Adds `public_id CHAR(36)` (unique) to artists, users, youtube_video_cache.
 * - Backfills existing rows with UUID().
 *
 * New rows get their public_id set in application code (UUID() in the INSERT),
 * not a trigger — a trigger calling non-deterministic UUID() needs the SUPER
 * privilege under binary logging, which neither the local nor the managed DB
 * grants.
 *
 * The native integer ids (and youtube_id) are kept and still used internally;
 * public_id is only an additional, URL-facing identifier. Endpoints resolve
 * either form.
 *
 * Idempotent — INFORMATION_SCHEMA-guarded.
 */

const DB = (knex) => knex.client.config.connection.database;
const TABLES = ["artists", "users", "youtube_video_cache"];

async function columnExists(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB(knex), table, column],
  );
  return rows.length > 0;
}

async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB(knex), table, indexName],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await columnExists(knex, table, "public_id"))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN public_id CHAR(36) DEFAULT NULL`);
    }
    // Backfill any rows still missing a public_id (safe to re-run).
    await knex.raw(`UPDATE ${table} SET public_id = UUID() WHERE public_id IS NULL`);
    const idx = `uq_${table}_public_id`;
    if (!(await indexExists(knex, table, idx))) {
      await knex.raw(`ALTER TABLE ${table} ADD UNIQUE KEY ${idx} (public_id)`);
    }
  }
};

exports.down = async function down() {
  throw new Error(
    "public-ids migration is one-way. Restore from backup to roll back.",
  );
};
