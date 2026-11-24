-- D1-D8 / OVERNIGHT 20261005 (Phase 4): erasure tombstones. One row per erased operation, written in the same
-- transaction that removes its private material; keeps the identity (tenant, operation id, request digest) so a
-- retry of an erased operation is answered "erased" and never re-admitted (no second paid call). The pseudonym is
-- what the kept ledger rows now carry instead of the operation id. Additive and idempotent, rollback in
-- rollback/155_*.down.sql.
CREATE TABLE IF NOT EXISTS otk_erasure_tombstones (
  tenant_id               TEXT        NOT NULL,
  operation_id            TEXT        NOT NULL,
  request_digest          TEXT        NOT NULL,
  request_digest_version  TEXT,
  ledger_pseudonym        TEXT        NOT NULL,
  reason                  TEXT        NOT NULL,
  policy_version          TEXT        NOT NULL,
  erased_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
