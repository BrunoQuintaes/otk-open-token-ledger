-- Migration 006: Create webhook tables (Wave 4 / E6.6)
-- Webhook endpoints, delivery log, and dead-letter queue

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  url          TEXT NOT NULL,
  events       TEXT NOT NULL DEFAULT '*',  -- JSON array of event kinds
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  secret       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active ON webhook_endpoints (active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS webhook_delivery_log (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_kind   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempt      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL CHECK (status IN ('success', 'failed', 'pending')),
  status_code  INTEGER,
  error        TEXT,
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_endpoint ON webhook_delivery_log (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_status ON webhook_delivery_log (status);

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL,
  event_kind   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  last_error   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replayed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_endpoint ON webhook_dead_letters (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_replayed ON webhook_dead_letters (replayed_at) WHERE replayed_at IS NULL;
