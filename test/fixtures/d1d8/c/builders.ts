/**
 * D1–D8 / C — hand-built contract objects for C's tests (synthetic values, no real payloads).
 * Numbers are chosen so expected results can be checked by hand.
 *
 * Used by the operation-store, spool, outbox, proof, recovery, money and audit tests of the durable operation
 * layer (`src/operations`, under `test/services` and `test/unit`). CU values are scaled integers with scale
 * 1_000_000 (micro-CU); money values use scale 10^12 (pico-USD). Every digest is a repeated-byte placeholder and
 * the chain addresses are fake. Pure data builders: no I/O.
 *
 * @module test/fixtures/d1d8/c/builders
 */
import type {
  CommitmentOpening, ConferenceReport, CuResult, FrozenConfigRef, NormalizedUsage, OperationKey,
  PrivateReceiptV3, Reservation, Scaled,
} from '../../../../src/types/d1d8/index.js';
import type { AdmitRequest } from '../../../../src/types/d1d8/index.js';
import { MONEY_BOUND_POLICY } from '../../../../src/operations/moneyBound.js';

/**
 * Converts a whole number of CU into the scaled form used by the contracts.
 *
 * @param n - Whole CU (a `number` must be an integer, or `BigInt` throws a RangeError).
 * @returns `{ units: n × 1_000_000, scale: 1_000_000 }` (micro-CU).
 */
export const CU = (n: bigint | number): Scaled => ({ units: BigInt(n) * 1_000_000n, scale: 1_000_000n });

/**
 * Frozen configuration shared by every C fixture: test weights and catalog, the CU_MULT_v2_micro formula, the fixed
 * 1000-CU bucket policy, circuit `metering_v3@test` and a fake local chain (id 1337). Shared object; do not mutate.
 */
export const CONFIG: FrozenConfigRef = {
  cuWeights: { version: 'cw-test-1', digest: `0x${'11'.repeat(32)}` },
  cuFormula: 'CU_MULT_v2_micro',
  priceTable: null,
  modelCatalog: { version: 'catalog-test-1', digest: `0x${'22'.repeat(32)}` },
  bucketPolicy: { version: 'otk.public_bucket.fixed@1:width=1000CU:unit=microCU', digest: `0x${'33'.repeat(32)}` },
  circuitId: 'metering_v3@test',
  chain: { chainId: 1337n, registry: '0x00000000000000000000000000000000000000a1', verifier: '0x00000000000000000000000000000000000000b2', schemaVersion: 'otk.registry.v3' },
  developmentProfile: true,
};

/**
 * Builds a held reservation on the `known_cu` basis.
 *
 * @param cu - Reserved CU, in whole CU.
 * @param money - Reserved money in pico-USD (USD × 10^12); `null` (default) means no money reservation.
 * @returns A new `Reservation` in state `held`.
 */
export function reservation(cu: bigint, money: bigint | null = null): Reservation {
  return { cu: CU(cu), money: money === null ? null : { units: money, scale: 1_000_000_000_000n, currency: 'USD' }, basis: 'known_cu', state: 'held' };
}

/**
 * A fixture money reservation stands for a strict one made under the default bound policy, which is
 * what a budget requires since RV2-01 (fechamento pós-S5); `policy: null` builds a non-strict one.
 *
 * Builds an admission request for one OpenAI chat-completions call (gpt-4o-mini, at most 256 output tokens and
 * 60 000 ms, no cost cap) with the shared {@link CONFIG}.
 *
 * @param key - Tenant and operation identifiers of the request.
 * @param cu - Reserved CU, in whole CU.
 * @param opts - `digest`: request digest (default `0xaa…aa`); `money`: reserved pico-USD or `null` (default none);
 *   `policy`: money-bound policy id; when omitted it is the default policy if `money` is set and none otherwise,
 *   and `null` forces none.
 * @returns A new `AdmitRequest`.
 */
export function admitReq(key: OperationKey, cu: bigint, opts: { digest?: string; money?: bigint | null; policy?: string | null } = {}): AdmitRequest {
  const policy = opts.policy === undefined ? (opts.money != null ? MONEY_BOUND_POLICY.id : null) : opts.policy;
  return {
    key,
    requestDigest: (opts.digest ?? `0x${'aa'.repeat(32)}`) as AdmitRequest['requestDigest'],
    provider: 'openai',
    api: 'openai.chat_completions',
    modelRequested: 'gpt-4o-mini',
    reservation: reservation(cu, opts.money ?? null),
    limits: { maxOutputTokens: 256n, maxDurationMs: 60_000n, maxCost: null, ...(policy ? { moneyBoundPolicy: policy } : {}) },
    config: CONFIG,
  };
}

/**
 * Builds a complete normalized usage record for an OpenAI chat-completions response.
 *
 * @param tIn - Input tokens.
 * @param tOut - Output tokens.
 * @param extra - Fields that override the defaults (shallow spread, applied last; not type-checked).
 * @returns A new `NormalizedUsage`; the cached-input category is present with an unknown (`null`) count.
 */
