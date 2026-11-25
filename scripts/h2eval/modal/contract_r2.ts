/**
 * Contract rev. 2 (runs/B1/CONTRACT_MIN_FOR_EXECUTOR_R2.md, sha256 d52be4df...; additive to v0) - the items that belong to the
 * modal module: 3 serviceTierRequested/Served, 4 params.thinking, 5 cacheTtlRequested, 6 reasoningAllowanceTokens (pricing.ts),
 * 7 exploratoryFormulaEstimate (image only; NEVER replaces L0), 8 promptTokensDetailsByModality / cacheRoundingNote (parsers),
 * 10 modelDeprecation. Everything here is a pure function of model/plan/response; nothing reads env or does I/O.
 *
 * Used by `scripts/h2eval/index.ts` (deprecation and exploratory image estimate) and cited by the design support
 * matrix in `scripts/h2eval/design/designParams.ts`.
 *
 * @module scripts/h2eval/modal/contract_r2
 */
import type { MatrixModel, Modality } from './types.js';
import { OPENAI_TILE_TABLE, openAiResizedDims } from './estimators/image_openai_tiles.js';
import { ANTHROPIC_TIERS, anthropicTierOf } from './estimators/image_anthropic_patches.js';
export { REASONING_ALLOWANCE_TOKENS, capCovered } from './pricing/pricing.js';

/** Item 4: thinking configuration per model (R08 §8). "none" = no reasoning parameter sent; Gemini has no OFF. */
export type ThinkingParams =
  | { mode: 'none' }
  | { mode: 'adaptive'; effort: 'low' | 'medium' | 'high' }
  | { mode: 'manual'; budgetTokens: number }
  | { mode: 'minimal'; thinkingLevel: 'minimal' };
/**
 * Default thinking configuration of a model and whether turning reasoning off is documented.
 *
 * @param model - Matrix model.
 * @returns The configuration, its documented basis, and `offDocumented` (`true`, `false` or `'NOT_VERIFIED'`).
 */
export function defaultThinkingFor(model: MatrixModel): ThinkingParams & { basis: string; offDocumented: boolean | 'NOT_VERIFIED' } {
  switch (model) {
    case 'gpt-4o-mini-2024-07-18': return { mode: 'none', basis: 'not a reasoning model; no documented reasoning parameter (R08 §8)', offDocumented: true };
    case 'claude-haiku-4-5-20251001': return { mode: 'none', basis: 'extended thinking is manual-only and off when `thinking` is omitted (R08 §8)', offDocumented: true };
    case 'claude-haiku-5-5': return { mode: 'adaptive', effort: 'low', basis: 'adaptive thinking on by default; budget_tokens rejected; lowest documented control output_config.effort=low; OFF not documented in the archived pages', offDocumented: 'NOT_VERIFIED' };
    case 'claude-sonnet-5-5': return { mode: 'adaptive', effort: 'low', basis: 'adaptive thinking (Thinking: Adaptive, default effort high, in the raw capture docs/_ops/coordination/academic_20261110/runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7); `thinking: {type: disabled}` is NOT documented in the captured pages for Sonnet 5.5 and the coordination reading reports it as unsupported (reading note only): it is never sent; lowest control used output_config.effort=low (acceptance of low NOT_VERIFIED until a real call)', offDocumented: false };
    case 'claude-opus-5-5': return { mode: 'adaptive', effort: 'low', basis: 'adaptive thinking always on in Opus 5.5 (Thinking: Adaptive (always on), default effort medium, in the raw capture docs/_ops/coordination/academic_20261110/runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7); output_config.effort=low chosen for the pilot (acceptance of low NOT_VERIFIED until a real call)', offDocumented: false };
    case 'gemini-3.5-flash-lite': return { mode: 'minimal', thinkingLevel: 'minimal', basis: 'default "On (minimal)", levels minimal/low/medium/high, no OFF (google/thinking.html)', offDocumented: false };
    // E3G (C160 BRACO-GO): arm models; no reasoning parameter beyond what is documented for the API family
    case 'gemini-3.1-flash-lite': return { mode: 'minimal', thinkingLevel: 'minimal', basis: 'E3G: same generateContent thinkingConfig.thinkingLevel=MINIMAL as the Gemini adapter; the level table of thinking.html has no row for 3.x flash-lite (NOT_VERIFIED)', offDocumented: 'NOT_VERIFIED' };
    case 'gpt-6-luna': return { mode: 'none', basis: 'E3G: no reasoning parameter is sent (default effort); reasoning_tokens is parsed as a subset of completion_tokens and billed as output (DR-208)', offDocumented: 'NOT_VERIFIED' };
  }
}
/**
 * Maps rev. 2 `thinking` to the v0 `params.reasoning` record the adapters apply (never a parameter outside R08).
 *
 * @param t - Thinking configuration.
 * @returns `'NONE'`, `{effort}`, `{budget_tokens}` or `{thinking_level}`.
 */
