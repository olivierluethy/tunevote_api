-- ─────────────────────────────────────────────────────────────────────────────
-- Add Stripe subscription state to the `users` table — plain DDL, no
-- stored procedures, no information_schema reads. Works on shared MySQL
-- hosts (cPanel etc.) where CREATE ROUTINE and information_schema access
-- are restricted.
--
-- This script is NOT idempotent. Run it exactly once against a database
-- whose `users` table does not yet have the Stripe columns.
--
-- If you accidentally re-run it, MySQL will error on the duplicate column:
--     #1060 - Duplicate column name 'stripe_customer_id'
-- That's harmless — it means the column is already there. Comment out
-- the offending statement and re-run the rest, or simply stop.
--
-- Run with:
--   mysql -u <user> -p <database> < add_stripe_subscription_columns.sql
--   — or paste into phpMyAdmin's SQL tab and click Go.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Stripe Customer (cus_…). Reused across checkouts.
ALTER TABLE `users`
  ADD COLUMN `stripe_customer_id` VARCHAR(255) DEFAULT NULL;

-- 2. Active or last subscription (sub_…).
ALTER TABLE `users`
  ADD COLUMN `stripe_subscription_id` VARCHAR(255) DEFAULT NULL;

-- 3. Entitlement gate. Anything other than 'active' (with period_end in
--    the future) is treated as un-entitled by the paywall.
ALTER TABLE `users`
  ADD COLUMN `subscription_status`
    ENUM('none','active','past_due','canceled') NOT NULL DEFAULT 'none';

-- 4. End of the paid window. Keeps users entitled through the period
--    they've already paid for, even after Stripe marks the sub as
--    canceled "at period end".
ALTER TABLE `users`
  ADD COLUMN `subscription_current_period_end` DATETIME DEFAULT NULL;

-- 5. Index so the webhook handler can look users up by Stripe customer ID
--    without a full table scan.
CREATE INDEX `idx_users_stripe_customer` ON `users` (`stripe_customer_id`);

-- 6. Mark the equivalent knex migration as already-applied so a future
--    `npm run migrate:latest` won't try to re-run it. Uses user variables
--    so the INSERT doesn't reference `knex_migrations` in its own subquery
--    (MySQL forbids that).
SET @next_batch := (SELECT COALESCE(MAX(`batch`), 0) + 1 FROM `knex_migrations`);

INSERT INTO `knex_migrations` (`name`, `batch`, `migration_time`)
VALUES (
  '20260512000001_users_stripe_subscription.js',
  @next_batch,
  NOW()
);
