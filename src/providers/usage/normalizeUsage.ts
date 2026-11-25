/**
 * Usage normalization per provider API (D4 §6, D5 §1–3, D5-G02/G03; front B).
 * Implements NormalizeUsageFn and the richer normalizeUsageDetailed().
 *
 * Every category keeps its raw field and its inclusion rule, so a total is never omitted or
 * counted twice. Absent stays null, a reported zero stays 0n, and invalid values (negative,
 * fractional, NaN/Infinity, wrong type, out of range) never become token counts: they are
 * reported as issues and make tIn/tOut null when they affect the base totals.
 *
 * T rule 'otk.t_rule.v1' (D5, multiplicative formula preserved):
 *   T_entrada = base input + every 'separate_addend' on the input side
 *   T_saida   = base output + every 'separate_addend' on the output side
 *   'subset_of_*' categories are already inside the base and are never added again.
 * Input side = categories named input* and tool_use_prompt; output side = output*.
 * Consequence vs. the previous code: Anthropic cache read/write tokens now enter T_entrada
 * (the proxy previously left them out of CU, N8) and Gemini thoughts now enter T_saida.
 * Cache discounts belong to the price (priceUsage.ts), not to CU (D5 §6).
 *
 * Where it sits: exported through `src/providers/d1d8Measurement.ts`; the stream accumulator in this
 * folder calls `normalizeUsageDetailed` on the usage it rebuilds from the stream. Pure functions: no I/O,
 * no configuration, input objects are never mutated.
 *
 * @module src/providers/usage/normalizeUsage
 */
import type {
  CategoryInclusion, NormalizedUsage, TokenCategory, TokenCategoryName, UsageApi, UsageCompleteness,
} from '../../types/d1d8/index.js';
import type { UsageContext } from '../../types/d1d8/index.js';
import { digestOf } from './canonicalJson.js';
import { USAGE_DOC_REFS } from './usageDocRefs.js';

/**
 * Version label of this normalizer, copied into every {@link NormalizedUsage} it produces.
 */
export const NORMALIZER_VERSION = 'otk.usage_normalizer.b1@1';
/**
 * Identifier of the rule that sums categories into `tIn`/`tOut` (described in the file header).
 */
export const T_RULE_ID = 'otk.t_rule.v1';

/** Above this a single operation's count is treated as out of range (≈500× the largest documented context). */
export const MAX_TOKENS_PER_FIELD = 1_000_000_000n;

/**
 * Kind of problem found while normalizing a usage object.
 *
 * `usage_absent`/`base_absent`: the usage object or a base count is missing; `invalid_type`,
 * `non_integer`, `negative`, `non_finite`, `out_of_range`: a field is not a valid count;
 * `subset_exceeds_base`/`inconsistent_total`: counts contradict each other; `derived_from_total`: the
 * output base was computed from the total; `inclusion_unverified`: a field whose inclusion is not
 * documented is non-zero; `unmapped_field`: the response has a field this normalizer does not know.
 */
export type UsageIssueKind =
  | 'usage_absent'
  | 'base_absent'
  | 'invalid_type'
  | 'non_integer'
  | 'negative'
  | 'non_finite'
  | 'out_of_range'
  | 'subset_exceeds_base'
  | 'inconsistent_total'
  | 'derived_from_total'
  | 'inclusion_unverified'
  | 'unmapped_field';

/**
 * One problem found while normalizing; it never carries prompt or response text.
 */
export interface UsageIssue {
  kind: UsageIssueKind;
  /** Dotted path of the field in the response body, e.g. `usage.prompt_tokens`. */
  field: string;
  /** Raw value rendered as text (numbers only; never prompt/response text). */
  detail?: string;
}

/**
 * Result of {@link normalizeUsageDetailed}: the normalized usage plus every issue found.
 */
export interface DetailedUsage {
  usage: NormalizedUsage;
  issues: UsageIssue[];
}

interface FieldSpec {
  name: TokenCategoryName;
  path: string;
  inclusion: CategoryInclusion;
}

