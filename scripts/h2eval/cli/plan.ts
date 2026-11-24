/**
 * R15 `plan`: pre-registered protocol + corpus manifest ⇒ operation plan per batch (≤ 60 calls, one model per batch), each operation
 * with its costCap (worst case by the frozen price table) and the batch cap = min(1.5 × Σ costCap, 25 % of the provider sub-ledger)
 * (R10 R2 §5.1). inputUpperBoundTokens is DERIVED here (local estimate × factor + extra, parameters recorded in the plan), never in
 * the executor. The pre-registration hash must be the ratified one (`--ratified-sha`); `--unratified-rehearsal` is accepted ONLY for
 * OFFLINE rehearsals and marks the plan `ratified:false` (the executor refuses REAL for such a plan: no GO can carry an unratified hash).
 * Pure function `buildPlan` + a thin file writer. Nothing here does network.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { H2EVAL_SCHEMA, type OperationPlan, type Provider } from '../types.js';
import { contentOf, type Dialog } from '../cache/dialogs.js';
import { contentOfS1 } from '../cache/contentStore.js';
import type { S1Prompt } from '../corpus/s1Corpus.js';
import type { S1Operation, ModelId } from '../corpus/s1Plan.js';
import { computeCostCap } from '../record/cost.js';
import { priceTableFromModal, MATRIX_MODELS, loadE3GPriceTable } from '../index.js';
import { isArmModel } from '../core/e3gArm.js';
import { CAPS_PROFILE_BRACO_GO_GOOGLE, CAPS_PROFILE_BRACO_GO_OPENAI } from '../core/ledger.js';
import { reasoningRecordOf, serviceTierRequestedFor, cacheTtlRequestedOf, type ThinkingParams as ContractThinking } from '../modal/contract_r2.js';
import { loadDesignParams, thinkingParamsOf, resolveArmDesign, armOf, armEnabled, ARMS, DEFAULT_DESIGN_PARAMS_FILE, type ThinkingPolicy, type Arm } from '../design/designParams.js';
import type { MatrixModel } from '../modal/types.js';
import { CAPS_PROFILE_CICLO3, usdToPico } from '../core/ledger.js';
import { bodyOf } from '../modal/index.js';
import { operationIdOf } from '../core/ids.js';
import { contentOfPilot, maxTokensOf, type PilotList } from './pilot.js';
import { CliError, EXIT, MATRIX_TO_API, MATRIX_TO_ENCODING, MATRIX_TO_PROVIDER, MODEL_ID_TO_MATRIX, readJson, readJsonl, sha256File, sha256Text, writeJson } from './common.js';

export const PLAN_SCHEMA = 'h2eval.batch_plan.v0';
export interface PlanPolicy { inputBoundFactor: number; inputBoundExtraTokens: number; /** VNEXT-2: output ceiling PER MODEL, from the design parameters file (never a constant) */ maxOutputTokensByModel: Record<MatrixModel, number>; /** VNEXT-2: the ratified design parameters this plan was built from (sha256 folded into protocolHash) */ design: { file: string; sha256: string; designId: string; thinkingByModel: Record<MatrixModel, ThinkingPolicy>; /** VNEXT-8 */ integrity: { stopReasonRequired: boolean; thinkingDisabledRejectedStops: boolean }; /** VNEXT-8: effective (model, arm) → maxTokens/policy, as applied */ byModelArm: Record<string, { maxTokens: number; policy: string; reasoningAllowanceTokens: number }>; /** VNEXT-F (R17-V-7/8): conditions per model and the P1 probe operation, as planned */ conditions: Record<string, string[]>; probe: { model: string; conditionId: string; operationId: string } | null; /** C153 (P4 option C): arms the design switched off (`arms.<Tn>.enabled: false`); present ONLY when non-empty, so designs without the field produce byte-identical plans */ disabledArms?: Array<{ model: string; arm: Arm; reason: string }>; /** VNEXT-8: R4 opsPerSplit vs corpus-derived counts (report, never a silent reconciliation) */ opsCheck: Array<{ model: string; arm: Arm; split: string; expected: number; actual: number; match: boolean }> }; maxCallsPerBatch: number; batchCapFactor: number; batchCapMaxFractionOfProvider: number; capsUsd: { campaign: string; providers: Record<Provider, string> }; estimator: { package: string; encodings: Record<MatrixModel, string> } }
export interface PlannedOperation { operationId: string; plan: OperationPlan; inputUpperBoundTokens: number; reasoningAllowanceTokens: number; localEstimateTokens: number; costCapUsdPico: string; costCapBasis: string; /** sha256(canonical body) from the adapter (single source): must equal the journal's requestBodySha256 */ bodySha256: string; /** VNEXT-F: SC1 condition and P1 probe flag (from the design file) */ condition: string | null; probe: 'P1' | null; /** VNEXT-6 (C151 item 6, D7 option A): the eligible positions for a cache HIT are marked IN THE PLAN (call 2 and 3 of an S3 dialogue, after the creation call); S1/S2 and call 1 are never eligible */ d7: { cacheArm: string; callIndex: number | null; eligibleForHit: boolean } }
export type Block = 'pilot' | 'train' | 'comparative' | 'validation' | 'holdout';
export interface PlannedBatch { batchId: string; provider: Provider; model: MatrixModel; branchLocked: boolean; /** R18–R20 code lock: train → comparative → validation → holdout */ block: Block; order: number; calls: number; sumCostCapUsdPico: string; batchCapUsdPico: string; batchCapRule: string; /** worst-case cumulative of the provider up to and including this batch, in plan order */ cumulativeWorstCaseUsdPico: string; /** the GO of this batch must carry pauseAck80pct (worst case crosses 80 % of the sub-ledger at or before it) */ requiresPauseAckInGo: boolean; operations: PlannedOperation[] }
/** E2: per-model batch boundaries between the blocks (locked order) */
export type SplitBoundaries = Record<string, Record<Block, string[]>>;
export interface PauseForecast { provider: Provider; subLedgerUsd: string; worstCaseCumulativeUsdPico: string; fractionOfSubLedger: string; crossesPauseAt80pct: boolean; firstBatchRequiringPauseAck: string | null }
export interface BatchPlan { schema: typeof PLAN_SCHEMA; studyId: string; phase: 'PILOT' | 'CONFIRMATORY'; protocolHash: string; /** E2: true when the plan was produced with --order-by-split (required for CAMPAIGN) */ orderBySplit: boolean; splitBoundaries: SplitBoundaries; /** ECON-02 finding: where the worst case crosses 80 % of a sub-ledger and which batches need pauseAck80pct in their GO */ pauseForecast: PauseForecast[]; notPlanned: string[]; maxOutputTokensPolicy: string; preregistration: { file: string; sha256: string; ratified: boolean; ratifiedSha256: string | null }; corpus: { dir: string; manifestSha256: string; corpusSha256: string; seed: number }; priceTable: { id: string; sha256: string }; /** C157 9.2 pilots only: identity of the closed list (v3: prompts-only hash + one hash per model with its max_tokens) */ pilotList?: { schema: string; fileSha256: string; listaSha256: string; perModelListSha256?: Record<string, string> }; /** pilots only: absolute per-batch ceiling in USD, enforced by raise-batch-cap */ pilotAbsoluteBatchCapUsd?: string; /** C159C G-1: present ONLY when an R6-M model was planned on a corpus carrying the r6mHoldout mark (plans without it are byte-identical to E2') */ r6mPopulation?: Record<string, { rule: string; holdoutUnitsInCorpus: { s1: number; dialogs: number }; holdoutUnitsPlanned: { s1: number; dialogs: number }; holdoutCallsPlanned: number; executesNothing: true }>; policy: PlanPolicy; batches: PlannedBatch[]; totals: Record<Provider, { calls: number; sumCostCapUsdPico: string; batches: number }>; generatedUtc: string }

