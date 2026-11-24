-- D1-D8 / fechamento pós-S5 (RV2-02, AUD-4): fair, persistent reconciliation of pending prices. Each pass
-- claims the operations that are due (never tried first, then by due time) and schedules the next attempt
-- with exponential backoff, so permanently unpriceable operations cannot occupy every batch. Scheduling
-- columns only: business timestamps (created_at/updated_at) and the money axis are not touched. Additive and
-- idempotent, rollback in rollback/152_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS price_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS price_next_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS otk_operations_price_due_idx ON otk_operations (price_next_attempt_at NULLS FIRST, updated_at)
  WHERE money->>'state' = 'pending_price';
