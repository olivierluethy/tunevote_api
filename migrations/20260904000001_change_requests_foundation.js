/**
 * Change-Request foundation (#66/#67/#68 — first slice).
 *
 * A generic, votable "change request" system that runs ALONGSIDE the existing
 * voting_rounds song-selection (coexistence — the rounds are untouched), plus an
 * append-only session_events decision log. Everything is additive.
 *
 *  - queue_items.sort_order: makes the queue positionally orderable (pause can be
 *    inserted "after the current song", later: reorder/loops). Backfilled to id;
 *    the next-pick + queue-list queries fall back to id via COALESCE, so existing
 *    ordering is preserved bit-for-bit until a row gets a real sort_order.
 *  - change_requests / change_request_votes: the vote process (propose → approve
 *    → resolve). Approve-only votes, NULL-tolerant uniques exactly like `votes`.
 *  - session_events: durable log of what actually happened. Each applied event
 *    carries reversible + inverse, so democratic Undo is retrofittable without a
 *    migration.
 *
 * ids are signed INT across this schema, so FK columns here are signed INT too.
 */
exports.up = async (knex) => {
  // 1) Positional queue ordering.
  await knex.schema.alterTable("queue_items", (t) => {
    t.decimal("sort_order", 30, 10).nullable().after("started_at_ms");
  });
  await knex.raw("UPDATE queue_items SET sort_order = id WHERE sort_order IS NULL");
  await knex.raw(
    "CREATE INDEX idx_queue_items_order ON queue_items (session_id, status, sort_order)",
  );

  // 2) change_requests — the vote process.
  await knex.schema.createTable("change_requests", (t) => {
    t.increments("id").primary();
    t.integer("session_id").notNullable();
    t.string("type", 64).notNullable();
    t.json("payload").nullable();
    t.integer("proposed_by_user_id").nullable();
    t.integer("proposed_by_guest_id").nullable();
    t.enu("status", ["open", "applied", "rejected", "expired", "superseded", "failed"])
      .notNullable()
      .defaultTo("open");
    t.decimal("quorum_percent", 5, 4).notNullable().defaultTo(0.5);
    t.dateTime("expires_at").notNullable();
    t.dateTime("resolved_at").nullable();
    t.string("resolution", 64).nullable();
    t.integer("applied_event_id").nullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["session_id", "status"], "idx_change_requests_session_status");
    t.index(["status", "expires_at"], "idx_change_requests_status_expiry");
    t.foreign("session_id").references("id").inTable("sessions").onDelete("CASCADE");
  });

  // 3) change_request_votes — approve-only, one per voter.
  await knex.schema.createTable("change_request_votes", (t) => {
    t.increments("id").primary();
    t.integer("change_request_id").notNullable();
    t.integer("user_id").nullable();
    t.integer("guest_id").nullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["change_request_id", "user_id"], "uq_cr_vote_user");
    t.unique(["change_request_id", "guest_id"], "uq_cr_vote_guest");
    t.foreign("change_request_id")
      .references("id")
      .inTable("change_requests")
      .onDelete("CASCADE");
  });

  // 4) session_events — append-only decision log.
  await knex.schema.createTable("session_events", (t) => {
    t.increments("id").primary();
    t.integer("session_id").notNullable();
    t.string("type", 64).notNullable();
    t.integer("change_request_id").nullable();
    t.json("payload").nullable();
    t.boolean("reversible").notNullable().defaultTo(false);
    t.json("inverse").nullable();
    t.json("actor").nullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["session_id", "id"], "idx_session_events_session");
    t.foreign("session_id").references("id").inTable("sessions").onDelete("CASCADE");
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists("session_events");
  await knex.schema.dropTableIfExists("change_request_votes");
  await knex.schema.dropTableIfExists("change_requests");
  await knex.raw("DROP INDEX idx_queue_items_order ON queue_items");
  await knex.schema.alterTable("queue_items", (t) => {
    t.dropColumn("sort_order");
  });
};
