-- Rollback of 155_d1d8_erasure_tombstones. Run BEFORE 154. WARNING: without the tombstones a retry of an erased
-- operation id is admitted again as a new operation (a new provider call). Keep the erasure journal; re-apply it
-- after re-running 155 (reapplyErasures).
DROP TABLE IF EXISTS otk_erasure_tombstones;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '155_d1d8_erasure_tombstones'; END IF; END $$;
