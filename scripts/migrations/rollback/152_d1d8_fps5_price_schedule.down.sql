-- Rollback of 152_d1d8_fps5_price_schedule. Run BEFORE 151. Drops only the scheduling columns/index; pending
-- prices stay pending (code older than 152 re-opens AUD-4: oldest-first batches without backoff).
DROP INDEX IF EXISTS otk_operations_price_due_idx;
ALTER TABLE IF EXISTS otk_operations DROP COLUMN IF EXISTS price_next_attempt_at;
ALTER TABLE IF EXISTS otk_operations DROP COLUMN IF EXISTS price_attempts;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '152_d1d8_fps5_price_schedule'; END IF; END $$;