export function reasoningRecordOf(t: ThinkingParams): Record<string, string | number | boolean> | 'NONE' {
  if (t.mode === 'none') return 'NONE';
  if (t.mode === 'adaptive') return { effort: t.effort };
  if (t.mode === 'manual') return { budget_tokens: t.budgetTokens };
  return { thinking_level: t.thinkingLevel };
}

/**
 * Item 3: the tier parameter actually requested per API (R08 §2) and the field where the served tier appears.
 *
 * @param model - Matrix model.
 * @returns The requested tier (`default`, `standard_only` or `NONE`) and the response field that reports the served tier.
 */
export function serviceTierRequestedFor(model: MatrixModel): { serviceTierRequested: string | 'NONE'; servedField: string } {
  if (model === 'gpt-4o-mini-2024-07-18' || model === 'gpt-6-luna') return { serviceTierRequested: 'default', servedField: 'service_tier (response body)' };
  if (model === 'gemini-3.5-flash-lite' || model === 'gemini-3.1-flash-lite') return { serviceTierRequested: 'NONE', servedField: 'usageMetadata.serviceTier' };
  return { serviceTierRequested: 'standard_only', servedField: 'usage.service_tier' };
}

/**
 * Item 5: cache TTL requested, from the cache directives of the plan (only Anthropic has a TTL; worst case uses the dearest).
 *
 * @param cacheDirectives - Plan cache directives, or `'NONE'`.
 * @param model - Matrix model.
 * @returns `1h` when `ttl` is `1h`, otherwise `5m`, for Claude models with directives; `NOT_APPLICABLE` otherwise.
 */
