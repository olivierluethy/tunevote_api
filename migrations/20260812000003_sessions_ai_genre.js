/**
 * Add sessions.ai_genre — the host-chosen genre that steers AI recommendations
 * for the session (idea #39). NULL means "no preference" (random exploration).
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
  if (!(await columnExists(knex, "sessions", "ai_genre"))) {
    await knex.raw(`ALTER TABLE sessions ADD COLUMN ai_genre VARCHAR(40) NULL`);
  }
};

exports.down = async function down() {
  throw new Error(
    "sessions_ai_genre migration is one-way. Restore from backup to roll back.",
  );
};
