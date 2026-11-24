/**
 * G3 — Governance Policy (pure, minimal)
 *
 * Defines the minimal governance structure for OTK protocol evolution.
 * Covers: proposal types, evaluation rules, operator-level policy.
 *
 * In scope: types, pure evaluation, documentation contracts.
 * Out of scope: DAO, on-chain governance, token voting, treasury automation.
 *
 * See: docs/governance/oracle_governance.md
 * Dissertacao: Cap 5 — Limitações e Trabalhos Futuros
 *
 * @module governance/governancePolicy
 * @since G3
 */

/** Kinds of governance proposals supported at the operator level. */
export type GovernanceProposalKind =
  | 'price_table_update'   // Update ProviderPriceTable version (usdPer1K rates)
  | 'valuation_policy'     // Update DEFAULT_VALUATION_POLICY (usdPerCU)
  | 'oracle_config'        // Update oracle snapshot rate/epoch
  | 'circuit_upgrade'      // Upgrade ZK circuit — always rejected (manual ceremony required)
  | 'emergency_pause';     // Pause metering — always requires emergency override

/** A governance proposal submitted by an operator or tenant. */
export type GovernanceProposal = {
  /** Unique proposal identifier */
  proposalId: string;
  /** Kind of change being proposed */
  kind: GovernanceProposalKind;
  /** Proposer identity (tenantId or operator key) */
  proposer: string;
  /** ISO-8601 timestamp when the proposal was submitted */
  proposedAt: string;
  /** Human-readable rationale (required for audit trail) */
  rationale: string;
  /** Kind-specific payload (type-checked by kind at evaluation time) */
  payload: Record<string, unknown>;
};

/** The outcome of evaluating a proposal against a GovernancePolicy. */
export type GovernanceDecision = {
  proposalId: string;
  decision: 'approved' | 'rejected' | 'deferred';
  reason: string;
  evaluatedAt: string;
};

/** Operator-level governance rules. */
export type GovernancePolicy = {
  /** Minimum quorum fraction (0–1) required for approval */
  quorumFraction: number;
  /**
   * Proposal kinds that require an emergency override to proceed.
   * evaluateGovernanceProposal always rejects these automatically.
   */
  requiresEmergencyOverride: GovernanceProposalKind[];
  /** Maximum proposal age before auto-defer (unix seconds) */
  maxProposalAgeSecs: number;
};

/**
 * Default governance policy — minimal, deterministic.
 *
 * - quorumFraction=0.51: simple majority
 * - circuit_upgrade and emergency_pause always require manual override
 * - maxProposalAgeSecs=7d: stale proposals auto-deferred
 */
export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  quorumFraction: 0.51,
  requiresEmergencyOverride: ['circuit_upgrade', 'emergency_pause'],
  maxProposalAgeSecs: 86_400 * 7,
} as const;

/**
 * Evaluate a governance proposal against a policy.
 * Pure function — no I/O, no side effects, no external calls.
 *
 * Rules (in priority order):
 *   1. Stale proposal → deferred
 *   2. Kind requires emergency override → rejected
 *   3. Regular kind → approved (quorum assumed by caller)
 *
 * @param proposal  - Proposal to evaluate
 * @param policy    - Governance rules (defaults to DEFAULT_GOVERNANCE_POLICY)
 * @param nowIso    - Current time ISO string (injectable for determinism)
 */
export function evaluateGovernanceProposal(
  proposal: GovernanceProposal,
  policy: GovernancePolicy = DEFAULT_GOVERNANCE_POLICY,
  nowIso?: string,
): GovernanceDecision {
  const now = nowIso ?? new Date().toISOString();
  const nowEpoch = new Date(now).getTime() / 1_000;
  const proposedEpoch = new Date(proposal.proposedAt).getTime() / 1_000;
  const ageSecs = Math.max(0, nowEpoch - proposedEpoch);

  if (ageSecs > policy.maxProposalAgeSecs) {
    return {
      proposalId: proposal.proposalId,
      decision: 'deferred',
      reason: `Proposal expired: age=${Math.floor(ageSecs)}s > max=${policy.maxProposalAgeSecs}s`,
      evaluatedAt: now,
    };
  }

  if (policy.requiresEmergencyOverride.includes(proposal.kind)) {
    return {
      proposalId: proposal.proposalId,
      decision: 'rejected',
      reason: `Kind '${proposal.kind}' requires emergency override — auto-approval not permitted`,
      evaluatedAt: now,
    };
  }

  return {
    proposalId: proposal.proposalId,
    decision: 'approved',
    reason: `Kind '${proposal.kind}' approved under quorum=${policy.quorumFraction}`,
    evaluatedAt: now,
  };
}
