/**
 * Synthetic private receipt v3 / conference report for front A tests (no real tenant, user or
 * provider data). Values are small and hand-checkable: tIn 100 + tOut 20 = 120 tokens,
 * W_model 1.000 × W_provider 1.000 → 120 CU at scale 1 (CU_MODEL_v1 integer CU).
 */
import type { ConferenceReport, FrozenConfigRef, PrivateReceiptV3 } from '../../../../src/types/d1d8/index.js';
import { bucketPolicyRef, PUBLIC_BUCKET_POLICY_FIXED_1000CU } from '../../../../src/privacy/publicBucketPolicy.js';

export const ZERO32 = `0x${'00'.repeat(32)}` as const;
export const D1 = `0x${'11'.repeat(32)}` as const;

export function frozenConfig(circuitId: string): FrozenConfigRef {
  return {
    cuWeights: { version: 'cw-test-2026-09-30.1', digest: D1 },
    cuFormula: 'CU_MODEL_v1',
    priceTable: null,
    modelCatalog: { version: 'catalog-test.1', digest: D1 },
    bucketPolicy: bucketPolicyRef(PUBLIC_BUCKET_POLICY_FIXED_1000CU),
    circuitId,
    chain: null,
    developmentProfile: true,
  };
}

export function receiptFixture(opts: { circuitId: string; tenantId?: string; operationId?: string; cuUnits?: bigint; cuScale?: bigint; publicCommitment?: string | null; admittedAt?: string }): PrivateReceiptV3 {
  const cuUnits = opts.cuUnits ?? 120n;
  return {
    schema: 'otk.receipt.v3',
    key: { tenantId: opts.tenantId ?? 'tenant-test-a', operationId: opts.operationId ?? 'op-0001' },
    source: 'otk_proxy_observed',
    provider: 'openai',
    usage: {
      schema: 'otk.usage.v1',
      api: 'openai.chat_completions',
      provider: 'openai',
      modelRequested: 'gpt-4o-mini',
      modelReturned: 'gpt-4o-mini-2024-07-18',
      providerRequestId: 'req-test-1',
      origin: 'provider_response',
      completeness: 'complete',
      categories: [
        { name: 'input', count: 100n, inclusion: 'base', sourceField: 'usage.prompt_tokens' },
        { name: 'output', count: 20n, inclusion: 'base', sourceField: 'usage.completion_tokens' },
        { name: 'input_cache_read', count: null, inclusion: 'subset_of_input', sourceField: 'usage.prompt_tokens_details.cached_tokens' },
      ],
      tIn: 100n,
      tOut: 20n,
      tRule: 'tRule-test@1',
      rawUsageDigest: D1,
      normalizerVersion: 'normalizer-test@1',
      docRef: { url: 'https://example.invalid/doc', retrievedAt: '2026-09-30T00:00:00.000Z' },
      observedAt: '2026-09-30T19:00:01.000Z',
    },
    cu: {
      schema: 'otk.cu_result.v1', status: 'computed', cu: { units: cuUnits, scale: opts.cuScale ?? 1n }, formula: 'CU_MODEL_v1',
      weights: { version: 'cw-test-2026-09-30.1', digest: D1 }, tIn: 100n, tOut: 20n, wModelMilli: 1000n, wProviderMilli: 1000n, developmentProfile: true,
    },
    price: null,
    config: frozenConfig(opts.circuitId),
    userRef: '42',
    timing: { admittedAt: opts.admittedAt ?? '2026-09-30T19:00:00.000Z', upstreamStartedAt: '2026-09-30T19:00:00.100Z', usageFinalAt: '2026-09-30T19:00:01.000Z', latencyMs: 900n },
    publicCommitment: opts.publicCommitment ?? null,
    contentDigests: null,
  };
}

export function conferenceFixture(receiptDigest: `0x${string}`, key = { tenantId: 'tenant-test-a', operationId: 'op-0001' }): ConferenceReport {
  return {
    schema: 'otk.conference.v1',
    key,
    receiptDigest,
    tokenizer: { package: 'js-tiktoken', packageVersion: '1.0.21', encoding: 'o200k_base', vocabularyDigest: null, messageAssembly: { id: 'assembly-test', version: '1' } },
    coveredCategories: ['input', 'output'],
    uncoveredCategories: ['input_cache_read'],
    comparisons: [
      { category: 'input', provider: 100n, local: 98n, absoluteDelta: 2n, relativeDelta: '0.020000' },
      { category: 'output', provider: 20n, local: 20n, absoluteDelta: 0n, relativeDelta: '0.000000' },
    ],
    threshold: { absoluteTokens: 10n, relative: null, calibrationVersion: null, calibrated: false },
    state: 'compared',
    verdict: 'within_threshold',
    counterVersion: 'counter-test@1',
    createdAt: '2026-09-30T19:00:02.000Z',
  };
}
