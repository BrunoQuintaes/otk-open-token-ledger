-- D1-D8 / C: private commitment openings, stored before the dependent public effect (D2 §5)
CREATE TABLE IF NOT EXISTS otk_openings (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  circuit_id       TEXT        NOT NULL,
  opening          JSONB       NOT NULL,
  opening_digest   TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