interface ApiRule {
  /** Where the usage object lives in the response body. */
  usagePath: string;
  fields: FieldSpec[];
  /** Optional total field that must equal tIn + tOut under otk.t_rule.v1. */
  totalPath?: string;
  /** Fields documented and deliberately not mapped to a category (still in rawUsageDigest). */
  knownUnmapped: string[];
  /** Additional consistency: these fields must sum to the given base field. */
  partitions?: Array<{ parts: string[]; whole: string }>;
  modelPath: string;
  idPath: string;
  /** Gemini omits zero-valued fields (proto3 JSON); base output may be derived from total. */
  deriveOutputFromTotal?: boolean;
  /** Fields whose inclusion is not documented: a non-zero value makes the usage partial. */
  unverifiedInclusion?: string[];
  /** v1.3: where the response reports the service tier that processed (and prices) it. */
  serviceTierPath?: string;
  /** v1.3: where the response reports how generation ended (Gemini: candidates[0] and promptFeedback). */
  finish?: { candidatesPath: string; reasonField: string; blockPath: string };
}

const OPENAI_CHAT_LIKE = (extra: Partial<ApiRule> = {}): ApiRule => ({
  usagePath: 'usage',
  fields: [
    { name: 'input', path: 'prompt_tokens', inclusion: 'base' },
    { name: 'output', path: 'completion_tokens', inclusion: 'base' },
    { name: 'input_cache_read', path: 'prompt_tokens_details.cached_tokens', inclusion: 'subset_of_input' },
    { name: 'input_cache_write', path: 'prompt_tokens_details.cache_write_tokens', inclusion: 'subset_of_input' },
    { name: 'input_audio', path: 'prompt_tokens_details.audio_tokens', inclusion: 'subset_of_input' },
    { name: 'output_reasoning', path: 'completion_tokens_details.reasoning_tokens', inclusion: 'subset_of_output' },
    { name: 'output_audio', path: 'completion_tokens_details.audio_tokens', inclusion: 'subset_of_output' },
  ],
  totalPath: 'total_tokens',
  knownUnmapped: [
    'prompt_tokens_details.text_tokens',
    'prompt_tokens_details.image_tokens',
    'completion_tokens_details.text_tokens',
    'completion_tokens_details.accepted_prediction_tokens',
    'completion_tokens_details.rejected_prediction_tokens',
  ],
  modelPath: 'model',
  idPath: 'id',
  ...extra,
});

/**
 * Per-API mapping from response fields to token categories, with the consistency checks to apply.
 */
