-- Migration 003: Create user model tables (NEW-3.09, Wave 3C)
-- Organizations, users, memberships, invites

CREATE TABLE IF NOT EXISTS otk_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'FREE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otk_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT NOT NULL,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otk_memberships (
  user_id TEXT NOT NULL REFERENCES otk_users(id),
  org_id TEXT NOT NULL REFERENCES otk_organizations(id),
  role TEXT NOT NULL DEFAULT 'MEMBER',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE IF NOT EXISTS otk_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES otk_organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  invited_by TEXT NOT NULL REFERENCES otk_users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON otk_users (email);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON otk_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON otk_memberships (org_id);
CREATE INDEX IF NOT EXISTS idx_invites_org ON otk_invites (org_id);
CREATE INDEX IF NOT EXISTS idx_orgs_slug ON otk_organizations (slug);
