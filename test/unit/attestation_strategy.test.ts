/**
 * attestation_strategy — unit tests for IAttestationStrategy implementations.
 *
 * D1-G07 (run 20260930-1625, S4): 'provider_signed' was renamed 'operator_recount' (no provider
 * signature exists); the old class/singleton names stay as @deprecated re-exports and the old
 * ATTESTATION_MODE value as a read alias. Assertions on the id were updated accordingly.
 *
 * Tests:
 *   1. ProviderSignedStrategy.attest() resolves and returns valid attestation
 *   2. FutureProofStrategy.attest() throws AttestationNotImplementedError (NOT_IMPLEMENTED)
 *   3. AttestationStrategyFactory.resolve() defaults to operator_recount
 *   4. AttestationStrategyFactory.get() resolves by explicit id
 *   5. AttestationStrategyFactory.listStrategies() returns both ids
 *   6. resolveAttestationMode() defaults to 'provider_signed'
 *   7. Interface contract: strategyId, description are strings on both implementations
 *   8. AttestationNotImplementedError has correct code and strategyId
 *   9. defaultAttestationStrategy is provider_signed
 *
 * Since the rename above, items 6 and 9 hold under the new id: the default mode and the default
 * strategy are `operator_recount`, and `provider_signed` is accepted only as a legacy alias.
 *
 * Modules under test: the strategies in `src/oracle/attestation/` (`OperatorRecountStrategy` and
 * its deprecated alias `ProviderSignedStrategy`, `FutureProofStrategy`,
 * `AttestationStrategyFactory`, `IAttestationStrategy` with `AttestationNotImplementedError`).
 *
 * Strategy / partitions: the working strategy (fields, level, stateless output, class and
 * singleton); the not-yet-implemented strategy (always throws, with the right code, message and
 * strategy id); factory resolution by default, by explicit id and by the legacy id; the mode
 * read from the environment when absent and when set to the legacy value; the shared interface
 * contract for every registered strategy; the alias objects are the same objects as the new ones.
 *
 * Needs: nothing external. Reads `ATTESTATION_MODE`; the default-value assertions run only when
 * it is unset, and the legacy-alias test sets it and restores the previous value.
 *
 * Run just this file: `npx tsx --test test/unit/attestation_strategy.test.ts`
 *
 * @since U12.9.1
 * @module test/unit/attestation_strategy.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderSignedStrategy,
  providerSignedStrategy,
} from '../../src/oracle/attestation/ProviderSignedStrategy.js';

import {
  FutureProofStrategy,
  futureProofStrategy,
} from '../../src/oracle/attestation/FutureProofStrategy.js';

import {
  AttestationStrategyFactory,
  resolveAttestationMode,
  defaultAttestationStrategy,
} from '../../src/oracle/attestation/AttestationStrategyFactory.js';

import {
  AttestationNotImplementedError,
} from '../../src/oracle/attestation/IAttestationStrategy.js';

import type { AttestationInput } from '../../src/oracle/attestation/IAttestationStrategy.js';

// ---------------------------------------------------------------------------
// Minimal valid input for attestation
// ---------------------------------------------------------------------------
const SAMPLE_INPUT: AttestationInput = {
  provider: 'openai',
  model: 'gpt-4o',
  promptText: 'What is 2+2?',
  completionText: '2+2 equals 4.',
  providerInputTokens: 8,
  providerOutputTokens: 6,
  discrepancyThresholdPct: 20,
};

// ---------------------------------------------------------------------------
// 1. ProviderSignedStrategy — attest() resolves
// ---------------------------------------------------------------------------
describe('ProviderSignedStrategy', () => {
  it('strategyId is operator_recount (D1-G07)', () => {
    assert.strictEqual(providerSignedStrategy.strategyId, 'operator_recount');
  });

  it('description is a non-empty string', () => {
    assert.ok(typeof providerSignedStrategy.description === 'string');
    assert.ok(providerSignedStrategy.description.length > 0);
  });

  it('attest() returns a valid AttestationResult', () => {
    const result = providerSignedStrategy.attest(SAMPLE_INPUT);
    assert.ok(result !== null && typeof result === 'object');
    assert.ok('attestation' in result);
    assert.ok('clientCount' in result);
    assert.ok('discrepancy' in result);
  });

  it('attestation has required fields', () => {
    const { attestation } = providerSignedStrategy.attest(SAMPLE_INPUT);
    assert.ok('level' in attestation);
    assert.ok('promptHash' in attestation);
    assert.ok('completionHash' in attestation);
    assert.ok('tokenizerId' in attestation);
    assert.ok('clientInputTokens' in attestation);
    assert.ok('clientOutputTokens' in attestation);
    assert.ok('tokenCountCommitment' in attestation);
    assert.ok('discrepancyFlagged' in attestation);
  });

  it('attestation.level is A or C', () => {
    const { attestation } = providerSignedStrategy.attest(SAMPLE_INPUT);
    assert.ok(attestation.level === 'A' || attestation.level === 'C');
  });

  it('same input produces same output (stateless)', () => {
    const r1 = providerSignedStrategy.attest(SAMPLE_INPUT);
    const r2 = providerSignedStrategy.attest(SAMPLE_INPUT);
    assert.strictEqual(r1.attestation.promptHash, r2.attestation.promptHash);
    assert.strictEqual(r1.attestation.completionHash, r2.attestation.completionHash);
    assert.strictEqual(r1.clientCount.inputTokens, r2.clientCount.inputTokens);
  });

  it('new ProviderSignedStrategy() also works', () => {
    const s = new ProviderSignedStrategy();
    const result = s.attest(SAMPLE_INPUT);
    assert.ok('attestation' in result);
  });

  it('providerSignedStrategy singleton is a ProviderSignedStrategy instance', () => {
    assert.ok(providerSignedStrategy instanceof ProviderSignedStrategy);
  });
});

// ---------------------------------------------------------------------------
// 2. FutureProofStrategy — attest() throws NOT_IMPLEMENTED
// ---------------------------------------------------------------------------
describe('FutureProofStrategy', () => {
  it('strategyId is tee_tls_notary', () => {
    assert.strictEqual(futureProofStrategy.strategyId, 'tee_tls_notary');
  });

  it('description mentions TEE and TLSNotary', () => {
    const desc = futureProofStrategy.description;
    assert.ok(desc.includes('TEE') || desc.includes('TLSNotary'), `description: ${desc}`);
  });

  it('attest() throws AttestationNotImplementedError', () => {
    assert.throws(
      () => futureProofStrategy.attest(SAMPLE_INPUT),
      (err: unknown) => err instanceof AttestationNotImplementedError,
      'expected AttestationNotImplementedError'
    );
  });

  it('thrown error message contains NOT_IMPLEMENTED', () => {
    try {
      futureProofStrategy.attest(SAMPLE_INPUT);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('NOT_IMPLEMENTED'), `message: ${err.message}`);
    }
  });

  it('thrown error has correct code', () => {
    try {
      futureProofStrategy.attest(SAMPLE_INPUT);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof AttestationNotImplementedError);
      assert.strictEqual(err.code, 'ATTESTATION_NOT_IMPLEMENTED');
    }
  });

  it('thrown error strategyId is tee_tls_notary', () => {
    try {
      futureProofStrategy.attest(SAMPLE_INPUT);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof AttestationNotImplementedError);
      assert.strictEqual(err.strategyId, 'tee_tls_notary');
    }
  });

  it('new FutureProofStrategy() also throws on attest()', () => {
    const s = new FutureProofStrategy();
    assert.throws(() => s.attest(SAMPLE_INPUT), AttestationNotImplementedError);
  });

  it('futureProofStrategy singleton is a FutureProofStrategy instance', () => {
    assert.ok(futureProofStrategy instanceof FutureProofStrategy);
  });
});

// ---------------------------------------------------------------------------
// 3. AttestationStrategyFactory — resolve() defaults to operator_recount
// ---------------------------------------------------------------------------
describe('AttestationStrategyFactory.resolve()', () => {
  it('returns a strategy (not null/undefined)', () => {
    const s = AttestationStrategyFactory.resolve();
    assert.ok(s !== null && s !== undefined);
  });

  it('resolved strategy has a non-empty strategyId', () => {
    const s = AttestationStrategyFactory.resolve();
    assert.ok(typeof s.strategyId === 'string');
    assert.ok(s.strategyId.length > 0);
  });

  it('defaults to operator_recount when ATTESTATION_MODE env not set', () => {
    if (!process.env['ATTESTATION_MODE']) {
      const s = AttestationStrategyFactory.resolve();
      assert.strictEqual(s.strategyId, 'operator_recount');
    }
    // If env is set, we validate it's a known strategy
    const s = AttestationStrategyFactory.resolve();
    assert.ok(['operator_recount', 'tee_tls_notary'].includes(s.strategyId));
  });
});

// ---------------------------------------------------------------------------
// 4. AttestationStrategyFactory.get() — explicit resolution
// ---------------------------------------------------------------------------
describe('AttestationStrategyFactory.get()', () => {
  it('get(provider_signed) returns ProviderSignedStrategy', () => {
    const s = AttestationStrategyFactory.get('provider_signed');
    assert.strictEqual(s.strategyId, 'operator_recount');
    assert.ok(s instanceof ProviderSignedStrategy);
  });

  it('get(tee_tls_notary) returns FutureProofStrategy', () => {
    const s = AttestationStrategyFactory.get('tee_tls_notary');
    assert.strictEqual(s.strategyId, 'tee_tls_notary');
    assert.ok(s instanceof FutureProofStrategy);
  });

  it('get(provider_signed).attest() resolves without throwing', () => {
    const s = AttestationStrategyFactory.get('provider_signed');
    assert.doesNotThrow(() => s.attest(SAMPLE_INPUT));
  });

  it('get(tee_tls_notary).attest() throws NOT_IMPLEMENTED', () => {
    const s = AttestationStrategyFactory.get('tee_tls_notary');
    assert.throws(
      () => s.attest(SAMPLE_INPUT),
      AttestationNotImplementedError
    );
  });
});

// ---------------------------------------------------------------------------
// 5. AttestationStrategyFactory.listStrategies()
// ---------------------------------------------------------------------------
describe('AttestationStrategyFactory.listStrategies()', () => {
  it('returns an array', () => {
    assert.ok(Array.isArray(AttestationStrategyFactory.listStrategies()));
  });

  it('includes both operator_recount and tee_tls_notary', () => {
    const ids = AttestationStrategyFactory.listStrategies();
    assert.ok(ids.includes('operator_recount'), 'missing operator_recount');
    assert.ok(ids.includes('tee_tls_notary'), 'missing tee_tls_notary');
  });
});

// ---------------------------------------------------------------------------
// 6. resolveAttestationMode()
// ---------------------------------------------------------------------------
describe('resolveAttestationMode()', () => {
  it('returns a known strategy id', () => {
    const mode = resolveAttestationMode();
    assert.ok(['operator_recount', 'tee_tls_notary'].includes(mode),
      `unknown mode: ${mode}`);
  });

  it('defaults to operator_recount when env is absent', () => {
    if (!process.env['ATTESTATION_MODE']) {
      assert.strictEqual(resolveAttestationMode(), 'operator_recount');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Interface contract
// ---------------------------------------------------------------------------
describe('IAttestationStrategy interface contract', () => {
  const strategies = [providerSignedStrategy, futureProofStrategy];

  for (const s of strategies) {
    it(`${s.strategyId}: strategyId is a non-empty string`, () => {
      assert.ok(typeof s.strategyId === 'string' && s.strategyId.length > 0);
    });

    it(`${s.strategyId}: description is a non-empty string`, () => {
      assert.ok(typeof s.description === 'string' && s.description.length > 0);
    });

    it(`${s.strategyId}: attest is a function`, () => {
      assert.ok(typeof s.attest === 'function');
    });
  }
});

// ---------------------------------------------------------------------------
// 8. AttestationNotImplementedError properties
// ---------------------------------------------------------------------------
describe('AttestationNotImplementedError', () => {
  it('is an Error subclass', () => {
    const err = new AttestationNotImplementedError('tee_tls_notary', 'test detail');
    assert.ok(err instanceof Error);
  });

  it('name is AttestationNotImplementedError', () => {
    const err = new AttestationNotImplementedError('tee_tls_notary', 'test');
    assert.strictEqual(err.name, 'AttestationNotImplementedError');
  });

  it('code is ATTESTATION_NOT_IMPLEMENTED', () => {
    const err = new AttestationNotImplementedError('tee_tls_notary', 'test');
    assert.strictEqual(err.code, 'ATTESTATION_NOT_IMPLEMENTED');
  });

  it('strategyId is preserved', () => {
    const err = new AttestationNotImplementedError('tee_tls_notary', 'test');
    assert.strictEqual(err.strategyId, 'tee_tls_notary');
  });

  it('message contains NOT_IMPLEMENTED', () => {
    const err = new AttestationNotImplementedError('tee_tls_notary', 'some detail');
    assert.ok(err.message.includes('NOT_IMPLEMENTED'));
  });
});

// ---------------------------------------------------------------------------
// 9. defaultAttestationStrategy export
// ---------------------------------------------------------------------------
describe('defaultAttestationStrategy', () => {
  it('is an IAttestationStrategy with strategyId string', () => {
    assert.ok(typeof defaultAttestationStrategy.strategyId === 'string');
    assert.ok(typeof defaultAttestationStrategy.attest === 'function');
  });

  it('is operator_recount when no env override', () => {
    if (!process.env['ATTESTATION_MODE']) {
      assert.strictEqual(defaultAttestationStrategy.strategyId, 'operator_recount');
    }
  });
});

// ---------------------------------------------------------------------------
// D1-G07 acceptance (A/ESPEC_NOMES_D1G07.md §1)
// ---------------------------------------------------------------------------
import { OperatorRecountStrategy, operatorRecountStrategy } from '../../src/oracle/attestation/OperatorRecountStrategy.js';

describe('D1-G07 — operator recount naming', () => {
  it('new id and class; the deprecated names are the same objects (explicit alias)', () => {
    assert.strictEqual(operatorRecountStrategy.strategyId, 'operator_recount');
    assert.strictEqual(ProviderSignedStrategy, OperatorRecountStrategy);
    assert.strictEqual(providerSignedStrategy, operatorRecountStrategy);
  });

  it("legacy id 'provider_signed' resolves to operator_recount (read alias)", () => {
    assert.strictEqual(AttestationStrategyFactory.get('provider_signed').strategyId, 'operator_recount');
    const prev = process.env['ATTESTATION_MODE'];
    process.env['ATTESTATION_MODE'] = 'provider_signed';
    try { assert.strictEqual(resolveAttestationMode(), 'operator_recount'); } finally { if (prev === undefined) delete process.env['ATTESTATION_MODE']; else process.env['ATTESTATION_MODE'] = prev; }
  });

  it('description never claims a provider signature', () => {
    assert.doesNotMatch(operatorRecountStrategy.description, /provider-signed/i);
    assert.match(operatorRecountStrategy.description, /not a provider signature/);
  });
});
