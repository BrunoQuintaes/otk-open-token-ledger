/**
 * PgTeamStore — PostgreSQL-backed ITeamStore (W8-C TEAM-02)
 *
 * Tables: otk_teams, otk_team_memberships (see 010_teams.sql)
 *
 * The tables come from the SQL migration; this class creates nothing. Query errors propagate. At the evaluated
 * version no code in `src/` constructs it: `src/users/teamStore.ts` defaults to the in-memory store.
 *
 * @module src/infra/pg/PgTeamStore
 * @since W8-C TEAM-02
 */

import type { ITeamStore, Team, TeamMembership } from '../../users/TeamModel.js';

/** The part of a `pg` client or pool this store uses. */
export interface PgClient {
  /**
   * Runs one parameterized query.
   *
   * @param text - SQL text with `$n` placeholders.
   * @param params - Parameter values.
   * @returns The result rows.
   */
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** `ITeamStore` in the PostgreSQL tables `otk_teams` and `otk_team_memberships`. */
export class PgTeamStore implements ITeamStore {
  /**
   * Wraps a client or pool.
   *
   * @param db - PostgreSQL client or pool.
   */
  constructor(private readonly db: PgClient) {}

  /**
   * Inserts a team; does nothing when the id already exists.
   *
   * @param team - Team to create.
   */
  async createTeam(team: Team): Promise<void> {
    await this.db.query(
      `INSERT INTO otk_teams (id, name, owner_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [team.id, team.name, team.ownerId, team.createdAt],
    );
  }

  /**
   * Reads one team.
   *
   * @param teamId - Team id.
   * @returns The team, or null when unknown.
   */
  async getTeam(teamId: string): Promise<Team | null> {
    const { rows } = await this.db.query(
      `SELECT id, name, owner_id, created_at FROM otk_teams WHERE id = $1`,
      [teamId],
    );
    if (!rows[0]) return null;
    return rowToTeam(rows[0]);
  }

  /**
   * Lists the teams of an owner, oldest first.
   *
   * @param ownerId - Owner id.
   * @returns The teams.
   */
  async listTeams(ownerId: string): Promise<Team[]> {
    const { rows } = await this.db.query(
      `SELECT id, name, owner_id, created_at FROM otk_teams WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    return rows.map(rowToTeam);
  }

  /**
   * Deletes a team (memberships follow the table's foreign-key rules).
   *
   * @param teamId - Team id.
   */
  async deleteTeam(teamId: string): Promise<void> {
    await this.db.query(`DELETE FROM otk_teams WHERE id = $1`, [teamId]);
  }

  /**
   * Adds a tenant to a team, or updates its role when already a member.
   *
   * @param membership - Team, tenant, role and join time.
   */
  async addMember(membership: TeamMembership): Promise<void> {
    await this.db.query(
      `INSERT INTO otk_team_memberships (team_id, tenant_id, role, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [membership.teamId, membership.tenantId, membership.role, membership.joinedAt],
    );
  }

  /**
   * Removes a tenant from a team.
   *
   * @param teamId - Team id.
   * @param tenantId - Tenant id.
   */
  async removeMember(teamId: string, tenantId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM otk_team_memberships WHERE team_id = $1 AND tenant_id = $2`,
      [teamId, tenantId],
    );
  }

  /**
   * Lists the members of a team, by join time.
   *
   * @param teamId - Team id.
   * @returns The memberships.
   */
  async listMembers(teamId: string): Promise<TeamMembership[]> {
    const { rows } = await this.db.query(
      `SELECT team_id, tenant_id, role, joined_at FROM otk_team_memberships
       WHERE team_id = $1 ORDER BY joined_at`,
      [teamId],
    );
    return rows.map(rowToMembership);
  }

  /**
   * Lists the teams a tenant belongs to, oldest first.
   *
   * @param tenantId - Tenant id.
   * @returns The teams.
   */
  async getTeamsForTenant(tenantId: string): Promise<Team[]> {
    const { rows } = await this.db.query(
      `SELECT t.id, t.name, t.owner_id, t.created_at
       FROM otk_teams t
       JOIN otk_team_memberships m ON m.team_id = t.id
       WHERE m.tenant_id = $1
       ORDER BY t.created_at`,
      [tenantId],
    );
    return rows.map(rowToTeam);
  }
}

function rowToTeam(row: Record<string, unknown>): Team {
  return {
    id: String(row['id']),
    name: String(row['name']),
    ownerId: String(row['owner_id']),
    createdAt: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
  };
}

function rowToMembership(row: Record<string, unknown>): TeamMembership {
  return {
    teamId: String(row['team_id']),
    tenantId: String(row['tenant_id']),
    role: (row['role'] as 'admin' | 'member'),
    joinedAt: row['joined_at'] instanceof Date
      ? row['joined_at'].toISOString()
      : String(row['joined_at']),
  };
}
