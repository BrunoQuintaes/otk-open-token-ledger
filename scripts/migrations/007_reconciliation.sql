-- Migration 007 — Receipt Reconciliation Reports
-- Wave 5 (W5-5B02 / E6.3)
-- Stores periodic reconciliation report summaries.

CREATE TABLE IF NOT EXISTS receipt_reconciliation (
  id           TEXT        PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_otk    INTEGER     NOT NULL,
  total_external INTEGER   NOT NULL,
  matched      INTEGER     NOT NULL,
  otk_only     INTEGER     NOT NULL,
  external_only INTEGER    NOT NULL,
  items_json   TEXT        NOT NULL,  -- JSON array of ReconciliationLineItem
  run_by       TEXT        NOT NULL DEFAULT 'scheduler'
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_generated_at
  ON receipt_reconciliation (generated_at DESC);
