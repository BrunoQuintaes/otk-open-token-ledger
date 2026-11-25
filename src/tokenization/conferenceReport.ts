/**
 * Conference report computation (D3 §2–4, D4 §7–8, D4-G04, D8; front B computes, A signs,
 * C persists). Implements BuildConferenceReportFn.
 *
 * Rule 'otk.conference.rule.v1':
 *  - States: unsupported (no counter for this model/api) → unavailable (counter failed) →
 *    observed (provider usage missing/partial: nothing to compare) → incomplete (counter ran
 *    but no category is comparable, or the tokenizer is an approximation without calibration)
 *    → compared (at least one category compared). Only 'compared' carries a verdict.
 *  - Compared values: 'input' compares the local text count with T_entrada (base input plus
 *    input-side separate addends, e.g. Anthropic cache read/write, because the local count
 *    covers the whole prompt text); 'output' compares visible output text with the output base.
 *    Output is uncovered whenever a hidden subset (reasoning/audio inside output) is non-zero;
 *    Gemini thoughts are a separate addend and are listed as uncovered.
 *  - delta = provider − local. relativeDelta = floor(|delta| × 10^6 / provider) / 10^6 as a
 *    fixed 6-digit string; null when provider is 0 or absent (absolute error still reported).
 *  - divergent ⇔ |delta| > absoluteTokens AND (provider = 0 OR relative = null OR
 *    relativeDelta > relative). Provider 0 with local 100 and absoluteTokens 16 is divergent.
 *  - The default threshold is heuristic (calibrated = false, calibrationVersion = null). No
 *    percentage here is a demonstrated precision.
 *  - v1.2 (OVERNIGHT 20261005, Phase 8): when a calibration is passed, its record is stored in the report
 *    (`calibration`). With a COMPATIBLE calibrated profile each comparison of a category the profile covers also
 *    carries `adjusted` (expectation from the raw local count, delta, relative delta) and the verdict is taken on
 *    the adjusted deltas; raw local counts, raw deltas and provider usage are never overwritten. A category the
 *    profile does not cover keeps its raw numbers but leaves the verdict (listed as uncovered). Without a
 *    calibration argument the report is byte-for-byte the v1.1 one.
 *
 * @module src/tokenization/conferenceReport
 */
import type {
  CategoryComparison, ConferenceCalibration, ConferenceReport, ConferenceState, ConferenceThreshold, ConferenceVerdict, Hex32, IsoTime,
  LocalCountResult, ModelSupport, NormalizedUsage, OperationKey, TokenCategoryName,
} from '../types/d1d8/index.js';
import { categorySide } from '../providers/usage/normalizeUsage.js';

/**
 * Identifier of the comparison rule described above.
 */
export const CONFERENCE_RULE_ID = 'otk.conference.rule.v1';

/**
 * Heuristic default: not calibrated, chosen only to ignore envelope-sized gaps on tiny prompts. The rule
 * ">16 tokens AND >10%" is a HEURISTIC with no evidence behind its values (Phase 8 audit); it stays labelled
 * so (calibrated = false, calibrationVersion = null) until a profile validated out of sample replaces it.
 */
export const HEURISTIC_THRESHOLD_LABEL = 'HEURISTIC' as const;
/**
 * Default threshold: more than 16 tokens AND more than 10 %; heuristic and uncalibrated.
 */
export const HEURISTIC_THRESHOLD_V0: ConferenceThreshold = Object.freeze({
  absoluteTokens: 16n,
  relative: '0.100000',
  calibrationVersion: null,
  calibrated: false,
}) as ConferenceThreshold;

const REL_SCALE = 1_000_000n;

/**
 * Formats |delta| / provider with 6 decimals, truncated (not rounded).
 *
 * @param delta - Difference in tokens (sign ignored).
 * @param provider - Provider count in tokens.
 * @returns The decimal text, or `null` when `provider` is 0 or negative.
 */