export const API_RULES: Readonly<Record<UsageApi, ApiRule>> = Object.freeze({
  // v1.3: service_tier at the top level of the body and of every stream chunk (FECHAMENTO_GEMINI_AD, DL-07)
  'openai.chat_completions': OPENAI_CHAT_LIKE({ serviceTierPath: 'service_tier' }),
  'openai.responses': {
    usagePath: 'usage',
    fields: [
      { name: 'input', path: 'input_tokens', inclusion: 'base' },
      { name: 'output', path: 'output_tokens', inclusion: 'base' },
      { name: 'input_cache_read', path: 'input_tokens_details.cached_tokens', inclusion: 'subset_of_input' },
      { name: 'input_cache_write', path: 'input_tokens_details.cache_write_tokens', inclusion: 'subset_of_input' },
      { name: 'output_reasoning', path: 'output_tokens_details.reasoning_tokens', inclusion: 'subset_of_output' },
    ],
    totalPath: 'total_tokens',
    knownUnmapped: [],
    modelPath: 'model',
    idPath: 'id',
  },
  'anthropic.messages': {
    usagePath: 'usage',
    fields: [
      { name: 'input', path: 'input_tokens', inclusion: 'base' },
      { name: 'output', path: 'output_tokens', inclusion: 'base' },
      { name: 'input_cache_write', path: 'cache_creation_input_tokens', inclusion: 'separate_addend' },
      { name: 'input_cache_read', path: 'cache_read_input_tokens', inclusion: 'separate_addend' },
      { name: 'output_reasoning', path: 'output_tokens_details.thinking_tokens', inclusion: 'subset_of_output' },
    ],
    // cache_creation (5m/1h breakdown) is NOT normalized: every cache write lands in input_cache_write.
    // The prompt-caching doc states that cache_creation_input_tokens equals the sum of the breakdown
    // (consulted 2026-10-02, RV2-07); OTK refuses ttl other than 5m before the upstream instead of
    // pricing the 1-hour share (proxyDurable).
    knownUnmapped: ['cache_creation', 'server_tool_use', 'service_tier', 'inference_geo'],
    modelPath: 'model',
    idPath: 'id',
  },
  'gemini.generate_content': {
    usagePath: 'usageMetadata',
    fields: [
      { name: 'input', path: 'promptTokenCount', inclusion: 'base' },
      { name: 'output', path: 'candidatesTokenCount', inclusion: 'base' },
      { name: 'input_cache_read', path: 'cachedContentTokenCount', inclusion: 'subset_of_input' },
      { name: 'tool_use_prompt', path: 'toolUsePromptTokenCount', inclusion: 'separate_addend' },
      { name: 'output_reasoning', path: 'thoughtsTokenCount', inclusion: 'separate_addend' },
    ],
    totalPath: 'totalTokenCount',
    knownUnmapped: [
      'promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails', 'trafficType', 'serviceTier',
    ],
    // Documented total = prompt + thoughts + candidates; whether tool-use prompt tokens are
    // inside promptTokenCount or the total is not stated, so a non-zero value is not billable.
    unverifiedInclusion: ['toolUsePromptTokenCount'],
    modelPath: 'modelVersion',
    idPath: 'responseId',
    deriveOutputFromTotal: true,
    serviceTierPath: 'usageMetadata.serviceTier',
    finish: { candidatesPath: 'candidates', reasonField: 'finishReason', blockPath: 'promptFeedback.blockReason' },
  },
  'deepseek.chat_completions': OPENAI_CHAT_LIKE({
    fields: [
      { name: 'input', path: 'prompt_tokens', inclusion: 'base' },
      { name: 'output', path: 'completion_tokens', inclusion: 'base' },
      { name: 'input_cache_read', path: 'prompt_cache_hit_tokens', inclusion: 'subset_of_input' },
      { name: 'output_reasoning', path: 'completion_tokens_details.reasoning_tokens', inclusion: 'subset_of_output' },
    ],
    knownUnmapped: ['prompt_cache_miss_tokens', 'prompt_tokens_details.cached_tokens'],
    partitions: [{ parts: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'], whole: 'prompt_tokens' }],
  }),
  'mistral.chat_completions': OPENAI_CHAT_LIKE({
    fields: [
      { name: 'input', path: 'prompt_tokens', inclusion: 'base' },
      { name: 'output', path: 'completion_tokens', inclusion: 'base' },
    ],
    // num_cached_tokens / prompt_tokens_details have no documented semantics (spec without descriptions).
    knownUnmapped: ['num_cached_tokens', 'prompt_tokens_details', 'prompt_token_details', 'prompt_audio_seconds'],
  }),
  'cohere.chat': {
    usagePath: 'usage',
    fields: [
      { name: 'input', path: 'tokens.input_tokens', inclusion: 'base' },
      { name: 'output', path: 'tokens.output_tokens', inclusion: 'base' },
    ],
    knownUnmapped: ['billed_units.input_tokens', 'billed_units.output_tokens', 'billed_units.search_units', 'billed_units.classifications', 'cached_tokens'],
    modelPath: 'model',
    idPath: 'id',
  },
});

const INPUT_SIDE: ReadonlySet<TokenCategoryName> = new Set(['input', 'input_cache_read', 'input_cache_write', 'input_audio', 'tool_use_prompt']);

/**
 * Tells on which side (input or output) a token category is added under the T rule.
 *
 * @param name - Token category name.
 * @returns `'input'` for `input*` and `tool_use_prompt` categories, otherwise `'output'`.
 */
export function categorySide(name: TokenCategoryName): 'input' | 'output' {
  return INPUT_SIDE.has(name) ? 'input' : 'output';
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

type Parsed = { kind: 'absent' } | { kind: 'ok'; value: bigint } | { kind: 'invalid'; issue: UsageIssueKind; detail: string };

/**
 * Strict count parser: only finite non-negative integers up to MAX_TOKENS_PER_FIELD are counts.
 *
 * @param v - Raw field value (number or bigint expected).
 * @returns `absent` for `undefined`/`null`, `ok` with a bigint value, or `invalid` with the issue kind and
 *   the value rendered as text.
 */
export function parseCount(v: unknown): Parsed {
  if (v === undefined || v === null) return { kind: 'absent' };
  if (typeof v === 'bigint') {
    if (v < 0n) return { kind: 'invalid', issue: 'negative', detail: v.toString() };
    if (v > MAX_TOKENS_PER_FIELD) return { kind: 'invalid', issue: 'out_of_range', detail: v.toString() };
    return { kind: 'ok', value: v };
  }
  if (typeof v !== 'number') return { kind: 'invalid', issue: 'invalid_type', detail: typeof v };
  if (!Number.isFinite(v)) return { kind: 'invalid', issue: 'non_finite', detail: String(v) };
  if (!Number.isInteger(v)) return { kind: 'invalid', issue: 'non_integer', detail: String(v) };
  if (v < 0) return { kind: 'invalid', issue: 'negative', detail: String(v) };
  if (!Number.isSafeInteger(v) || BigInt(v) > MAX_TOKENS_PER_FIELD) return { kind: 'invalid', issue: 'out_of_range', detail: String(v) };
  return { kind: 'ok', value: BigInt(v) };
}

/**
 * Leaf paths of numeric-looking fields in the raw usage object, for the unmapped report.
 *
 * @param obj - Raw usage object (or a nested value while recursing).
 * @param prefix - Dotted path of `obj` inside the usage object; empty at the top level.
 */
function leafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return prefix ? [prefix] : [];
  if (Array.isArray(obj)) return prefix ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * First candidate's finish reason; `blocked:<reason>` when the prompt was blocked (no candidate); null if neither.
 *
 * @param body - Full response body.
 * @param f - Where the API reports candidates, their finish reason and the prompt block reason.
 */
function finishOf(body: unknown, f: NonNullable<ApiRule['finish']>): string | null {
  const cands = getPath(body, f.candidatesPath);
  const first = Array.isArray(cands) && cands.length > 0 ? (cands[0] as unknown) : undefined;
  const reason = first && typeof first === 'object' ? str((first as Record<string, unknown>)[f.reasonField]) : null;
  if (reason) return reason;
  const blocked = str(getPath(body, f.blockPath));
  return blocked ? `blocked:${blocked}` : null;
}

/**
 * Options for {@link normalizeUsageDetailed}.
 */
export interface NormalizeOptions {
  /** Stream accumulators override completeness (e.g. 'partial' before the final event). */
  completeness?: UsageCompleteness;
}

/**
 * Normalization with the list of issues found (the contract function drops the issues).
 *
 * Missing data stays `null` (a reported zero stays `0n`). `tIn`/`tOut` are `null` unless both bases are
 * valid and every consistency check passes; `completeness` is then `complete` (or `opts.completeness`),
 * otherwise `partial`, or `missing` when there is no usage object at all.
 *
 * @param api - Usage API that produced the body; it selects the rule in {@link API_RULES}.
 * @param responseBody - Parsed response body (not modified).
 * @param ctx - Provider, requested model, origin and observation time to copy into the result.
 * @param opts - Optional override of the completeness reported for a computable usage.
 * @returns The normalized usage and the list of issues found (possibly empty).
 * @throws {Error} When `api` has no rule in {@link API_RULES}.
 */
export function normalizeUsageDetailed(api: UsageApi, responseBody: unknown, ctx: UsageContext,
  opts: NormalizeOptions = {}): DetailedUsage {
  const rule = API_RULES[api];
  if (!rule) throw new Error(`normalizeUsage: api not in the declared scope: ${String(api)}`);
  const docRef = USAGE_DOC_REFS[api];
  const rawUsage = getPath(responseBody, rule.usagePath);
  const issues: UsageIssue[] = [];
  const base = {
    schema: 'otk.usage.v1' as const,
    api,
    provider: ctx.provider,
    modelRequested: ctx.modelRequested,
    modelReturned: str(getPath(responseBody, rule.modelPath)),
    providerRequestId: str(getPath(responseBody, rule.idPath)),
    origin: ctx.origin,
    tRule: T_RULE_ID,
    rawUsageDigest: digestOf(rawUsage ?? null),
    normalizerVersion: NORMALIZER_VERSION,
    docRef: { url: docRef.url, retrievedAt: docRef.retrievedAt },
    observedAt: ctx.observedAt,
    ...(rule.serviceTierPath ? { serviceTier: str(getPath(responseBody, rule.serviceTierPath)) } : {}),
    ...(rule.finish ? { finishReason: finishOf(responseBody, rule.finish) } : {}),
  };

  if (rawUsage === undefined || rawUsage === null || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
    issues.push({ kind: 'usage_absent', field: rule.usagePath });
    const categories: TokenCategory[] = rule.fields.map((f) => ({
      name: f.name, count: null, inclusion: f.inclusion, sourceField: `${rule.usagePath}.${f.path}`,
    }));
    return { usage: { ...base, completeness: 'missing', categories, tIn: null, tOut: null }, issues };
  }

  let invalidBlocking = false;
  let invalidSubset = false;
  const categories: TokenCategory[] = [];
  for (const f of rule.fields) {
    const p = parseCount(getPath(rawUsage, f.path));
    const sourceField = `${rule.usagePath}.${f.path}`;
    if (p.kind === 'invalid') {
      issues.push({ kind: p.issue, field: sourceField, detail: p.detail });
      // An invalid subset would be priced inside its base (e.g. cached input at the full rate):
      // the usage is not billable as final either.
      if (f.inclusion === 'base' || f.inclusion === 'separate_addend') invalidBlocking = true;
      else invalidSubset = true;
    }
    categories.push({ name: f.name, count: p.kind === 'ok' ? p.value : null, inclusion: f.inclusion, sourceField });
  }

  const find = (name: TokenCategoryName, inclusion: CategoryInclusion) =>
    categories.find((c) => c.name === name && c.inclusion === inclusion);
  const inputBase = find('input', 'base')!;
  const outputBase = find('output', 'base')!;

  const totalParsed = rule.totalPath ? parseCount(getPath(rawUsage, rule.totalPath)) : ({ kind: 'absent' } as Parsed);
  if (totalParsed.kind === 'invalid') {
    issues.push({ kind: totalParsed.issue, field: `${rule.usagePath}.${rule.totalPath}`, detail: totalParsed.detail });
    invalidBlocking = true;
  }

  // Gemini omits zero-valued fields; the output base can be recovered from the documented total.
  if (rule.deriveOutputFromTotal && outputBase.count === null && totalParsed.kind === 'ok' && inputBase.count !== null
    && !issues.some((i) => i.field === outputBase.sourceField)) {
    const others = categories
      .filter((c) => c !== outputBase && (c.inclusion === 'base' || c.inclusion === 'separate_addend'))
      .reduce((s, c) => s + (c.count ?? 0n), 0n);
    const remainder = totalParsed.value - others;
    if (remainder >= 0n) {
      outputBase.count = remainder;
      outputBase.sourceField = `${rule.usagePath}.${rule.totalPath} - (other base and separate categories)`;
      issues.push({ kind: 'derived_from_total', field: `${rule.usagePath}.${rule.fields[1]!.path}`, detail: remainder.toString() });
    }
  }

  if (inputBase.count === null && !issues.some((i) => i.field === inputBase.sourceField)) issues.push({ kind: 'base_absent', field: inputBase.sourceField });
  if (outputBase.count === null && !issues.some((i) => i.field === outputBase.sourceField)) issues.push({ kind: 'base_absent', field: outputBase.sourceField });

  let consistent = !invalidSubset;
  // A subset can never exceed the base that contains it.
  for (const c of categories) {
    if (c.count === null) continue;
    const container = c.inclusion === 'subset_of_input' ? inputBase : c.inclusion === 'subset_of_output' ? outputBase : null;
    if (container && container.count !== null && c.count > container.count) {
      issues.push({ kind: 'subset_exceeds_base', field: c.sourceField, detail: `${c.count}>${container.count}` });
      consistent = false;
    }
  }
  for (const part of rule.partitions ?? []) {
    const whole = parseCount(getPath(rawUsage, part.whole));
    const parts = part.parts.map((pp) => parseCount(getPath(rawUsage, pp)));
    if (whole.kind === 'ok' && parts.every((pp) => pp.kind === 'ok')) {
      const sum = parts.reduce((s, pp) => s + (pp as { value: bigint }).value, 0n);
      if (sum !== whole.value) {
        issues.push({ kind: 'inconsistent_total', field: `${rule.usagePath}.${part.whole}`, detail: `${part.parts.join('+')}=${sum}≠${whole.value}` });
        consistent = false;
      }
    }
  }

  for (const path of rule.unverifiedInclusion ?? []) {
    const v = parseCount(getPath(rawUsage, path));
    if (v.kind === 'ok' && v.value > 0n) {
      issues.push({ kind: 'inclusion_unverified', field: `${rule.usagePath}.${path}`, detail: v.value.toString() });
      consistent = false;
    }
  }

  let tIn: bigint | null = null;
  let tOut: bigint | null = null;
  if (inputBase.count !== null && outputBase.count !== null && !invalidBlocking) {
    tIn = inputBase.count;
    tOut = outputBase.count;
    for (const c of categories) {
      if (c.inclusion !== 'separate_addend' || c.count === null) continue;
      if (categorySide(c.name) === 'input') tIn += c.count;
      else tOut += c.count;
    }
    if (totalParsed.kind === 'ok' && totalParsed.value !== tIn + tOut) {
      issues.push({ kind: 'inconsistent_total', field: `${rule.usagePath}.${rule.totalPath}`, detail: `${totalParsed.value}≠${tIn + tOut}` });
      consistent = false;
    }
  }

  const mapped = new Set([...rule.fields.map((f) => f.path), ...rule.knownUnmapped, ...(rule.totalPath ? [rule.totalPath] : [])]);
  for (const leaf of leafPaths(rawUsage)) {
    if (!mapped.has(leaf) && ![...mapped].some((m) => leaf.startsWith(`${m}.`))) {
      issues.push({ kind: 'unmapped_field', field: `${rule.usagePath}.${leaf}` });
    }
  }

  const computable = tIn !== null && tOut !== null && consistent;
  let completeness: UsageCompleteness = computable ? 'complete' : 'partial';
  if (opts.completeness && completeness === 'complete') completeness = opts.completeness;
  return {
    usage: { ...base, completeness, categories, tIn: computable ? tIn : null, tOut: computable ? tOut : null },
    issues,
  };
}

/**
 * NormalizeUsageFn (contract). Carries `issues` (1.1.0) when normalizeUsageDetailed found any.
 *
 * @param api - Usage API that produced the body.
 * @param responseBody - Parsed response body (not modified).
 * @param ctx - Provider, requested model, origin and observation time.
 * @returns The normalized usage, with an `issues` member only when at least one issue was found.
 * @throws {Error} When `api` has no rule in {@link API_RULES}.
 */
export function normalizeUsage(api: UsageApi, responseBody: unknown, ctx: UsageContext): NormalizedUsage {
  const { usage, issues } = normalizeUsageDetailed(api, responseBody, ctx);
  // contract 1.1.0 (R-B2): issues travel with the usage; omitted (never undefined) when there are none
  return issues.length > 0 ? { ...usage, issues } : usage;
}

/**
 * Count of one category as reported, or null (absent/invalid).
 *
 * @param usage - A normalized usage.
 * @param name - Category to read (the first category with that name is used).
 * @returns The count in tokens, or `null` when the category is absent or invalid.
 */
export function categoryCount(usage: NormalizedUsage, name: TokenCategoryName): bigint | null {
  return usage.categories.find((c) => c.name === name)?.count ?? null;
}
