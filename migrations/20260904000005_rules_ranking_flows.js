/**
 * Session rules, ranking votes & alternative flows (#67 — follow-up slice).
 *
 *  - session_rules: per-session, democratically changeable config (quorum per
 *    change type, default vote duration). Read as overrides on the handler
 *    defaults; changed via the `set_rule` change type.
 *  - change_requests.vote_method: 'plurality' (default) or 'ranking' (Borda).
 *  - change_request_votes.ranking: a voter's ordered option ids for a ranking
 *    poll (NULL for plurality/approve votes).
 *
 * Alternative flows (poll options carrying MULTIPLE actions) need no schema —
 * the actions live inside the existing change_requests.options JSON.
 *
 * All additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.createTable("session_rules", (t) => {
    t.integer("session_id").primary();
    t.json("rules").nullable();
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    t.foreign("session_id").references("id").inTable("sessions").onDelete("CASCADE");
  });
  await knex.schema.alterTable("change_requests", (t) => {
    t.string("vote_method", 16).notNullable().defaultTo("plurality").after("options");
  });
  await knex.schema.alterTable("change_request_votes", (t) => {
    t.json("ranking").nullable().after("option_id");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("change_request_votes", (t) => {
    t.dropColumn("ranking");
  });
  await knex.schema.alterTable("change_requests", (t) => {
    t.dropColumn("vote_method");
  });
  await knex.schema.dropTableIfExists("session_rules");
};
