/**
 * Multi-option voting (#67 — follow-up slice).
 *
 * A change request can now carry `options`: instead of a single approve vote,
 * voters pick one of several options and the winner (most votes, meeting quorum)
 * is applied via the normal handler registry. This covers multi-option polls
 * (e.g. "loop ×3/×5/×10/∞") and yes/no (a two-option poll) with one mechanism.
 *
 *  - change_requests.options: JSON [{ id, label, type, payload }] (NULL = the
 *    existing single-action approve behaviour, untouched).
 *  - change_requests.winner_option_id: which option won, once resolved.
 *  - change_request_votes.option_id: which option a voter chose (NULL = a legacy
 *    approve vote). Voters may switch via upsert on the existing unique keys.
 *
 * All additive/nullable.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable("change_requests", (t) => {
    t.json("options").nullable().after("payload");
    t.string("winner_option_id", 64).nullable().after("resolution");
  });
  await knex.schema.alterTable("change_request_votes", (t) => {
    t.string("option_id", 64).nullable().after("guest_id");
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable("change_request_votes", (t) => {
    t.dropColumn("option_id");
  });
  await knex.schema.alterTable("change_requests", (t) => {
    t.dropColumn("winner_option_id");
    t.dropColumn("options");
  });
};
