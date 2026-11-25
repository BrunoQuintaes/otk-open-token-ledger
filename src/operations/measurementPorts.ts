/**
 * D1–D8 / C — measurement ports consumed by the durable proxy (contracts of B in
 * src/types/d1d8/modules.ts) and the LEGACY adapters this branch ships as their default.
 *
 * The legacy adapters wrap code that already exists in the COMMON (UsageExtractor, StreamTapper,
 * calculateCostUnitsV1); they are real implementations with declared limits, labelled
 * `legacy-*`, so the documented entrypoint works before integration. S4 replaces them with B's
 * modules (src/providers/d1d8Measurement.ts): normalizeUsage, createStreamUsageAccumulator,
 * computeCu, bindPricing().estimateReservation/priceUsage, createLocalCounter,
 * buildConferenceReport, createCuWeightsRuntime().active(). Known limits of the legacy adapters:
 *   - categories: input/output (+ Anthropic cache read/write as separate addends, outside
 *     T_entrada as in the legacy CU); no reasoning/thoughts breakdown; Responses API unsupported;
 *   - weights: static unsigned tables → FrozenConfigRef.developmentProfile = true (D4 §1);
 *   - reservation: input upper bound = request body bytes + 64 (BPE tokens cover ≥ 1 byte);
 *   - no price table (money null) and no local counter (no conference report).
 *
 * The durable profile started by `src/api/server.ts` uses the real ports from `d1d8Ports.ts`; the legacy
 * adapters here remain for tests and embedded contexts. Pure computation: no I/O, no environment variables.
 *
 * @module src/operations/measurementPorts
 */
import type {
  BuildConferenceReportFn, ConferenceThreshold, CreateLocalCounterFn, CreateStreamUsageAccumulatorFn,
  CuConfig, CuResult, EstimateReservationFn, FrozenConfigRef, Hex32, ModelSupport, NormalizeUsageFn, NormalizedUsage,
  PriceUsageFn, ResolveModelSupportFn, StreamUsageAccumulator, TokenCategory, UsageApi, UsageContext, VersionRef,
} from '../types/d1d8/index.js';
import type { CalibrationSelection } from '../tokenization/calibrationProfile.js';
import { extractUsage } from '../proxy/UsageExtractor.js';
import { StreamTapper } from '../proxy/StreamTapper.js';
import { MODEL_WEIGHTS_INT, PROVIDER_WEIGHTS_INT, calculateCostUnitsV1, weightModelKey } from '../pricing/CostUnits.js';
import { canonicalJson, sha256Hex } from './ids.js';

