-- 010_teams.sql
-- W8-C TEAM-03: Teams + memberships tables

CREATE TABLE IF NOT EXISTS otk_teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otk_team_memberships (
  team_id   TEXT NOT NULL REFERENCES otk_teams(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_owner ON otk_teams (owner_id);
CREATE INDEX IF NOT EXISTS idx_team_memberships_tenant ON otk_team_memberships (tenant_id);
