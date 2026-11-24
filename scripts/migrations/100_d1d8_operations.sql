-- D1-D8 / C: durable operations, quota counters, money budgets, debit ledger (D7, RV30-02/04/05)
CREATE TABLE IF NOT EXISTS otk_operations (
  tenant_id          TEXT        NOT NULL,
  operation_id       TEXT        NOT NULL,
  schema             TEXT        NOT NULL DEFAULT 'otk.operation.v1',
  request_digest     TEXT        NOT NULL,
  provider           TEXT        NOT NULL,
  api                TEXT        NOT NULL,
  model_requested    TEXT        NOT NULL,
  config             JSONB       NOT NULL,
  limits             JSONB       NOT NULL,
  reservation        JSONB       NOT NULL,
  epoch_id           TEXT        NOT NULL,
  reserved_units     NUMERIC(78,0) NOT NULL,
  reserved_money     NUMERIC(78,0),
  budget_ids         TEXT[]      NOT NULL DEFAULT '{}',
  provider_request_id TEXT,
  execution          TEXT        NOT NULL,
  measurement        TEXT        NOT NULL,
  delivery           TEXT        NOT NULL,
  usage              JSONB,
  cancellation       JSONB,
  effects            JSONB       NOT NULL,
  local_count        JSONB,
  settlement_note    TEXT,
  owner              TEXT,
  lease_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision           BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS otk_operations_incomplete_idx ON otk_operations (execution, updated_at);

CREATE TABLE IF NOT EXISTS otk_quota_usage (
  tenant_id        TEXT          NOT NULL,
  epoch_id         TEXT          NOT NULL,
  confirmed_units  NUMERIC(78,0) NOT NULL DEFAULT 0,
  held_units       NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, epoch_id)
);

CREATE TABLE IF NOT EXISTS otk_money_budget (
  budget_id        TEXT          PRIMARY KEY,
  tenant_id        TEXT          NOT NULL,
  ceiling_units    NUMERIC(78,0) NOT NULL,
  spent_units      NUMERIC(78,0) NOT NULL DEFAULT 0,
  held_units       NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otk_money_budget_tenant_idx ON otk_money_budget (tenant_id);

CREATE TABLE IF NOT EXISTS otk_ledger (
  tenant_id        TEXT          NOT NULL,
  effect_id        TEXT          NOT NULL,
  epoch_id         TEXT          NOT NULL,
  units            NUMERIC(78,0) NOT NULL,
  source           TEXT          NOT NULL,
  operation_id     TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, effect_id)
);
CREATE INDEX IF NOT EXISTS otk_ledger_epoch_idx ON otk_ledger (tenant_id, epoch_id);
