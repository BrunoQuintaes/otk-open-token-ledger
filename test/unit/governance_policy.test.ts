/**
 * G3 — Governance Policy behavioral tests
 *
 * Validates the governance evaluation contract:
 *   - evaluateGovernanceProposal is pure (injectable nowIso)
 *   - Regular kinds are approved
 *   - circuit_upgrade and emergency_pause are rejected
 *   - Stale proposals are deferred
 *   - DEFAULT_GOVERNANCE_POLICY has expected values
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGovernanceProposal,
  DEFAULT_GOVERNANCE_POLICY,
  type GovernanceProposal,
} from '../../src/governance/governancePolicy.js';

const NOW_ISO = '2026-03-06T14:00:00.000Z';
const RECENT_ISO = '2026-03-06T12:00:00.000Z'; // 2h ago — fresh
const STALE_ISO  = '2026-02-01T00:00:00.000Z'; // >7d ago — stale

function makeProposal(kind: GovernanceProposal['kind'], proposedAt = RECENT_ISO): GovernanceProposal {
  return {
    proposalId: `test-${kind}`,
    kind,
    proposer: 'operator-1',
    proposedAt,
    rationale: `Test proposal for ${kind}`,
    payload: {},
  };
}

describe('Governance Policy — DEFAULT_GOVERNANCE_POLICY', () => {
  it('quorumFraction is 0.51', () => {
    assert.equal(DEFAULT_GOVERNANCE_POLICY.quorumFraction, 0.51);
  });

  it('requiresEmergencyOverride includes circuit_upgrade and emergency_pause', () => {
    assert.ok(DEFAULT_GOVERNANCE_POLICY.requiresEmergencyOverride.includes('circuit_upgrade'));
    assert.ok(DEFAULT_GOVERNANCE_POLICY.requiresEmergencyOverride.includes('emergency_pause'));
  });

  it('maxProposalAgeSecs is 7 days (604800s)', () => {
    assert.equal(DEFAULT_GOVERNANCE_POLICY.maxProposalAgeSecs, 86_400 * 7);
  });
});

describe('Governance Policy — evaluateGovernanceProposal (pure)', () => {
  it('approves price_table_update (regular kind)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('price_table_update'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'approved');
    assert.ok(decision.reason.includes('price_table_update'));
  });

  it('approves valuation_policy (regular kind)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('valuation_policy'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'approved');
  });

  it('approves oracle_config (regular kind)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('oracle_config'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'approved');
  });

  it('rejects circuit_upgrade (requires emergency override)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('circuit_upgrade'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'rejected');
    assert.ok(decision.reason.includes('emergency override'));
  });

  it('rejects emergency_pause (requires emergency override)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('emergency_pause'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'rejected');
  });

  it('defers stale proposal (older than maxProposalAgeSecs)', () => {
    const decision = evaluateGovernanceProposal(makeProposal('price_table_update', STALE_ISO), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.decision, 'deferred');
    assert.ok(decision.reason.includes('expired'));
  });

  it('evaluatedAt matches injected nowIso', () => {
    const decision = evaluateGovernanceProposal(makeProposal('valuation_policy'), DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.evaluatedAt, NOW_ISO);
  });

  it('proposalId is preserved in decision', () => {
    const p = makeProposal('oracle_config');
    const decision = evaluateGovernanceProposal(p, DEFAULT_GOVERNANCE_POLICY, NOW_ISO);
    assert.equal(decision.proposalId, p.proposalId);
  });
});
