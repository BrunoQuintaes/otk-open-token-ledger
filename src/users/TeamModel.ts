/**
 * TEAM-01 — TeamModel
 * Team and TeamMembership types + ITeamStore interface.
 *
 * @module users/TeamModel
 * @since W8-C TEAM-01
 */

/**
 * A team of tenants, owned by one tenant.
 */
export interface Team {
  id: string;
  name: string;
  ownerId: string;  // tenantId of the owner
  /** ISO-8601 creation time. */
  createdAt: string;
}

/**
 * Membership of a tenant in a team.
 */
export interface TeamMembership {
  teamId: string;
  tenantId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

/**
 * Storage backend for teams and their members.
 */
export interface ITeamStore {
  createTeam(team: Team): Promise<void>;
  getTeam(teamId: string): Promise<Team | null>;
  listTeams(ownerId: string): Promise<Team[]>;
  deleteTeam(teamId: string): Promise<void>;
  addMember(membership: TeamMembership): Promise<void>;
  removeMember(teamId: string, tenantId: string): Promise<void>;
  listMembers(teamId: string): Promise<TeamMembership[]>;
  getTeamsForTenant(tenantId: string): Promise<Team[]>;
}

/** In-memory implementation for dev/test */
export class MemoryTeamStore implements ITeamStore {
  private readonly teams = new Map<string, Team>();
  private readonly memberships = new Map<string, TeamMembership[]>();

  /**
   * Stores a copy of the team (replacing one with the same ID) and keeps its existing members.
   *
   * @param team - Team to store.
   */
  async createTeam(team: Team): Promise<void> {
    this.teams.set(team.id, { ...team });
    if (!this.memberships.has(team.id)) {
      this.memberships.set(team.id, []);
    }
  }

  /**
   * Reads a team.
   *
   * @param teamId - Team ID.
   * @returns The stored team object, or `null`.
   */
  async getTeam(teamId: string): Promise<Team | null> {
    return this.teams.get(teamId) ?? null;
  }

  /**
   * Lists the teams owned by a tenant.
   *
   * @param ownerId - Owner tenant ID.
   * @returns Copies of the matching teams.
   */
  async listTeams(ownerId: string): Promise<Team[]> {
    const result: Team[] = [];
    for (const team of this.teams.values()) {
      if (team.ownerId === ownerId) {
        result.push({ ...team });
      }
    }
    return result;
  }

  /**
   * Deletes a team and its memberships.
   *
   * @param teamId - Team ID.
   */
  async deleteTeam(teamId: string): Promise<void> {
    this.teams.delete(teamId);
    this.memberships.delete(teamId);
  }

  /**
   * Adds a tenant to a team, or replaces its membership when already present.
   *
   * @param membership - Membership to store (copied).
   */
  async addMember(membership: TeamMembership): Promise<void> {
    const members = this.memberships.get(membership.teamId) ?? [];
    const existing = members.findIndex(m => m.tenantId === membership.tenantId);
    if (existing >= 0) {
      members[existing] = { ...membership };
    } else {
      members.push({ ...membership });
    }
    this.memberships.set(membership.teamId, members);
  }

  /**
   * Removes a tenant from a team (no error when absent).
   *
   * @param teamId - Team ID.
   * @param tenantId - Tenant ID.
   */
  async removeMember(teamId: string, tenantId: string): Promise<void> {
    const members = this.memberships.get(teamId) ?? [];
    this.memberships.set(
      teamId,
      members.filter(m => m.tenantId !== tenantId),
    );
  }

  /**
   * Lists a team's members.
   *
   * @param teamId - Team ID.
   * @returns Copies of the memberships (empty for an unknown team).
   */
  async listMembers(teamId: string): Promise<TeamMembership[]> {
    return (this.memberships.get(teamId) ?? []).map(m => ({ ...m }));
  }

  /**
   * Lists the teams a tenant belongs to.
   *
   * @param tenantId - Tenant ID.
   * @returns Copies of those teams.
   */
  async getTeamsForTenant(tenantId: string): Promise<Team[]> {
    const result: Team[] = [];
    for (const [teamId, members] of this.memberships.entries()) {
      if (members.some(m => m.tenantId === tenantId)) {
        const team = this.teams.get(teamId);
        if (team) result.push({ ...team });
      }
    }
    return result;
  }
}
