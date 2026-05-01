#!/usr/bin/env node
/**
 * Marks the baseline migration as already-applied so the next
 * `knex migrate:latest` skips it and only runs the reconciliation.
 */
const knexLib = require("knex");
const config = require("../knexfile");
const BASELINE_NAME = "20260501000001_baseline_canonical_schema.js";

async function main() {
  const env = process.env.NODE_ENV || "development";
  const knex = knexLib(config[env]);
  try {
    await knex.raw(`
      CREATE TABLE IF NOT EXISTS knex_migrations (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        batch INT,
        migration_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await knex.raw(`
      CREATE TABLE IF NOT EXISTS knex_migrations_lock (
        \`index\` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        is_locked INT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const existing = await knex("knex_migrations")
      .where({ name: BASELINE_NAME })
      .first();
    if (existing) {
      console.log(`Baseline already marked as applied (id=${existing.id}). Nothing to do.`);
      return;
    }
    await knex("knex_migrations").insert({
      name: BASELINE_NAME,
      batch: 1,
      migration_time: knex.fn.now(),
    });
    console.log(`Marked ${BASELINE_NAME} as applied.`);
    console.log(`Next: run \`npm run migrate:latest\` to apply reconciliation.`);
  } finally {
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error("mark-baseline failed:", err);
  process.exit(1);
});