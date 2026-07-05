-- Prod counterpart of migration 20260705000001_queue_items_started_at_ms.
-- Additive, non-breaking. Adds the millisecond-precise playback start column.
-- Safe to run once; re-running errors with "Duplicate column" (harmless).
ALTER TABLE queue_items ADD COLUMN started_at_ms BIGINT NULL AFTER startedAt;
