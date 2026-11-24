-- Migration 002: Create API keys table (NEW-3.06, Wave 3C)
-- Per-tenant API key metadata. Raw key never stored — only SHA-256 hash.

CREATE TABLE IF NOT EXISTS otk_api_keys (
  key_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON otk_api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON otk_api_keys (token_hash);