export function cacheTtlRequestedOf(cacheDirectives: Record<string, string | number | boolean> | 'NONE', model: MatrixModel): '5m' | '1h' | 'NOT_APPLICABLE' {
  if (cacheDirectives === 'NONE' || !(model === 'claude-haiku-4-5-20251001' || model === 'claude-haiku-5-5' || model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5')) return 'NOT_APPLICABLE';
  return cacheDirectives['ttl'] === '1h' ? '1h' : '5m';
}

/**
 * Item 10: documented lifecycle state (R08 §1, captured 2026-11-10).
 *
 * @param model - Matrix model.
 * @returns The lifecycle state and the quoted source (`UNKNOWN` when no page was captured).
 */
export function modelDeprecationOf(model: MatrixModel): { modelDeprecation: 'DEPRECATED_SHUTDOWN_2027-01-14' | 'LEGACY' | 'ACTIVE' | 'UNKNOWN'; source: string } {
  switch (model) {
    case 'gemini-3.1-flash-lite': case 'gpt-6-luna': return { modelDeprecation: 'UNKNOWN', source: 'E3G: no lifecycle page captured for the arm models (never invented)' };
    case 'gpt-4o-mini-2024-07-18': return { modelDeprecation: 'DEPRECATED_SHUTDOWN_2027-01-14', source: 'openai/deprecations.html: "January 14, 2027 | GPT-4o mini (gpt-4o-mini-2024-07-18) | gpt-6-luna"' };
    case 'claude-haiku-4-5-20251001': return { modelDeprecation: 'LEGACY', source: 'anthropic/haiku-4-5.html: "Claude Haiku 4.5 Legacy ... Migrate to Claude Haiku 5.5"' };
    case 'claude-haiku-5-5': return { modelDeprecation: 'ACTIVE', source: 'anthropic/models-overview.html: retirement "Not sooner than October 7, 2027"' };
    case 'claude-sonnet-5-5': return { modelDeprecation: 'ACTIVE', source: 'public models page 2026-11-12 (raw capture docs/_ops/coordination/academic_20261110/runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7): retirement not sooner than 2027-09-28' };
    case 'claude-opus-5-5': return { modelDeprecation: 'ACTIVE', source: 'public models page 2026-11-12 (raw capture docs/_ops/coordination/academic_20261110/runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7): retirement not sooner than 2027-09-22' };
    case 'gemini-3.5-flash-lite': return { modelDeprecation: 'ACTIVE', source: 'google/deprecations.html: "gemini-3.5-flash-lite | July 21, 2026 | No shutdown date announced"' };
  }
}

/**
 * Item 7: exploratoryFormulaEstimate - IMAGE ONLY, for exploratory comparison with the declared usage. It NEVER replaces L0:
 * the counter's L0 stays UNKNOWN and estimateStatus stays UNSUPPORTED_FOR_ESTIMATION for image operations.
 * gemini_rough implements the page's own "rough formula" (google/image-understanding.html: "258 tokens if both dimensions <= 384
 * pixels. Larger images are tiled into 768x768 pixel tiles, each costing 258 tokens ... crop unit size ... floor(min(width, height) / 1.5)
 * ... Divide each dimension by the crop unit size and multiply together"; example 960x540 -> crop unit 360 -> 3 x 2 = 6 tiles).
 * It is declared rough and depends on media_resolution: exploratory only.
 */
export interface ExploratoryFormulaEstimate { tokens: number | 'UNKNOWN'; formula: 'openai_tile' | 'anthropic_28px' | 'gemini_rough'; rawInputs: Record<string, number | string>; note: string }
/**
 * Exploratory image token estimate by the provider's published formula (see the comment above).
 *
 * @param model - Matrix model.
 * @param modality - Only `image` gives a result.
 * @param image - Width and height in pixels (positive integers) and, for OpenAI, the detail level (default `auto`).
 * @returns The estimate (tokens may be `'UNKNOWN'`), or `null` for non-image modalities or invalid dimensions.
 */
export function exploratoryFormulaEstimate(model: MatrixModel, modality: Modality, image: { width: number; height: number; detail?: 'low' | 'high' | 'auto' | 'original' }): ExploratoryFormulaEstimate | null {
  if (modality !== 'image') return null; // "apenas para imagem"
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (model === 'gpt-4o-mini-2024-07-18') {
    const t = OPENAI_TILE_TABLE['gpt-4o-mini']; const detail = image.detail ?? 'auto';
    if (detail === 'original') return { tokens: 'UNKNOWN', formula: 'openai_tile', rawInputs: { width, height, detail }, note: 'detail original not covered by the tile table' };
    if (detail === 'low') return { tokens: Number(t.base), formula: 'openai_tile', rawInputs: { width, height, detail, base: Number(t.base) }, note: 'low = base tokens only' };
    const r = openAiResizedDims(width, height); const tiles = Math.ceil(r.w / 512) * Math.ceil(r.h / 512);
    return { tokens: Number(t.base) + tiles * Number(t.tile), formula: 'openai_tile', rawInputs: { width, height, detail, resizedW: r.w, resizedH: r.h, tiles, base: Number(t.base), tile: Number(t.tile) }, note: 'billing may differ by one token' };
  }
  if (model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5') return { tokens: 'UNKNOWN', formula: 'anthropic_28px', rawInputs: { width, height }, note: `no archived image-token rule for ${model}: UNKNOWN (never inferred from Haiku); pilots are text-only` };
  if (model === 'claude-haiku-4-5-20251001' || model === 'claude-haiku-5-5') {
    const tierName = anthropicTierOf(model); const tier = ANTHROPIC_TIERS[tierName]; const raw = Math.ceil(width / 28) * Math.ceil(height / 28);
    const within = Math.max(width, height) <= tier.maxLongEdge && BigInt(raw) <= tier.maxTokens;
    return { tokens: within ? raw : 'UNKNOWN', formula: 'anthropic_28px', rawInputs: { width, height, tier: tierName, unresizedFormulaValue: raw, maxTokens: Number(tier.maxTokens) }, note: within ? 'not resized' : `exceeds the ${tierName} limits; resize rule page not archived; documented cap ${tier.maxTokens} is an upper bound` };
  }
  // gemini_rough
  if (width <= 384 && height <= 384) return { tokens: 258, formula: 'gemini_rough', rawInputs: { width, height, tiles: 1 }, note: 'ROUGH official formula; media_resolution dependent; exploratory only' };
  const unit = Math.floor(Math.min(width, height) / 1.5); const tiles = Math.ceil(width / unit) * Math.ceil(height / unit);
  return { tokens: 258 * tiles, formula: 'gemini_rough', rawInputs: { width, height, cropUnit: unit, tiles }, note: 'ROUGH official formula ("Divide each dimension by the crop unit size": rounding not specified, ceil used; the page example 960x540 gives 6); media_resolution dependent; exploratory only' };
}
