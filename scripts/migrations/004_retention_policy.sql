-- 004_retention_policy.sql
-- Adds archived_at column to receipts table for data lifecycle management (E5.3)
-- Receipts older than OTK_RECEIPT_RETENTION_DAYS (default: 90) will have
-- archived_at set to their archival timestamp.
--
-- @since Wave 4 (4B-PACK-4B03 / E5.3)
--
-- S4 (run 20260930-1625, audit ABC-05 / C-F01): no migration and no runtime code creates a table
-- named `receipts` (the receipt table is `otk_receipts`, created by PostgresReceiptStore.init), so
-- on an empty database this file aborted the whole chain. The `receipts` statements are now
-- guarded by `to_regclass('public.receipts')`, the same pattern this file already used for
-- `audit_log`. A database that has a `receipts` table gets exactly the original statements; one
-- that does not gets a NOTICE and the column/index are not invented. Original text preserved in
-- docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/S4/S4_1/abc05_originais/.

-- receipts table: add archived_at for soft-archival
DO $$
BEGIN
  IF to_regclass('public.receipts') IS NULL THEN
    RAISE NOTICE '004_retention_policy: table receipts does not exist; archived_at not added (S4 ABC-05)';
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE receipts ADD COLUMN archived_at TIMESTAMPTZ DEFAULT NULL;
    COMMENT ON COLUMN receipts.archived_at IS 'Soft-archival timestamp. NULL = active. Set by RetentionWorker.';
  END IF;
END
$$;

-- audit_log table: add archived_at for long-term retention policy
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_log'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'audit_log' AND column_name = 'archived_at'
    ) THEN
      ALTER TABLE audit_log ADD COLUMN archived_at TIMESTAMPTZ DEFAULT NULL;
      COMMENT ON COLUMN audit_log.archived_at IS 'Soft-archival timestamp. NULL = active. Set by RetentionWorker.';
    END IF;
  END IF;
END
$$;

-- Index for efficient retention queries (only where the receipts table exists, S4 ABC-05)
DO $$
BEGIN
  IF to_regclass('public.receipts') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_receipts_archived_at ON receipts (archived_at) WHERE archived_at IS NULL';
  END IF;
END
$$;

-- Index for efficient audit_log retention queries (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_log') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_audit_log_archived_at ON audit_log (archived_at) WHERE archived_at IS NULL';
  END IF;
END
$$;
