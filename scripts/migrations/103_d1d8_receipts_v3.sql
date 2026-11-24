-- D1-D8 / C: private receipt v3 and conference report with their envelopes (D3 §6-7)
CREATE TABLE IF NOT EXISTS otk_receipts_v3 (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  schema           TEXT        NOT NULL,
  source           TEXT        NOT NULL,
  receipt_digest   TEXT        NOT NULL,
  receipt          JSONB       NOT NULL,
  envelope         JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (receipt_digest)
);

CREATE TABLE IF NOT EXISTS otk_conferences (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  schema           TEXT        NOT NULL,
  receipt_digest   TEXT        NOT NULL,
  state            TEXT        NOT NULL,
  verdict          TEXT        NOT NULL,
  report_digest    TEXT        NOT NULL,
  report           JSONB       NOT NULL,
  envelope         JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES otk_receipts_v3 (tenant_id, operation_id),
  FOREIGN KEY (receipt_digest) REFERENCES otk_receipts_v3 (receipt_digest)
);
