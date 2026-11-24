-- Rollback of 102_d1d8_openings (destructive: back up first, see README.md)
DROP TABLE IF EXISTS otk_openings;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '102_d1d8_openings'; END IF; END $$;
