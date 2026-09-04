/**
 * Live loop objects (#66/#68 — follow-up slice).
 *
 * A loop is a durable "repeat these songs N times (or endlessly)" object, driven
 * lazily: only ONE run is materialized into the queue at a time, and the playback
 * engine enqueues the next run when the current one finishes (see services/loops.js).
 * This supports endless loops, ending after the current run, extending, and a
 * live "run 3/10" status — none of which the earlier static-copy approach could.
 *
 *  - loops: the loop object (recipe of songs, target/completed runs, status).
 *  - queue_items.loop_id / loop_run: tag the copies materialized for a loop so
 *    the engine knows when a run is exhausted and which loop to advance.
 *
 * All additive; ids are signed INT to match the schema.
 */
exports.up = async (knex) => {
  await knex.schema.createTable("loops", (t) => {
    t.increments("id").primary();
    t.integer("session_id").notNullable();
    t.json("recipe").notNullable(); // ordered [{ video_id, description }]
    t.integer("total_runs").nullable(); // NULL = endless
    t.integer("completed_runs").notNullable().defaultTo(0);
    t.enu("status", ["active", "ended"]).notNullable().defaultTo("active");
    t.integer("created_by_user_id").nullable();
    t.integer("created_by_guest_id").nullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["session_id", "status"], "idx_loops_session_status");
    t.foreign("session_id").references("id").inTable("sessions").onDelete("CASCADE");
  });

  await knex.schema.alterTable("queue_items", (t) => {
    t.integer("loop_id").nullable().after("voting_round_id");
    t.integer("loop_run").nullable().after("loop_id");
  });
  await knex.raw("CREATE INDEX idx_queue_items_loop ON queue_items (loop_id, status)");
};

exports.down = async (knex) => {
  await knex.raw("DROP INDEX idx_queue_items_loop ON queue_items");
  await knex.schema.alterTable("queue_items", (t) => {
    t.dropColumn("loop_run");
    t.dropColumn("loop_id");
  });
  await knex.schema.dropTableIfExists("loops");
};