export function usage(tIn: bigint, tOut: bigint, extra: Record<string, unknown> = {}): NormalizedUsage {
  return {
    schema: 'otk.usage.v1',
    api: 'openai.chat_completions',
    provider: 'openai',
    modelRequested: 'gpt-4o-mini',
    modelReturned: 'gpt-4o-mini-2024-07-18',
    providerRequestId: 'chatcmpl-test',
    origin: 'provider_response',
    completeness: 'complete',
    categories: [
      { name: 'input', count: tIn, inclusion: 'base', sourceField: 'usage.prompt_tokens' },
      { name: 'output', count: tOut, inclusion: 'base', sourceField: 'usage.completion_tokens' },
      { name: 'input_cache_read', count: null, inclusion: 'subset_of_input', sourceField: 'usage.prompt_tokens_details.cached_tokens' },
    ],
    tIn,
    tOut,
    tRule: 'otk.t_rule.v1',
    rawUsageDigest: `0x${'44'.repeat(32)}`,
    normalizerVersion: 'test',
    docRef: { url: 'https://example.invalid/doc', retrievedAt: '2026-09-30T00:00:00.000Z' },
    observedAt: '2026-10-01T12:00:00.000Z',
    ...extra,
  } as NormalizedUsage;
}

/**
 * Builds a computed CU result for 100 input + 20 output tokens with model weight 0.400 and provider weight 1.000.
 *
 * @param cu - CU to record, in whole CU; it is not recomputed from the tokens (48 matches the weights).
 * @returns A new `CuResult` with status `computed`.
 */
export function cuResult(cu: bigint): CuResult {
  return {
    schema: 'otk.cu_result.v1', status: 'computed', cu: CU(cu), formula: 'CU_MULT_v2_micro',
    weights: CONFIG.cuWeights, tIn: 100n, tOut: 20n, wModelMilli: 400n, wProviderMilli: 1000n, developmentProfile: true,
  };
}

/**
 * Builds a private v3 receipt for 100 input + 20 output tokens with a fixed public commitment and user reference.
 *
 * @param key - Tenant and operation identifiers of the receipt.
 * @param cu - CU recorded in the receipt, in whole CU (default 48).
 * @returns A new `PrivateReceiptV3` with no price and no content digests.
 */
export function receiptV3(key: OperationKey, cu = 48n): PrivateReceiptV3 {
  return {
    schema: 'otk.receipt.v3',
    key,
    source: 'otk_proxy_observed',
    provider: 'openai',
    usage: usage(100n, 20n),
    cu: cuResult(cu),
    price: null,
    config: CONFIG,
    userRef: '7',
    timing: { admittedAt: '2026-10-01T12:00:00.000Z', upstreamStartedAt: '2026-10-01T12:00:00.100Z', usageFinalAt: '2026-10-01T12:00:01.000Z', latencyMs: 900n },
    publicCommitment: '123456789',
    contentDigests: null,
  };
}

/**
 * Builds a conference report whose output comparison is deliberately divergent (provider 0 vs local 100).
 *
 * @param key - Tenant and operation identifiers of the receipt.
 * @param receiptDigest - Digest of the receipt the report is bound to (not checked here).
 * @param state - Report state (default `compared`); the verdict is `divergent` for `compared` and
 *   `not_applicable` for any other state.
 * @returns A new `ConferenceReport`.
 */
export function conference(key: OperationKey, receiptDigest: string, state: ConferenceReport['state'] = 'compared'): ConferenceReport {
  const compared = state === 'compared';
  return {
    schema: 'otk.conference.v1',
    key,
    receiptDigest: receiptDigest as ConferenceReport['receiptDigest'],
    tokenizer: { package: 'js-tiktoken', packageVersion: '1.0.21', encoding: 'o200k_base', vocabularyDigest: null, messageAssembly: { id: 'test', version: '1' } },
    coveredCategories: ['input', 'output'],
    uncoveredCategories: [],
    comparisons: [
      { category: 'input', provider: 100n, local: 98n, absoluteDelta: 2n, relativeDelta: '0.020000' },
      { category: 'output', provider: 0n, local: 100n, absoluteDelta: -100n, relativeDelta: null },
    ],
    threshold: { absoluteTokens: 16n, relative: '0.10', calibrationVersion: null, calibrated: false },
    state,
    verdict: compared ? 'divergent' : 'not_applicable',
    counterVersion: 'counter-test',
    createdAt: '2026-10-01T12:00:02.000Z',
  };
}

/**
 * Builds a commitment opening for 48 CU under the shared circuit id.
 *
 * @param key - Tenant and operation identifiers of the opening.
 * @param blinding - Decimal blinding value (default a fixed test value; real openings use a CSPRNG).
 * @returns A new `CommitmentOpening`.
 */
export function opening(key: OperationKey, blinding = '987654321'): CommitmentOpening {
  return {
    schema: 'otk.opening.v1', key, circuitId: CONFIG.circuitId, usage: CU(48n), blinding,
    privateInputs: { userRef: '7', salt: '5' }, createdAt: '2026-10-01T12:00:01.500Z',
  };
}
