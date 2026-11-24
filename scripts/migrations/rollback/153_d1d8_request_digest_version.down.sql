-- Rollback of 153_d1d8_request_digest_version. Run BEFORE 152. Drops only the version column: rows admitted
-- with otk.request_digest.v2 keep their digest, but code older than 153 compares v1 digests and would answer
-- 409 conflict to a retry of those operations (never a new upstream call or debit).
ALTER TABLE IF EXISTS otk_operations DROP COLUMN IF EXISTS request_digest_version;
DO $$ BEGIN IF to_regclass('public.otk_migrations') IS NOT NULL THEN DELETE FROM otk_migrations WHERE version = '153_d1d8_request_digest_version'; END IF; END $$;
