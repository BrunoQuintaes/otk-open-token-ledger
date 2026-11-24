-- Rollback of 101_d1d8_outbox (destructive: back up first, see README.md)
DROP TABLE IF EXISTS otk_outbox;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '101_d1d8_outbox'; END IF; END $$;
