/**
 * Extend session_participants.role with 'co-host' (idea #24).
 *
 * Existing ENUM: ('host','user','guest'). New ENUM adds 'co-host'. Widening an
 * ENUM with an extra value never rewrites existing rows. Guarded so re-runs are
 * no-ops.
 */

const DB = (knex) => knex.client.config.connection.database;

async function enumHasValue(knex, table, column, value) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB(knex), table, column],
  );
  return rows.length > 0 && String(rows[0].t).includes(`'${value}'`);
}

exports.up = async function up(knex) {
  if (!(await enumHasValue(knex, "session_participants", "role", "co-host"))) {
    await knex.raw(
      `ALTER TABLE session_participants
         MODIFY COLUMN role ENUM('host','co-host','user','guest') NOT NULL`,
    );
  }
};

exports.down = async function down() {
  throw new Error(
    "participants_cohost_role migration is one-way. " +
      "Restore from backup to roll back.",
  );
};
