/**
 * R19 — version-aware on-chain submission (no network in this file).
 * The end-to-end check against a local chain is test/chain/onchain_submission_v1_v2.test.ts.
 *
 * Module under test: `src/prover/onChainSubmission.ts` (`REGISTRY_ABI`, `PUBLIC_SIGNAL_COUNT`,
 * `normalizeVersion`, `proofToSolidity`, `submitProofOnChain`).
 *
 * Strategy / partitions: public signal counts for circuit v1 (3) and v2 (4); conversion keeps all
 * four v2 signals and swaps the pi_b coordinates; a signal count that does not match the version;
 * version names "1"/"2" accepted and unknown ones refused; submission with no chain configured
 * (returns `null`) and a v2 proof when only a v1 registry is configured (refused before sending).
 *
 * Needs: nothing external. The refused case names an RPC URL on a closed local port and a random
 * in-memory key; it is rejected before any connection.
 *
 * Run just this file: `npx tsx --test test/unit/onchain_submission_r19.test.ts`
 *
 * @module test/unit/onchain_submission_r19.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  REGISTRY_ABI, PUBLIC_SIGNAL_COUNT, normalizeVersion, proofToSolidity, submitProofOnChain,
} from '../../src/prover/onChainSubmission.js';

const proof = { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] };
const input = { userId: '42', usage: '500', nonce: '0', epoch: '709' };

describe('R19 — submission selected by circuit version', () => {
  it('v1 uses uint256[3] and v2 uint256[4] public signals', () => {
    assert.match(REGISTRY_ABI.v1[0]!, /uint256\[3\] pubSignals/);
    assert.match(REGISTRY_ABI.v2[0]!, /uint256\[4\] pubSignals/);
    assert.deepEqual(PUBLIC_SIGNAL_COUNT, { v1: 3, v2: 4 });
  });

  it('keeps all four v2 signals and swaps pi_b coordinates', () => {
    const s = proofToSolidity('v2', proof, ['11', '709', '301', '900']);
    assert.deepEqual(s.pubSignals, [11n, 709n, 301n, 900n]);
    assert.deepEqual(s.b, [[4n, 3n], [6n, 5n]]);
  });

  it('rejects a signal count that does not match the version', () => {
    assert.throws(() => proofToSolidity('v2', proof, ['1', '2', '3']), /v2 expects 4/);
    assert.throws(() => proofToSolidity('v1', proof, ['1', '2', '3', '4']), /v1 expects 3/);
  });

  it('normalizes "1"/"2" and rejects unknown versions', () => {
    assert.equal(normalizeVersion('2'), 'v2');
    assert.equal(normalizeVersion(undefined), 'v1');
    assert.throws(() => normalizeVersion('v3'));
  });

  it('returns null when no chain is configured (dev mode)', async () => {
    const r = await submitProofOnChain('v2', input, { proof, publicSignals: ['1', '2', '3', '4'] }, { registry: {} });
    assert.equal(r, null);
  });

  it('refuses to send a v2 proof when only the v1 registry is configured', async () => {
    await assert.rejects(
      submitProofOnChain('v2', input, { proof, publicSignals: ['1', '2', '3', '4'] }, {
        rpcUrl: 'http://127.0.0.1:1', signerKey: Wallet.createRandom().privateKey, registry: { v1: Wallet.createRandom().address },
      }),
      /no registry configured for circuit v2/,
    );
  });
});
