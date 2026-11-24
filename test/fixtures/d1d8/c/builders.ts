/**
 * D1–D8 / C — hand-built contract objects for C's tests (synthetic values, no real payloads).
 * Numbers are chosen so expected results can be checked by hand.
 */
import type {
  CommitmentOpening, ConferenceReport, CuResult, FrozenConfigRef, NormalizedUsage, OperationKey,
  PrivateReceiptV3, Reservation, Scaled,
} from '../../../../src/types/d1d8/index.js';
import type { AdmitRequest } from '../../../../src/types/d1d8/index.js';
import { MONEY_BOUND_POLICY } from '../../../../src/operations/moneyBound.js';

export const CU = (n: bigint | number): Scaled => ({ units: BigInt(n) * 1_000_000n, scale: 1_000_000n });

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

export function reservation(cu: bigint, money: bigint | null = null): Reservation {
  return { cu: CU(cu), money: money === null ? null : { units: money, scale: 1_000_000_000_000n, currency: 'USD' }, basis: 'known_cu', state: 'held' };
}

/**
 * A fixture money reservation stands for a strict one made under the default bound policy, which is
 * what a budget requires since RV2-01 (fechamento pós-S5); `policy: null` builds a non-strict one.
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

export function cuResult(cu: bigint): CuResult {
  return {
    schema: 'otk.cu_result.v1', status: 'computed', cu: CU(cu), formula: 'CU_MULT_v2_micro',
    weights: CONFIG.cuWeights, tIn: 100n, tOut: 20n, wModelMilli: 400n, wProviderMilli: 1000n, developmentProfile: true,
  };
}

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

export function opening(key: OperationKey, blinding = '987654321'): CommitmentOpening {
  return {
    schema: 'otk.opening.v1', key, circuitId: CONFIG.circuitId, usage: CU(48n), blinding,
    privateInputs: { userRef: '7', salt: '5' }, createdAt: '2026-10-01T12:00:01.500Z',
  };
}
