/**
 * Sub-step C1 (additive, non-breaking): add sessions.status ENUM('draft','live',
 * 'ended') as the future single lifecycle column. Backfilled from the existing
 * flags. is_active/is_live are KEPT and dual-written for this transition; they
 * are dropped in a later migration (C3) once the frontend reads `status`.
 *
 * Backfill: is_live=1 -> 'live'; ended (ended_at set) -> 'ended'; else 'draft'.
 */
exports.up = async (knex) => {
  await knex.raw(
    "ALTER TABLE sessions ADD COLUMN status ENUM('draft','live','ended') NOT NULL DEFAULT 'draft'",
  );
  await knex.raw(`
    UPDATE sessions SET status = CASE
      WHEN is_live = 1 THEN 'live'
      WHEN ended_at IS NOT NULL THEN 'ended'
      ELSE 'draft'
    END
  `);
  await knex.raw("CREATE INDEX idx_sessions_status ON sessions (status)");
};

exports.down = async (knex) => {
  await knex.raw("DROP INDEX idx_sessions_status ON sessions");
  await knex.schema.alterTable("sessions", (t) => t.dropColumn("status"));
};
