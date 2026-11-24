-- Rollback of 151_d1d8_fps5_money_scope. Run BEFORE 150. Removes the admission/budget serialization
-- guards: code older than 151 does not read money_policy and re-opens AUD-6 (see README.md).
DROP TRIGGER IF EXISTS otk_money_budget_members_scope ON otk_money_budget_members;
DROP TRIGGER IF EXISTS otk_money_budget_scope_del ON otk_money_budget;
DROP TRIGGER IF EXISTS otk_money_budget_scope_upd ON otk_money_budget;
DROP TRIGGER IF EXISTS otk_money_budget_scope_ins ON otk_money_budget;
DROP FUNCTION IF EXISTS otk_money_scope_guard();
DROP FUNCTION IF EXISTS otk_money_scope_lock(TEXT);
DROP INDEX IF EXISTS otk_operations_open_money_idx;
ALTER TABLE IF EXISTS otk_money_budget DROP COLUMN IF EXISTS money_policy;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '151_d1d8_fps5_money_scope'; END IF; END $$;