/** Everything the durable proxy needs to measure usage, compute CU, reserve and price an operation. */
export interface MeasurementPorts {
  /** Frozen weights/formula for a new admission; null → admission refused (D4 §7). */
  activeCuConfig(): CuConfig | null;
  /** Configuration frozen into the operation (A/S4 fill chain/circuit when they are wired). */
  frozenConfig(cfg: CuConfig): FrozenConfigRef;
  /** Normalizes a non-stream response body into usage categories. */
  normalizeUsage: NormalizeUsageFn;
  /** Creates the stream parser that accumulates usage from streamed chunks. */
  createStreamUsageAccumulator: CreateStreamUsageAccumulatorFn;
  /**
   * Computes the CU of a normalized usage with the given configuration.
   *
   * @param usage - Normalized usage.
   * @param cfg - Weights and formula.
   * @returns The CU result; `cu` is `null` when not computable.
   */
  computeCu(usage: NormalizedUsage, cfg: CuConfig): CuResult;
  /** Worst-case CU (and money, when priced) reserved at admission. May throw RangeError when no bound exists. */
  estimateReservation: EstimateReservationFn;
  /** Whether this implementation can measure the API (and its stream form); otherwise refused. */
  supportsApi(api: UsageApi, stream: boolean): boolean;
  /** Whether inputs passed by reference (files, cached content, previous responses) can be bounded. */
  inputBoundable(api: UsageApi, body: unknown): boolean;
  /** Upper bound of input tokens for the reservation (B: inputTokensUpperBound). */
  estimateInputTokens(api: UsageApi, body: unknown, bodyBytes: number): bigint;
  /** Prices a usage with a frozen price table; `null` = no pricing (money stays null, never zero). */
  priceUsage: PriceUsageFn | null;
  /** Local tokenizer support of (provider, api, model); `null` = no local counter. */
  resolveModelSupport: ResolveModelSupportFn | null;
  /** Creates the in-memory auxiliary token counter; `null` = not available. */
  createLocalCounter: CreateLocalCounterFn | null;
  /**
   * OVERNIGHT 20261005 / Phase 1: load every local tokenizer this measurement can use, once, before the server
   * is ready. The first load of an encoding is synchronous (rank file parse: 0.9–2.5 s measured on the candidate
   * host) and used to happen inside the first request, blocking the event loop of the whole process: no lease of
   * any live operation could be renewed during it, so another instance could recover a live call. Optional:
   * measurements without a local counter have nothing to load. Returns what was loaded and how long it took.
   */
  warmUp?: () => Array<{ encoding: string; ms: number }>;
  /** Builds the provider-vs-local conference report; `null` = no report. */
  buildConferenceReport: BuildConferenceReportFn | null;
  /** Threshold used when no calibration selector exists (the heuristic HEURISTIC_THRESHOLD_V0 in B's ports). */
  conferenceThreshold: ConferenceThreshold | null;
  /**
   * OVERNIGHT 20261005 / Phase 8 (optional): selects the calibration profile of (provider, api, model) at
   * conference time, from profiles loaded at startup. Its threshold replaces conferenceThreshold; anything but
   * COMPATIBLE keeps the heuristic threshold and is recorded in the report as an explicit not-calibrated outcome.
   */
  selectCalibration?: (support: ModelSupport, counterVersion: string) => CalibrationSelection;
  /**
   * Text hooks for the in-memory counter (B extensions outside the frozen contract signatures:
   * createStreamUsageAccumulator's 4th argument and extractOutputText). Text never leaves memory.
   */
  streamTextHooks: ((acc: { onTextDelta(t: string): void; onNonTextOutput(reason: string): void }) => {
    create: CreateStreamUsageAccumulatorFn;
  }) | null;
  /** Extracts output text from a non-stream body for the in-memory counter; `null` = not available. */
  extractOutputText: ((api: UsageApi, body: unknown) => { texts: string[]; nonText: boolean }) | null;
  /** CU configuration of an admitted operation by its frozen reference (B: runtime.byRef). */
  cuConfigByRef(ref: VersionRef): CuConfig | null;
  /** Label stored with the operation evidence (which implementation measured it). */
  readonly label: string;
}

// ───────────────────────────── legacy adapters ─────────────────────────────

const LEGACY_WEIGHTS_REF: VersionRef = {
  version: 'static',
  digest: sha256Hex(canonicalJson({ provider: PROVIDER_WEIGHTS_INT, model: MODEL_WEIGHTS_INT })),
};
const LEGACY_DOC = { url: 'otk:legacy/src/proxy/UsageExtractor.ts', retrievedAt: '2026-09-30T00:00:00.000Z' };
const LEGACY_NORMALIZER = 'legacy-extractUsage@9a42ff2';
const LEGACY_T_RULE = 'legacy.input_plus_output@1';

// Cache read/write are separate addends so they never inflate the legacy T_in (same as the legacy CU).
function legacyCategories(api: UsageApi, input: number | null, output: number | null, cacheWrite?: number, cacheRead?: number): TokenCategory[] {
  const base = api.startsWith('anthropic') ? 'usage' : api.startsWith('gemini') ? 'usageMetadata' : 'usage';
  const cats: TokenCategory[] = [
    { name: 'input', count: input === null ? null : BigInt(input), inclusion: 'base', sourceField: `${base}.input` },
    { name: 'output', count: output === null ? null : BigInt(output), inclusion: 'base', sourceField: `${base}.output` },
  ];
  if (cacheWrite !== undefined) cats.push({ name: 'input_cache_write', count: BigInt(cacheWrite), inclusion: 'separate_addend', sourceField: 'usage.cache_creation_input_tokens' });
  if (cacheRead !== undefined) cats.push({ name: 'input_cache_read', count: BigInt(cacheRead), inclusion: 'separate_addend', sourceField: 'usage.cache_read_input_tokens' });
  return cats;
}

