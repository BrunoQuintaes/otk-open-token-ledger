-- Rollback of 103_d1d8_receipts_v3 (destructive: back up first, see README.md)
DROP TABLE IF EXISTS otk_conferences;
DROP TABLE IF EXISTS otk_receipts_v3;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '103_d1d8_receipts_v3'; END IF; END $$;
