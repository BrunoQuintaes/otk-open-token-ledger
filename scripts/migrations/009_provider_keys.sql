-- 009_provider_keys.sql
-- W8-B VAULT-02: Per-tenant encrypted provider API keys
--
-- Stores AES-256-GCM encrypted provider API keys (encryptedKey + iv + tag).
-- Master key lives outside the database (OTK_VAULT_MASTER_KEY env var).
-- Only ciphertext is persisted — plaintext keys are never written to disk.

CREATE TABLE IF NOT EXISTS otk_provider_keys (
  id            SERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv            TEXT NOT NULL,
  tag           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_tenant ON otk_provider_keys(tenant_id);
