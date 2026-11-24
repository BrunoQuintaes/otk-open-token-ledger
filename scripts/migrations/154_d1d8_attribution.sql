-- D1-D8 / OVERNIGHT 20261005 (Phase 7): attribution of operations to projects and tasks, private and off-chain.
-- otk_projects / otk_applications: what a tenant may name (registered, tenant-scoped ids; labels are private).
-- otk_operation_attribution: written in the SAME transaction that admits the operation; absent row = unattributed.
-- otk_attribution_statements: the attribution signed by the operator and bound to the receipt digest.
-- Additive and idempotent, rollback in rollback/154_*.down.sql.
CREATE TABLE IF NOT EXISTS otk_projects (
  tenant_id   TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  label       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);
CREATE TABLE IF NOT EXISTS otk_applications (
  tenant_id       TEXT        NOT NULL,
  application_id  TEXT        NOT NULL,
  label           TEXT,
  active          BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id)
);
CREATE TABLE IF NOT EXISTS otk_operation_attribution (
  tenant_id       TEXT        NOT NULL,
  operation_id    TEXT        NOT NULL,
  schema          TEXT        NOT NULL DEFAULT 'otk.attribution.v1',
  project_id      TEXT,
  application_id  TEXT,
  task_type       TEXT,
  task_run_id     TEXT,
  team_id         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS otk_operation_attribution_project_idx ON otk_operation_attribution (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS otk_operation_attribution_task_run_idx ON otk_operation_attribution (tenant_id, task_run_id);
CREATE TABLE IF NOT EXISTS otk_attribution_statements (
  tenant_id     TEXT        NOT NULL,
  operation_id  TEXT        NOT NULL,
  digest        TEXT        NOT NULL,
  statement     JSONB       NOT NULL,
  envelope      JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
