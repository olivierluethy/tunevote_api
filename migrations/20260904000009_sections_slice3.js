/**
 * Named sections — Slice 3 (#66): current section, loops-as-blocks, branching.
 *
 *  - sessions.current_section_id: the active section that host-added songs join.
 *  - loops.section_id: a loop's materialized items join this section.
 *  - sections.on_complete / on_complete_target / on_complete_done / completed_at:
 *    "what happens after this section" — fired once when the section's last queued
 *    item has played (detected by the same advanceToNext hook as loops).
 *
 * All additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("sessions", (t) => {
    t.integer("current_section_id").nullable();
  });
  await knex.schema.alterTable("loops", (t) => {
    t.integer("section_id").nullable();
  });
  await knex.schema.alterTable("sections", (t) => {
    t.string("on_complete", 32).notNullable().defaultTo("none").after("status");
    t.integer("on_complete_target").nullable().after("on_complete");
    t.boolean("on_complete_done").notNullable().defaultTo(false).after("on_complete_target");
    t.dateTime("completed_at").nullable().after("on_complete_done");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("sections", (t) => {
    t.dropColumn("completed_at");
    t.dropColumn("on_complete_done");
    t.dropColumn("on_complete_target");
    t.dropColumn("on_complete");
  });
  await knex.schema.alterTable("loops", (t) => {
    t.dropColumn("section_id");
  });
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("current_section_id");
  });
};