/**
 * C158 ciclo 3 (found by the synthetic rehearsal): the corpus generator writes s1_operations.<id>.jsonl only for the original model ids, so a CAMPAIGN plan for Sonnet/Opus 5.5 failed with S1_OPERATIONS_MISSING
 * (corpusId undefined). They use the claude-haiku-5-5 list: same prompts, groups and splits (R6-M reads the holdout paired by text; the texts are common to the models). Nothing else changes; GPT/Gemini/Haiku are untouched.
 */
/**
 * C160 E3G3 (B1 of PROTO-GO): the arm models (gemini-3.1-flash-lite, gpt-6-luna) had NO alias either, so a CAMPAIGN plan read s1_operations.undefined.jsonl.
 * Each one now uses the FULL list of the legacy model of the SAME provider (gemini-3.5-flash-lite, gpt-4o-mini): same prompts, groups and splits.
 * A model with neither its own corpus id nor an alias is refused with S1_CORPUS_ALIAS_MISSING (explicit STOP; never the name "undefined").
 */
const CORPUS_OPS_ALIAS: Partial<Record<MatrixModel, ModelId>> = { 'claude-sonnet-5-5': 'claude-haiku-5-5', 'claude-opus-5-5': 'claude-haiku-5-5', 'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite', 'gpt-6-luna': 'gpt-4o-mini' };
/** C160 E3G3: corpus id of a model's S1 operation list, or null when it has neither its own id nor an alias (the caller STOPs). */
export function s1CorpusIdOf(model: string): ModelId | null { return (Object.keys(MODEL_ID_TO_MATRIX) as ModelId[]).find((k) => MODEL_ID_TO_MATRIX[k] === model) ?? (Object.prototype.hasOwnProperty.call(CORPUS_OPS_ALIAS, model) ? CORPUS_OPS_ALIAS[model as MatrixModel]! : null); }
/**
 * C159C G-1 (R6-M population): protocol ff49033b + PLANO_UNIDADES_R6M 7ca1b93b. For the R6-M models (Sonnet/Opus 5.5) a CONFIRMATORY plan takes train and
 * validation WHOLE and, from the holdout, ONLY the units the corpus marks `r6mHoldout: true` (S1 prompts by promptId, dialogs by dialogId). The plan only
 * IDENTIFIES those operations (nothing is sent here). When the corpus carries the mark, it must be a boolean on EVERY unit of s1_prompts.jsonl and
 * dialogs.jsonl, equal to the mark of the same unit in manifest.json, `true` only inside the holdout split, and `true` on at least one unit; otherwise the
 * plan is refused. A corpus with NO mark anywhere (pre-G2 corpora, synthetic test corpora) keeps the previous behaviour, byte for byte (declared:
 * the plan then carries no `r6mPopulation`, and the kit's plan_check refuses any R6-M package above 405 calls). Haiku, GPT and Gemini never change.
 */
