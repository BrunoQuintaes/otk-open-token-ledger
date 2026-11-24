-- 005_gdpr_tombstones.sql
-- Adds erased_at and tombstone_hash columns for GDPR right-to-erasure (E5.6)
-- Erasure is a soft-delete: receipt content zeroed out, tombstone_hash preserves
-- audit chain integrity.
--
-- @since Wave 4 (4B-PACK-4B04 / E5.6)
--
-- S4 (run 20260930-1625, audit ABC-05 / C-F01): the `receipts` statements are guarded by
-- `to_regclass('public.receipts')` for the same reason as 004 (no migration creates `receipts`).
-- Where the table exists the statements are the original ones. gdpr_audit_log is unchanged.
-- Original text preserved in docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/S4/S4_1/abc05_originais/.

-- receipts table: erasure columns
DO $$
BEGIN
  IF to_regclass('public.receipts') IS NULL THEN
    RAISE NOTICE '005_gdpr_tombstones: table receipts does not exist; erased_at/tombstone_hash not added (S4 ABC-05)';
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'erased_at'
  ) THEN
    ALTER TABLE receipts ADD COLUMN erased_at TIMESTAMPTZ DEFAULT NULL;
    COMMENT ON COLUMN receipts.erased_at IS 'GDPR erasure timestamp. NULL = not erased.';
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.receipts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'tombstone_hash'
  ) THEN
    ALTER TABLE receipts ADD COLUMN tombstone_hash TEXT DEFAULT NULL;
    COMMENT ON COLUMN receipts.tombstone_hash IS 'SHA-256 of original receipt data for chain integrity after erasure.';
  END IF;
END
$$;

-- Index for erasure queries (find active non-erased receipts), only where the table exists
DO $$
BEGIN
  IF to_regclass('public.receipts') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_receipts_erased_at ON receipts (erased_at) WHERE erased_at IS NULL';
  END IF;
END
$$;

-- GDPR audit log: records all export and erasure requests
CREATE TABLE IF NOT EXISTS gdpr_audit_log (
  id          SERIAL PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  action      TEXT        NOT NULL,   -- 'export' | 'erase'
  requested_by TEXT       NOT NULL,   -- userId or API key
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details     JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gdpr_audit_tenant ON gdpr_audit_log (tenant_id);
