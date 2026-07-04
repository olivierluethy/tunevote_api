/**
 * Collapse voting_rounds.phase + voting_rounds.status into a single `state`
 * column (§4.6). The two columns were updated by separate statements and could
 * contradict (e.g. phase='voting' with status='closed').
 *
 * Mapping:
 *   status='open'  & phase='suggestion' -> 'suggesting'
 *   status='open'  & phase='voting'     -> 'voting'
 *   status IN ('closed','computed')     -> 'closed'
 *   phase='closed'                      -> 'closed'
 *
 * `phase_ends_at`, `winner_queue_item_id`, durations and quorum stay untouched.
 * Backend-only columns (no external reader), so phase/status are dropped here.
 */
exports.up = async (knex) => {
  await knex.raw(
    "ALTER TABLE voting_rounds ADD COLUMN state ENUM('suggesting','voting','closed') NOT NULL DEFAULT 'suggesting'",
  );
  await knex.raw(`
    UPDATE voting_rounds SET state = CASE
      WHEN status IN ('closed','computed') OR phase = 'closed' THEN 'closed'
      WHEN phase = 'voting' THEN 'voting'
      ELSE 'suggesting'
    END
  `);
  await knex.raw("CREATE INDEX idx_voting_rounds_state ON voting_rounds (session_id, state)");
  await knex.schema.alterTable("voting_rounds", (t) => {
    t.dropColumn("phase");
    t.dropColumn("status");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("voting_rounds", (t) => {
    t.enu("phase", ["suggestion", "voting", "closed"]).notNullable().defaultTo("suggestion");
    t.enu("status", ["open", "closed", "computed"]).defaultTo("open");
  });
  await knex.raw(`
    UPDATE voting_rounds SET
      phase  = CASE WHEN state = 'voting' THEN 'voting' WHEN state = 'closed' THEN 'closed' ELSE 'suggestion' END,
      status = CASE WHEN state = 'closed' THEN 'closed' ELSE 'open' END
  `);
  await knex.raw("DROP INDEX idx_voting_rounds_state ON voting_rounds");
  await knex.schema.alterTable("voting_rounds", (t) => t.dropColumn("state"));
};
