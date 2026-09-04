/**
 * Named session sections (#66, Slice 1).
 *
 *  - sections: a named block of the session ("Warm-up", "Peak", …).
 *  - queue_items.section_id: which section an item belongs to (NULL = loose).
 *
 * Sections are realized purely through the existing sort_order/status primitives,
 * so the playback engine (ORDER BY COALESCE(sort_order,id)) is untouched. All
 * additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.createTable("sections", (t) => {
    t.increments("id").primary();
    t.integer("session_id").notNullable();
    t.string("name", 80).notNullable();
    t.enu("status", ["active", "archived"]).notNullable().defaultTo("active");
    t.integer("created_by_user_id").nullable();
    t.integer("created_by_guest_id").nullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["session_id", "status"], "idx_sections_session_status");
    t.foreign("session_id").references("id").inTable("sessions").onDelete("CASCADE");
  });

  await knex.schema.alterTable("queue_items", (t) => {
    t.integer("section_id").nullable().after("loop_run");
  });
  await knex.raw("CREATE INDEX idx_queue_items_section ON queue_items (session_id, section_id)");
};

exports.down = async (knex) => {
  await knex.raw("DROP INDEX idx_queue_items_section ON queue_items");
  await knex.schema.alterTable("queue_items", (t) => {
    t.dropColumn("section_id");
  });
  await knex.schema.dropTableIfExists("sections");
};