export function relativeDeltaString(delta: bigint, provider: bigint): string | null {
  if (provider <= 0n) return null;
  const abs = delta < 0n ? -delta : delta;
  const q = (abs * REL_SCALE) / provider;
  return `${q / REL_SCALE}.${(q % REL_SCALE).toString().padStart(6, '0')}`;
}

/**
 * Parse a fixed decimal string to micro units; throws on malformed thresholds.
 *
 *
 * @param s - Non-negative decimal with at most 6 fraction digits.
 * @returns The value × 10^6.
 * @throws {Error} When `s` is not in that format.
 */
export function decimalToMicro(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`invalid decimal threshold ${s}`);
  return BigInt(m[1]!) * REL_SCALE + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/**
 * Applies the divergence rule of the file header to one comparison.
 *
 * @param c - Comparison of one category.
 * @param t - Threshold to apply.
 * @returns `true` when the gap exceeds both the absolute and the relative limit (or the relative one cannot apply).
 * @throws {Error} When `t.relative` or `c.relativeDelta` is not a valid decimal.
 */
export function isDivergent(c: CategoryComparison, t: ConferenceThreshold): boolean {
  if (c.absoluteDelta === null) return false;
  const abs = c.absoluteDelta < 0n ? -c.absoluteDelta : c.absoluteDelta;
  if (abs <= t.absoluteTokens) return false;
  if (c.provider === 0n || t.relative === null || c.relativeDelta === null) return true;
  return decimalToMicro(c.relativeDelta) > decimalToMicro(t.relative);
}

/**
 * Inputs of {@link buildConferenceReport}.
 */
export interface BuildConferenceArgs {
  key: OperationKey;
  receiptDigest: Hex32;
  usage: NormalizedUsage;
  local: LocalCountResult;
  support: ModelSupport;
  threshold: ConferenceThreshold;
  /** Time written into the report (the function reads no clock). */
  now: IsoTime;
  calibration?: ConferenceCalibration;
}

function cat(usage: NormalizedUsage, name: TokenCategoryName) {
  return usage.categories.find((c) => c.name === name);
}

/**
 * BuildConferenceReportFn.
 *
 *
 * @param args - Operation key, receipt digest, normalized usage, local count, model support, threshold, time
 *   and optional calibration.
 * @returns The report (unsigned); inputs are not modified.
 * @throws {Error} When a threshold value is not a valid decimal.
 */
