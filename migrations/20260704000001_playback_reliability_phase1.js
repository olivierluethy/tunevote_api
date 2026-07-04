/**
 * Phase 1 playback reliability:
 *  - sessions.current_plays_until: durable deadline for the currently playing
 *    song, so the reconciler can advance overdue sessions and rebuild timers
 *    after a restart (no reliance on in-memory setTimeout surviving a crash).
 *  - session_participants.last_seen: heartbeat so participant liveness decays
 *    instead of leaking upward on unclean disconnects.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("sessions", (t) => {
    t.dateTime("current_plays_until").nullable();
  });
  await knex.schema.alterTable("session_participants", (t) => {
    t.dateTime("last_seen").nullable();
  });
  await knex.raw(
    "CREATE INDEX idx_sessions_live_deadline ON sessions (is_live, current_plays_until)",
  );
};

exports.down = async (knex) => {
  await knex.raw("DROP INDEX idx_sessions_live_deadline ON sessions");
  await knex.schema.alterTable("session_participants", (t) => {
    t.dropColumn("last_seen");
  });
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("current_plays_until");
  });
};
