/**
 * Additive, non-breaking: add queue_items.started_at_ms (BIGINT, nullable).
 *
 * Playback sync sends the song's start time two ways: socket events carry the
 * exact Node `Date.now()` (ms), while GET /playback-sync derived it from
 * `startedAt` — a second-resolution DATETIME — via UNIX_TIMESTAMP()*1000, which
 * truncated to the whole second. A client alternates between both paths, so the
 * two disagreed by up to ~1s and it would jump on each drift poll.
 *
 * started_at_ms stores the exact same ms value the socket events send, and the
 * GET reads COALESCE(started_at_ms, UNIX_TIMESTAMP(startedAt)*1000) so both
 * paths return an identical millisecond-precise start time. Old rows (NULL) fall
 * back to the legacy computation. Idempotent so it's safe alongside a manual
 * prod ALTER.
 */
exports.up = async (knex) => {
  const exists = await knex.schema.hasColumn("queue_items", "started_at_ms");
  if (!exists) {
    await knex.raw(
      "ALTER TABLE queue_items ADD COLUMN started_at_ms BIGINT NULL AFTER startedAt",
    );
  }
};

exports.down = async (knex) => {
  const exists = await knex.schema.hasColumn("queue_items", "started_at_ms");
  if (exists) {
    await knex.schema.alterTable("queue_items", (t) =>
      t.dropColumn("started_at_ms"),
    );
  }
};
