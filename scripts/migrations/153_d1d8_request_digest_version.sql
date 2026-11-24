-- D1-D8 / OVERNIGHT 20261005 (identity across versions): construction of request_digest. NULL = every row
-- admitted before this column existed, which used otk.request_digest.v1 (digest of the FORWARDED body). New rows
-- record otk.request_digest.v2 (digest of the request as the client sent it). The stored digest of an old row
-- is never rewritten. Additive and idempotent, rollback in rollback/153_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS request_digest_version TEXT;
