-- D1-D8 / C: durable side effects, at-least-once with lease and deduplication (D7 §6-7, RV30-03)
CREATE TABLE IF NOT EXISTS otk_outbox (
  effect_id        TEXT        PRIMARY KEY,
  schema           TEXT        NOT NULL DEFAULT 'otk.outbox_effect.v1',
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  kind             TEXT        NOT NULL,
  payload_digest   TEXT        NOT NULL,
  payload          JSONB,
  target           JSONB,
  state            TEXT        NOT NULL DEFAULT 'pending',
  attempts         INTEGER     NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_until      TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS otk_outbox_claim_idx ON otk_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS otk_outbox_op_idx ON otk_outbox (tenant_id, operation_id);