export function buildConferenceReport(args: BuildConferenceArgs): ConferenceReport {
  const { usage, local, support, threshold } = args;
  const localOf = (name: TokenCategoryName) => local.counts.find((c) => c.category === name)?.count ?? null;
  const report = (state: ConferenceState, verdict: ConferenceVerdict, comparisons: CategoryComparison[],
    covered: TokenCategoryName[], uncovered: TokenCategoryName[]): ConferenceReport => ({
    schema: 'otk.conference.v1',
    key: { ...args.key },
    receiptDigest: args.receiptDigest,
    tokenizer: support.tokenizer,
    coveredCategories: covered,
    uncoveredCategories: [...new Set(uncovered)].filter((u) => !covered.includes(u)),
    comparisons,
    threshold: { ...threshold },
    state,
    verdict,
    counterVersion: local.counterVersion,
    createdAt: args.now,
    // contract 1.1.0 (R-B1): catalog support level and version, covered by the CE1 signature
    support: support.support,
    catalogVersion: support.catalogVersion,
    ...(args.calibration ? { calibration: { ...args.calibration.record } } : {}),
  });
  const reported = usage.categories.filter((c) => c.count !== null).map((c) => c.name);
  const observedOnly = (): CategoryComparison[] => local.counts.map((c) => ({
    category: c.category, provider: null, local: c.count, absoluteDelta: null, relativeDelta: null,
  }));

  if (support.support === 'unsupported' || !support.tokenizer || local.status === 'unsupported') {
    return report('unsupported', 'not_applicable', [], [], [...reported, 'input', 'output']);
  }
  if (local.status === 'failed') return report('unavailable', 'not_applicable', [], [], [...reported, 'input', 'output']);
  if (usage.completeness !== 'complete' || usage.tIn === null || usage.tOut === null) {
    return report('observed', 'not_applicable', observedOnly(), [], [...reported, ...local.uncovered]);
  }

  const covered: TokenCategoryName[] = [];
  const uncovered: TokenCategoryName[] = [...local.uncovered];
  const comparisons: CategoryComparison[] = [];
  const expected = threshold.calibrated && args.calibration?.expected ? args.calibration.expected : null;
  const compare = (category: TokenCategoryName, provider: bigint) => {
    const l = localOf(category);
    if (l === null) return;
    const delta = provider - l;
    const c: CategoryComparison = { category, provider, local: l, absoluteDelta: delta, relativeDelta: relativeDeltaString(delta, provider) };
    const e = expected ? expected(category, l) : null;
    if (e !== null) c.adjusted = { expected: e, absoluteDelta: provider - e, relativeDelta: relativeDeltaString(provider - e, provider) };
    comparisons.push(c);
  };

  // Input: whole prompt text vs T_entrada.
  const inputAddends = usage.categories.filter((c) => c.inclusion === 'separate_addend' && c.count !== null && categorySide(c.name) === 'input');
  const audioIn = cat(usage, 'input_audio')?.count ?? null;
  if (local.covered.includes('input') && !(audioIn !== null && audioIn > 0n) && !inputAddends.some((c) => c.name === 'tool_use_prompt' && (c.count ?? 0n) > 0n)) {
    compare('input', usage.tIn);
    covered.push('input', ...inputAddends.map((c) => c.name));
  } else {
    uncovered.push('input', ...inputAddends.map((c) => c.name));
  }

  // Output: visible text vs output base; a hidden subset inside the base makes it uncovered.
  const outputBase = cat(usage, 'output')!;
  const hiddenSubset = usage.categories.some((c) => c.inclusion === 'subset_of_output' && (c.count ?? 0n) > 0n);
  const outputAddends = usage.categories.filter((c) => c.inclusion === 'separate_addend' && c.count !== null && categorySide(c.name) === 'output');
  if (local.covered.includes('output') && !hiddenSubset && outputBase.count !== null) {
    compare('output', outputBase.count);
    covered.push('output');
  } else {
    uncovered.push('output');
  }
  uncovered.push(...outputAddends.map((c) => c.name));
  if (hiddenSubset) uncovered.push(...usage.categories.filter((c) => c.inclusion === 'subset_of_output' && (c.count ?? 0n) > 0n).map((c) => c.name));

  if (comparisons.length === 0) return report('incomplete', 'not_applicable', [], [], [...reported, ...uncovered]);
  // An approximate tokenizer gives numbers, not a verdict, until a calibration exists for it.
  if ((support.support === 'generic_fallback') && (!threshold.calibrated || threshold.calibrationVersion === null)) {
    return report('incomplete', 'not_applicable', comparisons, [], [...reported, ...covered, ...uncovered]);
  }
  if (expected) {
    // calibrated: only categories with an adjusted expectation are judged, on the adjusted deltas
    const judged = comparisons.filter((c) => c.adjusted);
    const unjudged: TokenCategoryName[] = comparisons.filter((c) => !c.adjusted).map((c) => c.category);
    // an unjudged input also takes its input-side addends out of the verdict
    if (unjudged.includes('input')) unjudged.push(...inputAddends.map((c) => c.name));
    const coveredJ = covered.filter((c) => !unjudged.includes(c));
    if (judged.length === 0) return report('incomplete', 'not_applicable', comparisons, [], [...reported, ...covered, ...uncovered]);
    const v: ConferenceVerdict = judged.some((c) => isDivergent({ ...c, absoluteDelta: c.adjusted!.absoluteDelta, relativeDelta: c.adjusted!.relativeDelta }, threshold))
      ? 'divergent' : 'within_threshold';
    return report('compared', v, comparisons, coveredJ, [...uncovered, ...unjudged]);
  }
  const verdict: ConferenceVerdict = comparisons.some((c) => isDivergent(c, threshold)) ? 'divergent' : 'within_threshold';
  return report('compared', verdict, comparisons, covered, uncovered);
}
