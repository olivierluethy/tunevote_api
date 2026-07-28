/**
 * Shout reactions (like/dislike) + edit support.
 *
 *   shout_likes.value  — 1 = like (thumbs up), -1 = dislike (thumbs down).
 *                        Existing rows default to 1, so they stay likes.
 *                        The UNIQUE(shout_id,user_id) means one reaction per
 *                        user per shout, switchable/toggleable.
 *   shouts.is_edited   — set to 1 when the author edits the message.
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
  if (!(await columnExists(knex, "shout_likes", "value"))) {
    await knex.raw(
      `ALTER TABLE shout_likes ADD COLUMN value TINYINT NOT NULL DEFAULT 1`,
    );
  }
  if (!(await columnExists(knex, "shouts", "is_edited"))) {
    await knex.raw(
      `ALTER TABLE shouts ADD COLUMN is_edited TINYINT(1) NOT NULL DEFAULT 0`,
    );
  }
};

exports.down = async function down() {
  throw new Error(
    "shout-reactions-and-edit migration is one-way. " +
      "Restore from backup to roll back.",
  );
};
