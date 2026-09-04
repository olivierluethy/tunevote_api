/**
 * Democratic Undo (#66/#67 — follow-up slice).
 *
 * session_events.undone_at marks an applied, reversible change that the community
 * has since voted to undo, so the history UI can show it struck-through and the
 * undo_event handler can refuse to undo the same event twice. Additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("session_events", (t) => {
    t.dateTime("undone_at").nullable().after("actor");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("session_events", (t) => {
    t.dropColumn("undone_at");
  });
};
