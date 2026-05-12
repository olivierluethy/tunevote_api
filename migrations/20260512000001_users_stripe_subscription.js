/**
 * Add Stripe subscription state to the users table.
 *
 *   stripe_customer_id              — Stripe Customer (cus_…) created on first
 *                                     Checkout Session; reused thereafter.
 *   stripe_subscription_id          — Active or last subscription (sub_…).
 *   subscription_status             — 'none' | 'active' | 'past_due' | 'canceled'.
 *                                     The paywall guard treats anything other
 *                                     than 'active' (with period_end in the
 *                                     future) as un-entitled.
 *   subscription_current_period_end — End of the paid period; used both for
 *                                     entitlement and so the guard does not
 *                                     drop access the instant a webhook arrives
 *                                     marking a sub as canceled "at period end".
 *
 * Idempotent — guarded by INFORMATION_SCHEMA so re-runs are no-ops.
 */

const DB = (knex) => knex.client.config.connection.database;

async function columnExists(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB(knex), table, column],
  );
  return rows.length > 0;
}

async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB(knex), table, indexName],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await columnExists(knex, "users", "stripe_customer_id"))) {
    await knex.raw(
      `ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255) DEFAULT NULL`,
    );
  }
  if (!(await columnExists(knex, "users", "stripe_subscription_id"))) {
    await knex.raw(
      `ALTER TABLE users ADD COLUMN stripe_subscription_id VARCHAR(255) DEFAULT NULL`,
    );
  }
  if (!(await columnExists(knex, "users", "subscription_status"))) {
    await knex.raw(
      `ALTER TABLE users
         ADD COLUMN subscription_status
         ENUM('none','active','past_due','canceled')
         NOT NULL DEFAULT 'none'`,
    );
  }
  if (!(await columnExists(knex, "users", "subscription_current_period_end"))) {
    await knex.raw(
      `ALTER TABLE users
         ADD COLUMN subscription_current_period_end DATETIME DEFAULT NULL`,
    );
  }
  if (!(await indexExists(knex, "users", "idx_users_stripe_customer"))) {
    await knex.raw(
      `CREATE INDEX idx_users_stripe_customer ON users (stripe_customer_id)`,
    );
  }
};

exports.down = async function down() {
  throw new Error(
    "users-stripe-subscription migration is one-way. " +
      "Restore from backup to roll back.",
  );
};
