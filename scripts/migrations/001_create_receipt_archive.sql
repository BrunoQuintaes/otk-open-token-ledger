-- Migration 001: Create receipt archive table
-- @since Wave 2 Pack 14 (E3.1)

CREATE TABLE IF NOT EXISTS otk_receipt_archive (
  request_id    TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  epoch_id      TEXT NOT NULL DEFAULT '0',
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  cost_units    DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  timestamp     BIGINT NOT NULL DEFAULT 0,
  receipt_json  JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_archive_tenant ON otk_receipt_archive (tenant_id);
CREATE INDEX IF NOT EXISTS idx_archive_epoch ON otk_receipt_archive (epoch_id);
CREATE INDEX IF NOT EXISTS idx_archive_provider ON otk_receipt_archive (provider);
CREATE INDEX IF NOT EXISTS idx_archive_ts ON otk_receipt_archive (timestamp);
