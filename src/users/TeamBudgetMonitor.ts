/**
 * TEAM-09 — TeamBudgetMonitor
 * Checks team spend against configured budget limits.
 *
 * In-memory monitor that allows per-team daily and monthly spending limits
 * to be set and evaluated. Designed to be called from the billing/proxy path
 * after each receipt is stored.
 *
 * @module users/TeamBudgetMonitor
 * @since W8-C TEAM-09
 */

export interface TeamBudget {
  teamId: string;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  limitUsd: number;
  spendUsd: number;
}

/**
 * TeamBudgetMonitor — per-team spend limit enforcement.
 *
 * Usage:
 *   const monitor = new TeamBudgetMonitor();
 *   monitor.setBudget({ teamId: 'team-1', dailyLimitUsd: 10, monthlyLimitUsd: 100 });
 *   const result = monitor.checkBudget('team-1', 12.5, 'daily');
 *   // → { exceeded: true, limitUsd: 10, spendUsd: 12.5 }
 */
export class TeamBudgetMonitor {
  private readonly budgets = new Map<string, TeamBudget>();

  /**
   * Set or overwrite the budget for a team.
   */
  setBudget(budget: TeamBudget): void {
    this.budgets.set(budget.teamId, { ...budget });
  }

  /**
   * Check whether a team's current spend exceeds its configured budget for the period.
   * Returns `exceeded: false` with `limitUsd: 0` if no budget is configured for the team.
   *
   * @param teamId         - Team identifier
   * @param currentSpendUsd - The team's total spend in USD for the period
   * @param period          - 'daily' or 'monthly'
   */
  checkBudget(
    teamId: string,
    currentSpendUsd: number,
    period: 'daily' | 'monthly',
  ): BudgetCheckResult {
    const budget = this.budgets.get(teamId);
    if (!budget) {
      return { exceeded: false, limitUsd: 0, spendUsd: currentSpendUsd };
    }
    const limitUsd = period === 'daily' ? budget.dailyLimitUsd : budget.monthlyLimitUsd;
    return {
      exceeded: currentSpendUsd > limitUsd,
      limitUsd,
      spendUsd: currentSpendUsd,
    };
  }

  /**
   * Retrieve the budget configuration for a team.
   * Returns null if no budget has been set.
   */
  getBudget(teamId: string): TeamBudget | null {
    return this.budgets.get(teamId) ?? null;
  }
}

// ── Module-level singleton ───────────────────────────────────────────────────

let _monitorInstance: TeamBudgetMonitor | undefined;

export function getTeamBudgetMonitor(): TeamBudgetMonitor {
  if (!_monitorInstance) {
    _monitorInstance = new TeamBudgetMonitor();
  }
  return _monitorInstance;
}

export function resetTeamBudgetMonitorForTest(): void {
  _monitorInstance = undefined;
}
