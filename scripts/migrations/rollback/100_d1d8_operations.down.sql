-- Rollback of 100_d1d8_operations (destructive: back up first, see README.md)
DROP TABLE IF EXISTS otk_ledger;
DROP TABLE IF EXISTS otk_money_budget;
DROP TABLE IF EXISTS otk_quota_usage;
DROP TABLE IF EXISTS otk_operations;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '100_d1d8_operations'; END IF; END $$;
