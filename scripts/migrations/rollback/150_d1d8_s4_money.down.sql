-- Rollback of 150_d1d8_s4_money (destructive for the money axis: back up first, see README.md).
-- Run BEFORE 103 → 100. Code older than S4 ignores these columns/tables.
DROP TABLE IF EXISTS otk_money_ledger;
DROP TABLE IF EXISTS otk_money_budget_members;
ALTER TABLE IF EXISTS otk_money_budget DROP COLUMN IF EXISTS frozen_at;
ALTER TABLE IF EXISTS otk_money_budget DROP COLUMN IF EXISTS frozen_reason;
ALTER TABLE IF EXISTS otk_operations DROP COLUMN IF EXISTS money;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '150_d1d8_s4_money'; END IF; END $$;
