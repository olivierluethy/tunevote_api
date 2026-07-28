/**
 * Long public id (UUID) for sessions, so a session's share URL reads like a
 * ChatGPT conversation id instead of a small integer.
 *
 * The numeric `id` stays the internal identifier everywhere (API, sockets,
 * playback, emits); public_id is only the URL-facing id, resolved to the
 * numeric id on the way in. New rows get their public_id in POST /sessions
 * (UUID() in the INSERT) — no trigger (a trigger calling UUID() needs SUPER
 * under binary logging).
 *
 * Idempotent — INFORMATION_SCHEMA-guarded.
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

async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB(knex), table, indexName],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await columnExists(knex, "sessions", "public_id"))) {
    await knex.raw(`ALTER TABLE sessions ADD COLUMN public_id CHAR(36) DEFAULT NULL`);
  }
  await knex.raw(`UPDATE sessions SET public_id = UUID() WHERE public_id IS NULL`);
  if (!(await indexExists(knex, "sessions", "uq_sessions_public_id"))) {
    await knex.raw(`ALTER TABLE sessions ADD UNIQUE KEY uq_sessions_public_id (public_id)`);
  }
};

exports.down = async function down() {
  throw new Error(
    "sessions-public-id migration is one-way. Restore from backup to roll back.",
  );
};
