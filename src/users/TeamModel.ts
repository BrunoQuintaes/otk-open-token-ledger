/**
 * TEAM-01 — TeamModel
 * Team and TeamMembership types + ITeamStore interface.
 *
 * @module users/TeamModel
 * @since W8-C TEAM-01
 */

export interface Team {
  id: string;
  name: string;
  ownerId: string;  // tenantId of the owner
  createdAt: string;
}

export interface TeamMembership {
  teamId: string;
  tenantId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

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

  async createTeam(team: Team): Promise<void> {
    this.teams.set(team.id, { ...team });
    if (!this.memberships.has(team.id)) {
      this.memberships.set(team.id, []);
    }
  }

  async getTeam(teamId: string): Promise<Team | null> {
    return this.teams.get(teamId) ?? null;
  }

  async listTeams(ownerId: string): Promise<Team[]> {
    const result: Team[] = [];
    for (const team of this.teams.values()) {
      if (team.ownerId === ownerId) {
        result.push({ ...team });
      }
    }
    return result;
  }

  async deleteTeam(teamId: string): Promise<void> {
    this.teams.delete(teamId);
    this.memberships.delete(teamId);
  }

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

  async removeMember(teamId: string, tenantId: string): Promise<void> {
    const members = this.memberships.get(teamId) ?? [];
    this.memberships.set(
      teamId,
      members.filter(m => m.tenantId !== tenantId),
    );
  }

  async listMembers(teamId: string): Promise<TeamMembership[]> {
    return (this.memberships.get(teamId) ?? []).map(m => ({ ...m }));
  }

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
