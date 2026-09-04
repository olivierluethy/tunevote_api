/**
 * Suggestions that become votes at N supporters (#67).
 *
 *  - change_requests.min_support: if set, the request is a "suggestion" — it only
 *    becomes a live timed vote once this many people back it (until then it sits
 *    in a shorter gathering window). NULL = an ordinary immediate vote.
 *  - change_requests.activated_at: when the suggestion crossed its threshold and
 *    turned into a real vote (NULL while still gathering).
 *
 * Additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("change_requests", (t) => {
    t.integer("min_support").nullable().after("quorum_percent");
    t.dateTime("activated_at").nullable().after("min_support");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("change_requests", (t) => {
    t.dropColumn("activated_at");
    t.dropColumn("min_support");
  });
};