function usageObject(api: UsageApi, ctx: UsageContext, parts: {
  completeness: NormalizedUsage['completeness']; input: number | null; output: number | null; modelReturned: string | null;
  providerRequestId: string | null; raw: unknown; cacheWrite?: number; cacheRead?: number;
}): NormalizedUsage {
  const computable = parts.completeness === 'complete' && parts.input !== null && parts.output !== null;
  return {
    schema: 'otk.usage.v1',
    api,
    provider: ctx.provider,
    modelRequested: ctx.modelRequested,
    modelReturned: parts.modelReturned,
    providerRequestId: parts.providerRequestId,
    origin: ctx.origin,
    completeness: parts.completeness,
    categories: legacyCategories(api, parts.input, parts.output, parts.cacheWrite, parts.cacheRead),
    tIn: computable ? BigInt(parts.input!) : null,
    tOut: computable ? BigInt(parts.output!) : null,
    tRule: LEGACY_T_RULE,
    rawUsageDigest: sha256Hex(canonicalJson(parts.raw ?? null)),
    normalizerVersion: LEGACY_NORMALIZER,
    docRef: LEGACY_DOC,
    observedAt: ctx.observedAt,
  };
}

function usageField(api: UsageApi, body: Record<string, unknown>): unknown {
  if (api === 'gemini.generate_content') return body['usageMetadata'];
  if (api === 'cohere.chat') return body['meta'];
  return body['usage'];
}

/**
 * Legacy usage normalizer over `extractUsage`.
 *
 * The Responses API and bodies without a usage field yield `completeness: 'missing'` with null counts.
 *
 * @param api - Provider API of the response.
 * @param responseBody - Parsed response body; non-objects are treated as empty.
 * @param ctx - Provider, requested model, origin and observation time.
 * @returns The normalized usage.
 */
export const legacyNormalizeUsage: NormalizeUsageFn = (api, responseBody, ctx) => {
  const body = (responseBody && typeof responseBody === 'object' ? responseBody : {}) as Record<string, unknown>;
  const raw = usageField(api, body);
  if (api === 'openai.responses' || raw == null) {
    // Responses API: the legacy extractor reads prompt/completion fields that Responses does not
    // have (U2-04) → declared unsupported here instead of 0/0
    return usageObject(api, ctx, { completeness: 'missing', input: null, output: null, modelReturned: typeof body['model'] === 'string' ? body['model'] : null, providerRequestId: typeof body['id'] === 'string' ? body['id'] : null, raw: raw ?? null });
  }
  const u = extractUsage(ctx.provider, ctx.modelRequested, body);
  return usageObject(api, ctx, {
    completeness: 'complete', input: u.inputTokens, output: u.outputTokens,
    modelReturned: typeof body['model'] === 'string' ? body['model'] : null, providerRequestId: u.requestId ?? null, raw,
    ...(u.cacheCreationInputTokens !== undefined ? { cacheWrite: u.cacheCreationInputTokens } : {}),
    ...(u.cacheReadInputTokens !== undefined ? { cacheRead: u.cacheReadInputTokens } : {}),
  });
};

/**
 * Stream accumulator over the legacy StreamTapper. Final usage is declared only when the
 * provider's end marker was seen (OpenAI `[DONE]` after a usage chunk, Anthropic `message_stop`
 * after `message_delta`, Gemini a chunk with `finishReason`); a cut stream with intermediate
 * usage is 'partial', without usage 'missing' (D7 §3).
 *
 * @param api - Provider API of the stream.
 * @param ctx - Usage context.
 * @param limits - Parser bounds; a line longer than `maxBufferedBytes` is dropped.
 * @returns An accumulator: `push` chunks, then `finish()` once for the usage.
 */
