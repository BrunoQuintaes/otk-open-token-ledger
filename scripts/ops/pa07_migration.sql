-- PA-07B Migration — OTK zk-Metering Receipt Store (Phase 2)
-- Run: psql $OTK_DB_URL -f scripts/ops/pa07_migration.sql
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS otk_receipts (
  request_id   TEXT PRIMARY KEY,
  receipt_json JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for tenant queries (optional)
CREATE INDEX IF NOT EXISTS otk_receipts_tenant_idx
  ON otk_receipts ((receipt_json->>'tenantId'));

-- Index for timestamp range queries
CREATE INDEX IF NOT EXISTS otk_receipts_created_idx
  ON otk_receipts (created_at DESC);