export const R6M_MODELS: readonly MatrixModel[] = ['claude-sonnet-5-5', 'claude-opus-5-5'];
export interface R6mPopulation { rule: string; s1HoldoutPromptIds: Set<string>; dialogHoldoutIds: Set<string>; marked: { s1: number; dialogs: number }; holdoutUnits: { s1: number; dialogs: number } }
type Marked = { split?: string; r6mHoldout?: unknown };
export function r6mPopulationOf(prompts: Array<S1Prompt & Marked>, dialogs: Array<Dialog & Marked>, manifest: { s1?: { prompts?: Array<{ promptId: string } & Marked> }; dialogs?: Array<{ dialogId: string } & Marked> }): R6mPopulation | null {
  const has = (x: Marked) => Object.prototype.hasOwnProperty.call(x, 'r6mHoldout');
  const mPrompts = manifest.s1?.prompts ?? []; const mDialogs = manifest.dialogs ?? [];
  if (![...prompts, ...dialogs, ...mPrompts, ...mDialogs].some(has)) return null; // no mark anywhere: previous behaviour (declared above)
  const check = (what: string, id: string, x: Marked) => {
    if (typeof x.r6mHoldout !== 'boolean') throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_MARK_MISSING', `${what} ${id}: r6mHoldout must be a boolean on every unit when the corpus carries the R6-M mark`);
    if (x.r6mHoldout && x.split !== 'holdout') throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_MARK_OUTSIDE_HOLDOUT', `${what} ${id}: r6mHoldout=true in split ${String(x.split)}`);
  };
  for (const p of prompts) check('s1_prompts.jsonl', p.promptId, p);
  for (const d of dialogs) check('dialogs.jsonl', d.dialogId, d);
  const mp = new Map(mPrompts.map((x) => [x.promptId, x])); const md = new Map(mDialogs.map((x) => [x.dialogId, x]));
  if (mp.size !== prompts.length || md.size !== dialogs.length) throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_MARK_MISMATCH', `manifest.json lists ${mp.size} prompts / ${md.size} dialogs, the corpus files ${prompts.length} / ${dialogs.length}`);
  for (const p of prompts) { const m = mp.get(p.promptId); if (!m || m.r6mHoldout !== p.r6mHoldout || m.split !== p.split) throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_MARK_MISMATCH', `prompt ${p.promptId}: manifest.json and s1_prompts.jsonl disagree on r6mHoldout/split`); }
  for (const d of dialogs) { const m = md.get(d.dialogId); if (!m || m.r6mHoldout !== d.r6mHoldout || m.split !== d.split) throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_MARK_MISMATCH', `dialog ${d.dialogId}: manifest.json and dialogs.jsonl disagree on r6mHoldout/split`); }
  const s1HoldoutPromptIds = new Set(prompts.filter((p) => p.r6mHoldout === true).map((p) => p.promptId)); const dialogHoldoutIds = new Set(dialogs.filter((d) => d.r6mHoldout === true).map((d) => d.dialogId));
  if (s1HoldoutPromptIds.size + dialogHoldoutIds.size === 0) throw new CliError(EXIT.PLAN_INVALID, 'R6M_HOLDOUT_EMPTY', 'the corpus carries the R6-M mark but no unit is r6mHoldout=true');
  return { rule: 'R6-M (C159C G-1): train and validation whole; holdout = units with r6mHoldout=true in the corpus (s1 by promptId, dialogs by dialogId)', s1HoldoutPromptIds, dialogHoldoutIds, marked: { s1: s1HoldoutPromptIds.size, dialogs: dialogHoldoutIds.size }, holdoutUnits: { s1: prompts.filter((p) => p.split === 'holdout').length, dialogs: dialogs.filter((d) => d.split === 'holdout').length } };
}
/** C158 ciclo 3: --caps-profile default|ciclo3_c158 (absent = default 11/5/3/3). Unknown names are refused. */
export function capsOfProfile(name: string | undefined): { campaign: string; providers: Record<Provider, string> } | undefined {
  if (name === undefined || name === 'default') return undefined;
  // E3G (C160 BRACO-GO): the per-provider arm profiles (US$ 1,00, the other providers 0)
  if (name === 'braco_go_google' || name === 'braco_go_openai') { const pr = name === 'braco_go_google' ? CAPS_PROFILE_BRACO_GO_GOOGLE : CAPS_PROFILE_BRACO_GO_OPENAI; return { campaign: pr.campaign, providers: { ...pr.providers } }; }
  if (name !== 'ciclo3_c158') throw new CliError(EXIT.USAGE, 'CAPS_PROFILE_UNKNOWN', '--caps-profile default|ciclo3_c158|braco_go_google|braco_go_openai');
  return { campaign: CAPS_PROFILE_CICLO3.campaign, providers: { ...CAPS_PROFILE_CICLO3.providers } };
}
export interface PlanInput {
  corpusDir: string; preregFile: string; ratifiedSha256?: string; unratifiedRehearsal?: boolean; phase: 'PILOT' | 'CONFIRMATORY';
  models?: MatrixModel[]; studyId?: string; /** VNEXT-2: ratified design parameters file (h2eval.design_params.v1); default = the R3.2-equivalent file shipped with the executor */ designParamsFile?: string; inputBoundFactor?: number; inputBoundExtraTokens?: number; maxCallsPerBatch?: number;
  capsUsd?: { campaign: string; providers: Record<Provider, string> }; now?: () => string;
  /** E2: explicit opt-in to the locked split order; CAMPAIGN refuses without it */
  orderBySplit?: boolean;
  /** C157 §9.2 (E2E-01): closed list of synthetic pilot prompts (plan --pilot-prompts). PILOT only. Replaces the S1 corpus: one operation per (model, prompt), max_tokens per prompt from the list, thinking/allowance from the design file. */
  pilotList?: PilotList;
  /** C157 §9.2: explicit per-batch cap in USD. It can only LOWER the rule min(1.5 × Σ costCap, 25 % of the sub-ledger), and must cover Σ costCap (otherwise the batch could not finish). */
  batchCapUsd?: string;
}

type Counter = (t: string) => number;
function loadCounters(): Record<'o200k_base' | 'cl100k_base', Counter> {
  const req = createRequire(import.meta.url);
  const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
  const mk = (n: string): Counter => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
  return { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
}

const textOf = (c: { messages: Array<{ parts: Array<{ type: string; text?: string }> }> }): string => c.messages.flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('\n');
const BLOCKS: readonly Block[] = ['train', 'comparative', 'validation', 'holdout'];
const blockOfPlan = (p: OperationPlan): Block => (p.phase === 'PILOT' ? 'pilot' : p.phase === 'COMPARATIVE_PAIRED' || p.split === 'COMPARATIVE' ? 'comparative' : p.split === 'validation' ? 'validation' : p.split === 'holdout' ? 'holdout' : 'train');

/** C157 §9.2: initial budget per pilot model and absolute ceiling after the single duplication. Enforced in code (plan default + ledger refusal). */
export const PILOT_INITIAL_BATCH_CAP_USD = '0.30'; export const PILOT_ABSOLUTE_BATCH_CAP_USD = '0.60';
export function buildPlan(i: PlanInput): BatchPlan {
  if (!existsSync(i.preregFile)) throw new CliError(EXIT.USAGE, 'PREREG_MISSING', i.preregFile);
  const preregSha = sha256File(i.preregFile);
  let ratified = false;
  if (i.ratifiedSha256) { if (!/^[0-9a-f]{64}$/.test(i.ratifiedSha256)) throw new CliError(EXIT.USAGE, 'BAD_RATIFIED_SHA', 'hex64 expected'); if (i.ratifiedSha256 !== preregSha) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PREREG_NOT_RATIFIED_HASH', 'the pre-registration file hash differs from the ratified hash'); ratified = true; }
  else if (!i.unratifiedRehearsal) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PREREG_RATIFICATION_REQUIRED', 'pass --ratified-sha <hex64> (G10) or --unratified-rehearsal (OFFLINE only)');
  const manifestPath = path.join(i.corpusDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new CliError(EXIT.USAGE, 'CORPUS_MANIFEST_MISSING', manifestPath);
  const manifest = readJson<{ corpusSha256: string; seed: number; modelDesigns: Record<string, { design: 'FULL' | 'B_REDUZIDO' }>; s1?: { prompts?: Array<{ promptId: string; split?: string; r6mHoldout?: unknown }> }; dialogs?: Array<{ dialogId: string; split?: string; r6mHoldout?: unknown }> }>(manifestPath);
  if (i.pilotList) i = { ...i, batchCapUsd: i.batchCapUsd !== undefined && usdToPico(i.batchCapUsd) < usdToPico(PILOT_INITIAL_BATCH_CAP_USD) ? i.batchCapUsd : PILOT_INITIAL_BATCH_CAP_USD }; // W3: a pilot batch cap is NEVER above the initial US$ 0.30 per model (C157 9.2); --batch-cap-usd can only lower it further
  if (i.pilotList && i.phase !== 'PILOT') throw new CliError(EXIT.REFUSED_BY_POLICY, 'PILOT_LIST_ONLY_FOR_PILOT', '--pilot-prompts is valid only with --phase pilot');
  const prompts = i.pilotList ? [] : readJsonl<S1Prompt>(path.join(i.corpusDir, 's1_prompts.jsonl'));
  const dialogs = i.pilotList ? [] : readJsonl<Dialog>(path.join(i.corpusDir, 'dialogs.jsonl'));
  const counters = loadCounters();
  const prices = priceTableFromModal(); let armPrices: ReturnType<typeof loadE3GPriceTable> | undefined; // E3G: arm models are priced ONLY by the attested arm table
  // VNEXT-2: every generation parameter comes from the design file (R3.2-equivalent by default; R4 when ratified)
  const design = loadDesignParams(i.designParamsFile ?? DEFAULT_DESIGN_PARAMS_FILE);
  const maxOutputTokensByModel = Object.fromEntries(MATRIX_MODELS.filter((m) => design.params.perModel[m]).map((m) => [m, design.params.perModel[m]!.maxTokens])) as Record<MatrixModel, number>;
  const thinkingByModel = Object.fromEntries(MATRIX_MODELS.filter((m) => design.params.perModel[m]).map((m) => [m, design.params.perModel[m]!.thinking])) as Record<MatrixModel, ThinkingPolicy>;
  const policy: PlanPolicy = {
    inputBoundFactor: i.inputBoundFactor ?? 1.25, inputBoundExtraTokens: i.inputBoundExtraTokens ?? 64, maxOutputTokensByModel, design: { file: path.basename(design.file), sha256: design.sha256, designId: design.params.designId, thinkingByModel, integrity: { stopReasonRequired: design.params.integrity?.stopReasonRequired ?? false, thinkingDisabledRejectedStops: design.params.integrity?.thinkingDisabledRejectedStops ?? false }, byModelArm: {}, conditions: {}, probe: null, opsCheck: [] }, maxCallsPerBatch: Math.min(60, i.maxCallsPerBatch ?? 60), batchCapFactor: 1.5, batchCapMaxFractionOfProvider: 0.25,
    capsUsd: i.capsUsd ?? { campaign: '11', providers: { anthropic: '5', openai: '3', google: '3' } }, estimator: { package: 'js-tiktoken (local estimate, never the provider count)', encodings: Object.fromEntries(Object.entries(MATRIX_TO_ENCODING).filter(([m]) => design.params.perModel[m as MatrixModel])) as typeof MATRIX_TO_ENCODING },
  };
  if (i.phase === 'CONFIRMATORY' && i.orderBySplit !== true) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PLAN_ORDER_BY_SPLIT_REQUIRED', 'a CAMPAIGN plan must be produced with --order-by-split (R10 R3 §5.3: train → validation → holdout is a requirement of any ex-ante claim)');
  // VNEXT-2: the design file is part of the protocol identity (a different ceiling/policy ⇒ different protocolHash ⇒ new plans ⇒ new GO)
  const protocolHash = sha256Text(`${preregSha}:${manifest.corpusSha256}:${i.phase}:${design.sha256}`);
  const nowUtc = (i.now ?? (() => new Date().toISOString()))();
  const models = i.models ?? MATRIX_MODELS.filter((m) => design.params.perModel[m]);
  for (const m of models) if (!design.params.perModel[m]) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_MODEL_NOT_DECLARED', `${m} is not declared in design ${design.params.designId}: declare it in the design file (it enters the protocolHash) before planning`);
  // C159C G-1: R6-M population, resolved once (only for a CONFIRMATORY corpus plan that includes an R6-M model)
  const r6m = i.phase === 'CONFIRMATORY' && !i.pilotList && models.some((m) => R6M_MODELS.includes(m)) ? r6mPopulationOf(prompts, dialogs, manifest) : null;
  const r6mPopulation: NonNullable<BatchPlan['r6mPopulation']> = {};
  const byModelArm = policy.design.byModelArm; const opsCount: Record<string, number> = {};
  const batches: PlannedBatch[] = [];
  const totals = { anthropic: { calls: 0, sumCostCapUsdPico: '0', batches: 0 }, openai: { calls: 0, sumCostCapUsdPico: '0', batches: 0 }, google: { calls: 0, sumCostCapUsdPico: '0', batches: 0 } } as BatchPlan['totals'];

  const disabledArms: Array<{ model: string; arm: Arm; reason: string }> = []; // C153
  for (const model of models) {
    const provider = MATRIX_TO_PROVIDER[model]; const api = MATRIX_TO_API[model]; const enc = MATRIX_TO_ENCODING[model];
    const corpusId = s1CorpusIdOf(model); // C160 E3G3: null => S1_CORPUS_ALIAS_MISSING where the list is read
    const md = design.params.perModel[model]!; // presence checked above (DESIGN_MODEL_NOT_DECLARED)
    const pop = r6m && R6M_MODELS.includes(model) ? r6m : null; // C159C G-1
    const inR6m = (split: string, kind: 's1' | 'dialog', id: string): boolean => !pop || split !== 'holdout' || (kind === 's1' ? pop.s1HoldoutPromptIds : pop.dialogHoldoutIds).has(id);
    const tier = serviceTierRequestedFor(model).serviceTierRequested;
    // VNEXT-8: every generation parameter is resolved per (model, ARM): T1 summary, T2 code, T3 analysis, T4 S2, T5 S3 (R4 design)
    const paramsFor = (cacheDirectives: OperationPlan['params']['cacheDirectives'], eff: { maxTokens: number; thinking: ThinkingPolicy }): OperationPlan['params'] => { const thinking = thinkingParamsOf(eff.thinking) as ContractThinking; return { maxTokens: eff.maxTokens, temperature: 'DEFAULT', reasoning: reasoningRecordOf(thinking), serviceTier: tier, serviceTierRequested: tier, cacheDirectives, thinking: { ...thinking } as OperationPlan['params']['thinking'], cacheTtlRequested: cacheTtlRequestedOf(cacheDirectives, model) }; };
    const baseParams = (cacheDirectives: OperationPlan['params']['cacheDirectives'], arm: Arm): OperationPlan['params'] => paramsFor(cacheDirectives, resolveArmDesign(md, arm));
    if (md.conditions) policy.design.conditions[model] = md.conditions.list.map((c) => c.conditionId);
    for (const arm of ARMS) if (!armEnabled(md, arm)) disabledArms.push({ model, arm, reason: md.arms?.[arm]?.reason ?? 'disabled in design (enabled: false)' }); // C153
    const ops: Array<{ plan: OperationPlan; text: string; content: ReturnType<typeof contentOfS1> | ReturnType<typeof contentOf> }> = [];
    // S1
    if (i.phase === 'PILOT' && i.pilotList) {
      // C157 §9.2: closed list; per-prompt max_tokens (list), thinking policy and allowance (design file, model level); no conditions, no arms, no cache
      for (const p of i.pilotList.prompts) {
        const c = contentOfPilot(p);
        ops.push({ text: textOf(c), content: c, plan: { schema: H2EVAL_SCHEMA.plan, studyId: i.studyId ?? 'H2EVAL', protocolHash, manifestSha256: sha256File(manifestPath), batchId: 'TBD', phase: 'PILOT', cellId: `pilot-${p.id}`, groupId: `pilot-${p.id}`, promptId: p.id, rep: 0, variant: '0', split: 'NONE', provider, api, endpoint: '', modelRequested: model, task: 'analysis', sizeBucket: p.user.length > 1500 ? 'L' : 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: c.promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: paramsFor('NONE', { maxTokens: maxTokensOf(p, model), thinking: md.thinking }) } });
      }
    } else if (i.phase === 'PILOT') {
      // VNEXT-F (R17-V-7): with `conditions`, every S1 prompt of the listed arms is planned ONCE PER CONDITION (block order = list order; cellId gets
      // `~<conditionId>` so the operationId differs); the first operation of the probe condition is the P1 probe (R17-V-8)
      const pilotPrompts = prompts.filter((x) => x.phase === 'PILOT'); const conds = md.conditions; let probeDone = false;
      const emit = (p: S1Prompt, cond: { conditionId: string; maxTokens: number; thinking: ThinkingPolicy } | null) => {
        const arm = armOf('S1', p.task); if (!armEnabled(md, arm)) return; // C153: disabled arm ⇒ no operation
        const c = contentOfS1(p);
        const probe = cond && conds?.probe && conds.probe.conditionId === cond.conditionId && !probeDone ? 'P1' as const : undefined; if (probe) probeDone = true;
        ops.push({ text: textOf(c), content: c, plan: { schema: H2EVAL_SCHEMA.plan, studyId: i.studyId ?? 'H2EVAL', protocolHash, manifestSha256: sha256File(manifestPath), batchId: 'TBD', phase: 'PILOT', cellId: cond ? `${p.cellId}~${cond.conditionId}` : p.cellId, groupId: p.groupId, promptId: p.promptId, rep: 0, variant: String(p.variant), split: 'NONE', provider, api, endpoint: '', modelRequested: model, task: p.task, sizeBucket: p.size as 'S' | 'L', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: c.promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: cond ? paramsFor('NONE', cond) : baseParams('NONE', arm), ...(cond ? { condition: cond.conditionId } : {}), ...(probe ? { probe } : {}) } });
      };
      if (conds) { for (const cond of conds.list) for (const p of pilotPrompts) if (conds.appliesToArms.includes(armOf('S1', p.task))) emit(p, cond); for (const p of pilotPrompts) if (!conds.appliesToArms.includes(armOf('S1', p.task))) emit(p, null); }
      else for (const p of pilotPrompts) emit(p, null);
    } else {
      if (corpusId === null) throw new CliError(EXIT.PLAN_INVALID, 'S1_CORPUS_ALIAS_MISSING', `${model} has no S1 corpus id and no alias in CORPUS_OPS_ALIAS: declare one (new executor + G15) before planning a campaign`);
      const opsFile = path.join(i.corpusDir, `s1_operations.${corpusId}.jsonl`);
      if (!existsSync(opsFile)) throw new CliError(EXIT.USAGE, 'S1_OPERATIONS_MISSING', opsFile);
      const byId = new Map(prompts.map((p) => [p.promptId, p]));
      // C154 (R5 T3): com `conditions` no desenho, cada operacao S1 dos bracos listados e planejada UMA vez por condicao tambem na campanha
      // (mesma regra da sonda: cellId~conditionId => operationId distinto; a PRIMEIRA operacao da condicao da sonda e a P1). Sem conditions: identico.
      const condsC = md.conditions; let probeDoneC = false;
      const emitC = (o: S1Operation, p: S1Prompt, cond: { conditionId: string; maxTokens: number; thinking: ThinkingPolicy } | null) => {
        const c = contentOfS1(p); const arm = armOf('S1', p.task);
        const probe = cond && condsC?.probe && condsC.probe.conditionId === cond.conditionId && !probeDoneC ? 'P1' as const : undefined; if (probe) probeDoneC = true;
        ops.push({ text: textOf(c), content: c, plan: { schema: H2EVAL_SCHEMA.plan, studyId: i.studyId ?? 'H2EVAL', protocolHash, manifestSha256: sha256File(manifestPath), batchId: 'TBD', phase: o.phase === 'COMPARATIVE_PAIRED' ? 'COMPARATIVE_PAIRED' : 'CONFIRMATORY', cellId: cond ? `${o.cellId}~${cond.conditionId}` : o.cellId, groupId: o.groupId, promptId: o.promptId, rep: o.rep, variant: String(o.variant), split: o.split, provider, api, endpoint: '', modelRequested: model, task: p.task, sizeBucket: p.size as 'S' | 'L', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: c.promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: cond ? paramsFor('NONE', cond) : baseParams('NONE', arm), ...(cond ? { condition: cond.conditionId } : {}), ...(probe ? { probe } : {}) } });
      };
      const s1Ops = readJsonl<S1Operation>(opsFile).map((o) => { const p = byId.get(o.promptId); if (!p) throw new CliError(EXIT.PLAN_INVALID, 'PROMPT_NOT_IN_CORPUS', o.promptId); return { o, p }; }).filter(({ p }) => armEnabled(md, armOf('S1', p.task))).filter(({ o }) => inR6m(o.split, 's1', o.promptId)); // C153: disabled arm ⇒ no operation; C159C G-1: R6-M holdout only
      if (condsC) { for (const cond of condsC.list) for (const { o, p } of s1Ops) if (condsC.appliesToArms.includes(armOf('S1', p.task))) emitC(o, p, cond); for (const { o, p } of s1Ops) if (!condsC.appliesToArms.includes(armOf('S1', p.task))) emitC(o, p, null); }
      else for (const { o, p } of s1Ops) emitC(o, p, null);
    }
    // dialogs (3 calls each): pilot => PILOT dialogs; confirmatory => CONFIRMATORY dialogs
    for (const d of dialogs.filter((x) => (i.phase === 'PILOT' ? x.phase === 'PILOT' : x.phase === 'CONFIRMATORY'))) {
      if (!armEnabled(md, d.arm === 'S2_NOHIT' ? 'T4' : 'T5')) continue; // C153: disabled arm ⇒ no operation
      if (i.phase !== 'PILOT' && !inR6m(d.split, 'dialog', d.dialogId)) continue; // C159C G-1: R6-M holdout only
      for (const k of [1, 2, 3] as const) {
        const c = contentOf(d, k);
        const directives: OperationPlan['params']['cacheDirectives'] = d.arm === 'S3_HITATTEMPT' && provider === 'anthropic' ? { cache_control: 'ephemeral', ttl: '5m' } : 'NONE';
        ops.push({ text: textOf(c), content: c, plan: { schema: H2EVAL_SCHEMA.plan, studyId: i.studyId ?? 'H2EVAL', protocolHash, manifestSha256: sha256File(manifestPath), batchId: 'TBD', phase: i.phase === 'PILOT' ? 'PILOT' : 'CONFIRMATORY', cellId: `cache-${d.arm}`, groupId: d.dialogId, promptId: `${d.dialogId}#${k}`, rep: 0, variant: `call${k}`, split: d.split === 'NONE' ? 'NONE' : d.split, provider, api, endpoint: '', modelRequested: model, task: 'analysis', sizeBucket: 'L', structure: d.arm === 'S2_NOHIT' ? 'S2' : 'S3', modality: 'text', plannedCacheArm: d.arm, promptSha256: c.promptSha256, prefixSha256: d.prefixSha256, nonce: d.arm === 'S2_NOHIT' ? d.nonces[k - 1]! : 'NOT_APPLICABLE', params: baseParams(directives, d.arm === 'S2_NOHIT' ? 'T4' : 'T5') } });
      }
    }
    if (pop) { const h = ops.filter((o) => blockOfPlan(o.plan) === 'holdout'); r6mPopulation[model] = { rule: pop.rule, holdoutUnitsInCorpus: { ...pop.holdoutUnits }, holdoutUnitsPlanned: { s1: new Set(h.filter((o) => o.plan.structure === 'S1').map((o) => o.plan.promptId)).size, dialogs: new Set(h.filter((o) => o.plan.structure !== 'S1').map((o) => o.plan.groupId)).size }, holdoutCallsPlanned: h.length, executesNothing: true }; } // C159C G-1
    // chunk into batches PER BLOCK (never mixing splits in a batch), in the locked order, compute caps
    const providerCap = usdToPico(policy.capsUsd.providers[provider]);
    const blocks: Array<{ block: Block; ops: typeof ops }> = i.phase === 'PILOT' ? [{ block: 'pilot', ops }] : BLOCKS.map((block) => ({ block, ops: ops.filter((o) => blockOfPlan(o.plan) === block) })).filter((x) => x.ops.length > 0);
    for (const { block, ops: blockOps } of blocks) for (let b = 0; b * policy.maxCallsPerBatch < blockOps.length; b += 1) {
      const chunk = blockOps.slice(b * policy.maxCallsPerBatch, (b + 1) * policy.maxCallsPerBatch);
      const batchId = i.phase === 'PILOT' ? `pilot-${model}-b${b + 1}` : `campaign-${block}-${model}-b${b + 1}`;
      const operations: PlannedOperation[] = []; let sum = 0n;
      for (const o of chunk) {
        const plan: OperationPlan = { ...o.plan, batchId };
        const est = counters[enc](o.text);
        const arm = armOf(plan.structure, plan.task); const eff = resolveArmDesign(md, arm); const maxTokens = plan.params.maxTokens;
        const cond = plan.condition ? md.conditions!.list.find((x) => x.conditionId === plan.condition)! : null; const allowance = cond ? cond.reasoningAllowanceTokens : eff.reasoningAllowanceTokens;
        const ib = eff.inputBound ?? { factor: policy.inputBoundFactor, extraTokens: policy.inputBoundExtraTokens }; // VNEXT-2/8: per-(model, arm) bound from the design file when given
        const bound = Math.ceil(est * ib.factor) + ib.extraTokens;
        const pol = cond ? cond.thinking : eff.thinking; byModelArm[`${model}:${arm}${cond ? ':' + cond.conditionId : ''}`] = { maxTokens, policy: pol.policy + ('effort' in pol ? `:${pol.effort}` : ''), reasoningAllowanceTokens: allowance };
        const cap = computeCostCap(isArmModel(model) ? (armPrices ??= loadE3GPriceTable()) : prices, { provider, model, api, inputUpperBoundTokens: bound, maxOutputTokens: maxTokens, reasoningAllowanceTokens: allowance, atUtc: nowUtc });
        if ('error' in cap) throw new CliError(EXIT.PLAN_INVALID, 'PRICE_UNKNOWN', `${model}: ${cap.missing.join(',')}`);
        sum += BigInt(cap.usd);
        const body = bodyOf(plan as never, o.content as never);
        const callIndex = plan.structure === 'S1' ? null : Number(plan.variant.replace(/^call/, ''));
        const d7 = { cacheArm: plan.plannedCacheArm, callIndex, eligibleForHit: plan.plannedCacheArm === 'S3_HITATTEMPT' && callIndex !== null && design.params.d7.eligibleCalls.includes(callIndex) };
        const operationId = operationIdOf(plan); if (plan.probe === 'P1') policy.design.probe = { model, conditionId: plan.condition ?? '', operationId };
        operations.push({ operationId, plan, inputUpperBoundTokens: bound, reasoningAllowanceTokens: allowance, localEstimateTokens: est, costCapUsdPico: cap.usd, costCapBasis: cap.basis, bodySha256: body.bodySha256, d7, condition: plan.condition ?? null, probe: plan.probe ?? null });
      }
      const byFactor = (sum * 3n) / 2n; const byProvider = providerCap / 4n;
      let batchCap = byFactor < byProvider ? byFactor : byProvider; let capNote = '';
      if (i.batchCapUsd !== undefined) { const forced = usdToPico(i.batchCapUsd); if (forced < sum) throw new CliError(EXIT.PLAN_INVALID, 'BATCH_CAP_BELOW_SUM', `${batchId}: --batch-cap-usd ${i.batchCapUsd} < Σ costCap ${sum} pico-USD: the batch could not finish`); if (forced < batchCap) { batchCap = forced; capNote = ` ; lowered by --batch-cap-usd ${i.batchCapUsd}`; } else capNote = ` ; --batch-cap-usd ${i.batchCapUsd} not below the rule (rule kept)`; }
      batches.push({ batchId, provider, model, branchLocked: provider === 'google' && !isArmModel(model), block, order: 0, calls: operations.length, sumCostCapUsdPico: sum.toString(), batchCapUsdPico: batchCap.toString(), batchCapRule: `min(1.5 × Σ costCap = ${byFactor}, 25 % × sub-ledger ${provider} = ${byProvider})${capNote}`, cumulativeWorstCaseUsdPico: '0', requiresPauseAckInGo: false, operations });
      totals[provider].calls += operations.length; totals[provider].batches += 1; totals[provider].sumCostCapUsdPico = (BigInt(totals[provider].sumCostCapUsdPico) + sum).toString();
    }
  }
  // VNEXT-8: R4 expected operations per (model, arm, split) vs what the corpus yields — reported in the plan, never reconciled silently
  for (const b of batches) for (const op of b.operations) { const k = `${b.model}|${armOf(op.plan.structure, op.plan.task)}|${b.block}`; opsCount[k] = (opsCount[k] ?? 0) + 1; }
  for (const [m, arms] of Object.entries(design.params.expectedOpsPerSplit ?? {})) for (const [arm, splits] of Object.entries(arms ?? {})) for (const [split, expected] of Object.entries(splits ?? {})) { if (typeof expected !== 'number') continue; const actual = opsCount[`${m}|${arm}|${split}`] ?? 0; policy.design.opsCheck.push({ model: m, arm: arm as Arm, split, expected, actual, match: actual === expected }); }
  if (disabledArms.length) policy.design.disabledArms = disabledArms; // C153: key present only when an arm is disabled
  // locked global order: all train, then comparative, then validation, then holdout (pilot plans have a single block)
  const rank: Record<Block, number> = { pilot: 0, train: 1, comparative: 2, validation: 3, holdout: 4 };
  batches.sort((a, b) => rank[a.block] - rank[b.block] || a.batchId.localeCompare(b.batchId));
  batches.forEach((b, k) => { b.order = k + 1; });
  // E2: boundaries per model; ECON-02 finding: cumulative worst case per provider in plan order and the first batch whose GO needs pauseAck80pct
  const splitBoundaries: SplitBoundaries = {};
  for (const b of batches) { const m = (splitBoundaries[b.model] ??= { pilot: [], train: [], comparative: [], validation: [], holdout: [] }); m[b.block].push(b.batchId); }
  const cum: Record<Provider, bigint> = { anthropic: 0n, openai: 0n, google: 0n };
  const pauseForecast: PauseForecast[] = [];
  for (const b of batches) { cum[b.provider] += BigInt(b.sumCostCapUsdPico); b.cumulativeWorstCaseUsdPico = cum[b.provider].toString(); b.requiresPauseAckInGo = cum[b.provider] * 100n >= usdToPico(policy.capsUsd.providers[b.provider]) * 80n; }
  for (const p of ['anthropic', 'openai', 'google'] as const) { const cap = usdToPico(policy.capsUsd.providers[p]); const first = batches.find((b) => b.provider === p && b.requiresPauseAckInGo); pauseForecast.push({ provider: p, subLedgerUsd: policy.capsUsd.providers[p], worstCaseCumulativeUsdPico: cum[p].toString(), fractionOfSubLedger: (Number(cap === 0n ? 0n : cum[p] * 10000n / cap) / 10000).toFixed(4), crossesPauseAt80pct: first !== undefined, firstBatchRequiringPauseAck: first?.batchId ?? null }); }
  return { schema: PLAN_SCHEMA, studyId: i.studyId ?? 'H2EVAL', phase: i.phase, protocolHash, orderBySplit: i.phase === 'CONFIRMATORY' ? true : Boolean(i.orderBySplit), splitBoundaries, pauseForecast, notPlanned: ['image (exploratory modality: no corpus, no plan; amendment required)', 'audio (idem)', 'google provider calls (planned and priced; NOT_RUN_BRANCH_LOCKED until its own GO)', ...disabledArms.map((x) => `${x.model} arm ${x.arm}: disabled in design ${design.params.designId} (${design.sha256.slice(0, 16)}) — ${x.reason}`)], maxOutputTokensPolicy: `per model from design ${design.params.designId} (${design.sha256.slice(0, 16)}): ${MATRIX_MODELS.filter((m) => thinkingByModel[m]).map((m) => `${m}=${maxOutputTokensByModel[m]}/${thinkingByModel[m].policy}`).join(', ')}`, preregistration: { file: path.basename(i.preregFile), sha256: preregSha, ratified, ratifiedSha256: ratified ? preregSha : null }, corpus: { dir: i.corpusDir, manifestSha256: sha256File(manifestPath), corpusSha256: manifest.corpusSha256, seed: manifest.seed }, priceTable: { id: prices.id, sha256: prices.sha256 }, ...(i.pilotList ? { pilotAbsoluteBatchCapUsd: PILOT_ABSOLUTE_BATCH_CAP_USD, pilotList: { schema: i.pilotList.schema, fileSha256: i.pilotList.fileSha256, listaSha256: i.pilotList.listaSha256, ...(i.pilotList.perModelListSha256 ? { perModelListSha256: i.pilotList.perModelListSha256 } : {}) } } : {}), ...(Object.keys(r6mPopulation).length ? { r6mPopulation } : {}), policy, batches, totals, generatedUtc: nowUtc };
}

export function writePlan(plan: BatchPlan, outFile: string): void { writeJson(outFile, plan); }
export const readPlan = (p: string): BatchPlan => { const x = readJson<BatchPlan>(p); if (x.schema !== PLAN_SCHEMA) throw new CliError(EXIT.PLAN_INVALID, 'PLAN_SCHEMA', p); return x; };
