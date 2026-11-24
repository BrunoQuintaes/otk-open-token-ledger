-- Rollback of 154_d1d8_attribution. Run BEFORE 153. Destructive for attribution only: drops the registered
-- projects/applications, the per-operation attribution and the signed statements. Operations, ledger, receipts
-- and conferences are untouched; every operation then reads as unattributed.
DROP TABLE IF EXISTS otk_attribution_statements;
DROP TABLE IF EXISTS otk_operation_attribution;
DROP TABLE IF EXISTS otk_applications;
DROP TABLE IF EXISTS otk_projects;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '154_d1d8_attribution'; END IF; END $$;