export const legacyCreateStreamUsageAccumulator: CreateStreamUsageAccumulatorFn = (api, ctx, limits) => {
  const tapper = new StreamTapper();
  let bytes = 0;
  let line = '';
  let ended = false;
  let finalDelta = false;
  const watch = (text: string) => {
    line += text;
    const parts = line.split('\n');
    line = parts.pop() ?? '';
    if (line.length > limits.maxBufferedBytes) line = '';
    for (const p of parts) {
      const t = p.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') { ended = true; continue; }
      if (payload.includes('"message_delta"')) finalDelta = true;
      if (payload.includes('"message_stop"')) ended = true;
      if (payload.includes('"finishReason"')) ended = true;
    }
  };
  const decoder = new TextDecoder();
  const acc: StreamUsageAccumulator = {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      tapper.observe(text);
      watch(text);
    },
    finish() {
      tapper.finish();
      watch('\n');
      const isFinal = tapper.usageSeen && ended && (!api.startsWith('anthropic') || finalDelta);
      const u = tapper.usage;
      return usageObject(api, ctx, {
        completeness: isFinal ? 'complete' : tapper.usageSeen ? 'partial' : 'missing',
        input: u ? u.promptTokens : null,
        output: u ? u.completionTokens : null,
        modelReturned: tapper.model ?? null,
        providerRequestId: tapper.messageId ?? null,
        raw: u ?? null,
        ...(u?.cacheCreationInputTokens !== undefined ? { cacheWrite: u.cacheCreationInputTokens } : {}),
        ...(u?.cacheReadInputTokens !== undefined ? { cacheRead: u.cacheReadInputTokens } : {}),
      });
    },
    get bytesSeen() { return bytes; },
  };
  return acc;
};

/**
 * Legacy CU: CU_MODEL_v1 integer (round half up) of tIn + tOut with the static weights.
 *
 * @param usage - Normalized usage.
 * @param cfg - Configuration stamped on the result (the weights used are the static tables).
 * @returns `computed` with whole CU (scale 1), or `usage_not_computable` / `unsupported_model` with `cu: null`.
 */
export function legacyComputeCu(usage: NormalizedUsage, cfg: CuConfig): CuResult {
  const fail = (status: CuResult['status']): CuResult => ({ schema: 'otk.cu_result.v1', status, cu: null, formula: cfg.formula, weights: cfg.ref, tIn: usage.tIn, tOut: usage.tOut, wModelMilli: null, wProviderMilli: null, developmentProfile: cfg.developmentProfile });
  if (usage.tIn === null || usage.tOut === null) return fail('usage_not_computable');
  // the returned model (e.g. OpenAI's dated 'gpt-4o-2024-08-06') when it has a weight, otherwise
  // the requested model whose weight admitted the call (review H2)
  const wp = PROVIDER_WEIGHTS_INT[usage.provider.toLowerCase()];
  const candidates = [usage.modelReturned, usage.modelRequested].filter((m): m is string => !!m).map((m) => weightModelKey(usage.provider, m));
  const model = candidates.find((m) => MODEL_WEIGHTS_INT[m.toLowerCase()] !== undefined) ?? candidates[0] ?? '';
  const wm = MODEL_WEIGHTS_INT[model.toLowerCase()];
  if (wp === undefined || wm === undefined) return fail('unsupported_model');
  if (usage.tIn > BigInt(Number.MAX_SAFE_INTEGER) || usage.tOut > BigInt(Number.MAX_SAFE_INTEGER)) return fail('usage_not_computable');
  const cu = calculateCostUnitsV1({ provider: usage.provider, model, inputTokens: Number(usage.tIn), outputTokens: Number(usage.tOut) });
  return { schema: 'otk.cu_result.v1', status: 'computed', cu: { units: cu, scale: 1n }, formula: cfg.formula, weights: cfg.ref, tIn: usage.tIn, tOut: usage.tOut, wModelMilli: wm, wProviderMilli: wp, developmentProfile: cfg.developmentProfile };
}

