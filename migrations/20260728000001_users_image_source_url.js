/**
 * Add users.image_source_url.
 *
 *   image_source_url — when a profile picture is set from a web URL (rather than
 *                      an uploaded file), this remembers where it came from so the
 *                      edit UI can show "picture from <url>". NULL means the
 *                      picture was uploaded (or there is none).
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
  if (!(await columnExists(knex, "users", "image_source_url"))) {
    await knex.raw(
      `ALTER TABLE users ADD COLUMN image_source_url VARCHAR(1024) DEFAULT NULL`,
    );
  }
};

exports.down = async function down() {
  throw new Error(
    "users-image-source-url migration is one-way. " +
      "Restore from backup to roll back.",
  );
};
