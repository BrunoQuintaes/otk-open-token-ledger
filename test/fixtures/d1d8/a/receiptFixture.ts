/**
 * Synthetic private receipt v3 / conference report for front A tests (no real tenant, user or
 * provider data). Values are small and hand-checkable: tIn 100 + tOut 20 = 120 tokens,
 * W_model 1.000 × W_provider 1.000 → 120 CU at scale 1 (CU_MODEL_v1 integer CU).
 *
 * Shared by the v3 receipt, opening/authorization, circuit, CU-reference and verifier tests, and by the static
 * cross-check vectors in `v3Vectors.ts`. Every digest is a placeholder constant, so these objects are well formed
 * but do not reference any real weight table, catalog or provider document. Pure data builders: no I/O.
 *
 * @module test/fixtures/d1d8/a/receiptFixture
 */
import type { ConferenceReport, FrozenConfigRef, PrivateReceiptV3 } from '../../../../src/types/d1d8/index.js';
import { bucketPolicyRef, PUBLIC_BUCKET_POLICY_FIXED_1000CU } from '../../../../src/privacy/publicBucketPolicy.js';

/** All-zero 32-byte hex value (`0x` + 64 zeros), for tests that need an empty digest or address-like field. */
export const ZERO32 = `0x${'00'.repeat(32)}` as const;
/** Placeholder 32-byte digest (`0x11…11`) used wherever the fixture needs a digest that is valid in shape only. */
export const D1 = `0x${'11'.repeat(32)}` as const;

/**
 * Builds the frozen configuration reference of a test receipt: test weight and catalog versions, the
 * CU_MODEL_v1 formula, the fixed 1000-CU public bucket policy, no price table, no chain, development profile on.
 *
 * @param circuitId - Circuit identifier to record in the configuration (e.g. `metering_v3@sha256:…`).
 * @returns A new `FrozenConfigRef` object on each call.
 */
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

/**
 * Builds a synthetic private v3 receipt for one OpenAI chat-completions call (100 input + 20 output tokens,
 * cached-input count unknown), with weights 1.000 × 1.000.
 *
 * @param opts - Overrides. `circuitId` is required; `tenantId` defaults to `tenant-test-a`, `operationId` to
 *   `op-0001`, `cuUnits` to 120n and `cuScale` to 1n (CU = units / scale), `publicCommitment` to `null` (no
 *   commitment yet) and `admittedAt` to `2026-09-30T19:00:00.000Z` (ISO 8601).
 * @returns A new, mutable `PrivateReceiptV3`; callers may set fields such as `publicCommitment` afterwards.
 *   Changing `cuUnits` does not change the token counts, so the CU value is not recomputed from them.
 */
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

/**
 * Builds a synthetic conference report that compares the receipt's provider counts with a local tokenizer count:
 * input 100 vs 98 (delta 2) and output 20 vs 20, both within an uncalibrated 10-token absolute threshold.
 *
 * @param receiptDigest - Digest of the receipt this report refers to (normally `digestReceiptV3(receipt)`).
 * @param key - Tenant and operation of the receipt; defaults to the same key as {@link receiptFixture}.
 * @returns A new `ConferenceReport` with state `compared` and verdict `within_threshold`.
 */
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