/**
 * Worst case for an unknown CU: CU(inputUpperBound + maxOutputTokens) with the frozen weights.
 *
 * @param req - Provider, requested model, estimated input tokens and maximum output tokens.
 * @param cfg - Configuration whose formula id is stamped in the basis.
 * @returns Whole CU rounded up (scale 1) and `money: null`.
 * @throws {RangeError} When the provider or model has no static weight.
 */
export const legacyEstimateReservation: EstimateReservationFn = (req, cfg) => {
  const model = weightModelKey(req.provider, req.modelRequested);
  const wp = PROVIDER_WEIGHTS_INT[req.provider.toLowerCase()];
  const wm = MODEL_WEIGHTS_INT[model.toLowerCase()];
  if (wp === undefined || wm === undefined) throw new RangeError(`no weight for ${req.provider}/${req.modelRequested}`);
  const tokens = req.estimatedInputTokens + req.maxOutputTokens;
  // ceil((tokens × wm × wp) / 10^6): never below the legacy rounded CU of the same tokens
  const num = tokens * wm * wp;
  const cu = (num + 999_999n) / 1_000_000n;
  return { cu: { units: cu, scale: 1n }, money: null, basis: `worst_case_input_bytes_plus_max_output@legacy:${cfg.formula}` };
};

/**
 * Builds the legacy measurement ports (static weights flagged as a development profile, no prices, no counter).
 *
 * @returns The ports, labelled `legacy-measurement@9a42ff2`.
 */
export function legacyMeasurementPorts(): MeasurementPorts {
  const cfg: CuConfig = {
    table: { schema: 'otk.cu_weights.v2', version: 'static', validFrom: '1970-01-01T00:00:00.000Z', validUntil: '9999-12-31T23:59:59.999Z', providerWeightsMilli: { ...PROVIDER_WEIGHTS_INT }, modelWeightsMilli: { ...MODEL_WEIGHTS_INT }, aliases: {}, signedBy: 'none', signature: 'none' },
    ref: LEGACY_WEIGHTS_REF,
    formula: 'CU_MODEL_v1',
    developmentProfile: true,
  };
  return {
    label: 'legacy-measurement@9a42ff2',
    activeCuConfig: () => cfg,
    frozenConfig: (c) => ({
      cuWeights: c.ref, cuFormula: c.formula, priceTable: null,
      modelCatalog: { version: 'legacy-static-weights', digest: LEGACY_WEIGHTS_REF.digest },
      bucketPolicy: { version: 'none', digest: sha256Hex('none') as Hex32 },
      circuitId: 'none', chain: null, developmentProfile: c.developmentProfile,
    }),
    normalizeUsage: legacyNormalizeUsage,
    createStreamUsageAccumulator: legacyCreateStreamUsageAccumulator,
    computeCu: legacyComputeCu,
    estimateReservation: legacyEstimateReservation,
    estimateInputTokens: (_api, _body, bodyBytes) => legacyInputUpperBound(bodyBytes),
    // Responses API: the legacy extractor cannot read its usage (U2-04); Cohere streams: no parser
    supportsApi: (api, stream) => api !== 'openai.responses' && !(api === 'cohere.chat' && stream),
    // body bytes bound the input only when everything is inline
    inputBoundable: () => false,
    priceUsage: null,
    resolveModelSupport: null,
    createLocalCounter: null,
    buildConferenceReport: null,
    conferenceThreshold: null,
    streamTextHooks: null,
    extractOutputText: null,
    cuConfigByRef: (ref) => (ref.version === cfg.ref.version && ref.digest === cfg.ref.digest ? cfg : null),
  };
}

/**
 * Request body bytes as the input upper bound of the legacy reservation.
 *
 * @param bodyBytes - Request body size, bytes.
 * @returns `bodyBytes + 64` tokens (a BPE token covers at least one byte; 64 is a margin).
 */
export const legacyInputUpperBound = (bodyBytes: number): bigint => BigInt(bodyBytes) + 64n;
