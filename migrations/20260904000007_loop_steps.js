/**
 * Richer loops (#66): pauses inside a loop + "what happens after".
 *
 *  - loops.on_complete: what to do when the loop ends ('none' or 'propose_pause').
 *  - loops.on_complete_done: guards the reconciler so the on-complete action fires
 *    exactly once.
 *
 * The step list itself (music + pause, in any order/repetition) lives in the
 * existing loops.recipe JSON — no column change needed.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("loops", (t) => {
    t.string("on_complete", 24).notNullable().defaultTo("none").after("status");
    t.boolean("on_complete_done").notNullable().defaultTo(false).after("on_complete");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("loops", (t) => {
    t.dropColumn("on_complete_done");
    t.dropColumn("on_complete");
  });
};
