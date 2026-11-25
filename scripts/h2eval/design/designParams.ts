/**
 * VNEXT-2 (C151 item 2): DESIGN PARAMETERS read from a ratified file instead of constants in plan.ts.
 * `h2eval.design_params.v1` gives, per matrix model: the output ceiling (maxTokens), the reasoning policy (OFF | ADAPTIVE effort |
 * MANUAL budget | MINIMAL level), the reasoning allowance used by the cost cap, and the D7 cache option. The plan records the file's
 * sha256 and folds it into protocolHash, so a different design ⇒ different protocol ⇒ new plans ⇒ new GO.
 * The model × policy combination must be DOCUMENTED (support matrix below, each row citing the archived page); an undocumented
 * combination is refused by `plan` with exit 3 (DESIGN_THINKING_UNDOCUMENTED) — never silently mapped to "the nearest thing".
 * R4_DESIGN_PARAMS.json (ECON-02, runs/B1/R4) is expected in this schema; until it exists, R3_2_DESIGN_PARAMS.json reproduces the
 * R3.2 constants (256 for every task; Haiku 5.5 adaptive effort low; Haiku 4.5 off; GPT-4o mini off; Gemini minimal).
 *
 * Where it sits: `scripts/h2eval/cli/plan.ts` loads the design file with {@link loadDesignParams} and uses
 * {@link armOf}, {@link resolveArmDesign}, {@link armEnabled} and {@link thinkingParamsOf} to build each operation's
 * parameters. Errors are {@link CliError}s carrying the CLI exit code (`EXIT.USAGE` 2, `EXIT.REFUSED_BY_POLICY` 3,
 * `EXIT.PLAN_INVALID` 4). It reads only the design file given (default `R3_2_DESIGN_PARAMS.json` next to this module);
 * no environment variables, no network.
 *
 * @module scripts/h2eval/design/designParams
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MatrixModel } from '../modal/types.js';
import type { ThinkingParams } from '../types.js';
import { CliError, EXIT } from '../cli/common.js';

/** Schema id every design file must declare. */
export const DESIGN_PARAMS_SCHEMA = 'h2eval.design_params.v1';
/** C157 §9.2 (pilots): Sonnet 5.5 and Opus 5.5 are OPTIONAL in a design file (files frozen before them remain valid byte for byte); declaring them is what lets `plan` emit operations for them. */
/** C160 E3G3 (B2 of PROTO-GO): the arm models gemini-3.1-flash-lite and gpt-6-luna are OPTIONAL design models too: older design files stay valid byte for byte; when declared they are VALIDATED like any other model (support rows in thinkingSupport). */
export type OptionalDesignModel = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'gemini-3.1-flash-lite' | 'gpt-6-luna';
/** Models a design file may omit (see {@link OptionalDesignModel}). */
export const OPTIONAL_DESIGN_MODELS: readonly OptionalDesignModel[] = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.1-flash-lite', 'gpt-6-luna']);
/** Every model a design file can declare; the ones not in {@link OPTIONAL_DESIGN_MODELS} are required. */
export const DESIGN_MODELS: readonly MatrixModel[] = Object.freeze(['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gpt-6-luna']);
/** Absolute path of the default design file, `R3_2_DESIGN_PARAMS.json` in this module's folder. */
export const DEFAULT_DESIGN_PARAMS_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'R3_2_DESIGN_PARAMS.json');

/**
 * Reasoning ("thinking") policy of a model or arm: off, adaptive with an effort level, a manual budget in tokens
 * (integer >= 1024 and below `maxTokens`), or a minimal thinking level.
 */
export type ThinkingPolicy =
  | { policy: 'OFF' }
  | { policy: 'ADAPTIVE'; effort: 'low' | 'medium' | 'high' }
  | { policy: 'MANUAL'; budgetTokens: number }
  | { policy: 'MINIMAL'; thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' };
/** `inputBound` (optional): worst-case input = ceil(factor x local estimate) + extraTokens for the cost cap. R17 observed U/L0 1.45-1.58 on Haiku 5.5 with the
 * cl100k estimate: the R3.2 default 1.25/64 is covered on Anthropic only because the cap prices the input at the cache-WRITE price; on a
 * provider without that slack (OpenAI) a 1.5x tokenizer ratio can violate the cap (STOP_CAP_VIOLATION). The design file is where this is fixed. */
/** VNEXT-F (R17-V-7): CONDITIONS — the same prompt is planned once per condition (distinct cellId ⇒ distinct operationId), in list order (block B1, B2, …); `probe` marks the FIRST operation of that condition as the P1 probe (R17-V-8). */
export interface DesignCondition { conditionId: string; maxTokens: number; thinking: ThinkingPolicy; reasoningAllowanceTokens: number }
/** The conditions of one model: which arms they apply to, the ordered list and the optional first-operation probe. */
export interface DesignConditions { appliesToArms: Arm[]; list: DesignCondition[]; probe?: { conditionId: string; rule: 'P1' } }
/** C153 (P4 option C): per-arm switch. `enabled: false` ⇒ `plan` emits NO operation of this arm for this model (S1 via armOf(structure, task); T4/T5 dialogues likewise) and records the exclusion in notPlanned / policy.design.disabledArms; default true. `reason` is free text copied into that record. Designs without the field produce byte-identical plans. */
export interface ArmSwitch { enabled?: boolean; reason?: string }
/**
 * Design of one model: output ceiling `maxTokens` (tokens, 1..128000), thinking policy, `reasoningAllowanceTokens`
 * (tokens reserved for reasoning by the cost cap, 0..128000; must be 0 when the policy is OFF), optional input bound,
 * optional per-arm overrides and switches, and optional conditions.
 */
export interface ModelDesign { maxTokens: number; thinking: ThinkingPolicy; reasoningAllowanceTokens: number; inputBound?: { factor: number; extraTokens: number }; /** VNEXT-8: per-ARM overrides (R4: T1 summary, T2 code, T3 analysis, T4 S2 dialogue, T5 S3 dialogue) */ arms?: Partial<Record<Arm, Partial<Pick<ModelDesign, 'maxTokens' | 'thinking' | 'reasoningAllowanceTokens' | 'inputBound'>> & ArmSwitch>>; conditions?: DesignConditions }
/** R4 arms mapped to corpus cells (R4_DESIGN_PARAMS.json armToCorpusCell): T1 = S1 summary (S and L); T2 = S1 code_gen|code_fix; T3 = S1 analysis; T4 = S2 dialogue (no cache); T5 = S3 dialogue (cache, D7 option A). */
export type Arm = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
/** All arms in order. */
export const ARMS: readonly Arm[] = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5']);
/**
 * Maps an operation's structure and task to its arm.
 *
 * @param structure - `S1`, `S2` or `S3`.
 * @param task - S1 task kind (ignored for S2/S3).
 * @returns The arm (T1 summary, T2 code, T3 analysis, T4 S2 dialog, T5 S3 dialog).
 * @throws {CliError} `DESIGN_ARM_UNKNOWN` (exit `PLAN_INVALID`) when no arm matches.
 */
export function armOf(structure: string, task: string): Arm {
  if (structure === 'S2') return 'T4'; if (structure === 'S3') return 'T5';
  if (task === 'summary') return 'T1'; if (task === 'code_gen' || task === 'code_fix') return 'T2'; if (task === 'analysis') return 'T3';
  throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_ARM_UNKNOWN', `no arm for structure ${structure} / task ${task}`);
}
/**
 * Effective design of one operation: the model's defaults overridden by its arm.
 *
 * @param md - The model's design (not mutated).
 * @param arm - The operation's arm.
 * @returns `maxTokens`, `thinking`, `reasoningAllowanceTokens` and `inputBound`, each from the arm when set there.
 */
export function resolveArmDesign(md: ModelDesign, arm: Arm): Required<Pick<ModelDesign, 'maxTokens' | 'thinking' | 'reasoningAllowanceTokens'>> & { inputBound?: ModelDesign['inputBound'] } {
  const o = md.arms?.[arm] ?? {};
  return { maxTokens: o.maxTokens ?? md.maxTokens, thinking: o.thinking ?? md.thinking, reasoningAllowanceTokens: o.reasoningAllowanceTokens ?? md.reasoningAllowanceTokens, inputBound: o.inputBound ?? md.inputBound };
}
/** C153: an arm is planned unless the design says `arms.<arm>.enabled: false`. */
/**
 * Tells whether an arm is planned for a model.
 *
 * @param md - The model's design.
 * @param arm - Arm to check.
 * @returns `false` only when the arm is explicitly disabled.
 */
export function armEnabled(md: ModelDesign, arm: Arm): boolean { return md.arms?.[arm]?.enabled !== false; }
/** Content of a validated design file (`h2eval.design_params.v1`); `d7` fixes the cache option and eligible call positions. */
export interface DesignParams { schema: typeof DESIGN_PARAMS_SCHEMA; designId: string; source: string; perModel: Record<Exclude<MatrixModel, OptionalDesignModel>, ModelDesign> & Partial<Record<OptionalDesignModel, ModelDesign>>; d7: { option: 'A'; eligibleCalls: number[] }; /** VNEXT-8 (R4 stops): integrity rules the executor enforces per response */ integrity?: { stopReasonRequired?: boolean; thinkingDisabledRejectedStops?: boolean }; /** VNEXT-8: expected operations per arm and split (R4 opsPerSplit), reported by `plan` against the corpus-derived counts (never silently reconciled) */ expectedOpsPerSplit?: Partial<Record<MatrixModel, Partial<Record<Arm, Partial<Record<'train' | 'comparative' | 'validation' | 'holdout', number>>>>>>; notes?: string[] }
/** A loaded design: validated params, SHA-256 of the file bytes (folded into the protocol hash) and the file path. */
export interface LoadedDesign { params: DesignParams; sha256: string; file: string }

/** Documented support of each model × policy (the plan refuses anything not listed). Citations: R08 archive or runs/R17_REAL/H2_DIAG/docs. */
export type SupportRow = { ok: true; basis: string; doc: string } | { ok: false; reason: string; doc: string };
/**
 * Looks up whether a model × thinking policy combination is documented.
 *
 * @param model - Design model.
 * @param t - Requested policy.
 * @returns A row with `ok: true` and the documented basis, or `ok: false` with the reason; both cite the archived page.
 */
export function thinkingSupport(model: MatrixModel, t: ThinkingPolicy): SupportRow {
  switch (model) {
    case 'gpt-4o-mini-2024-07-18':
      return t.policy === 'OFF' ? { ok: true, basis: 'not a reasoning model; no reasoning parameter is sent', doc: 'R08 openai/gpt-4o-mini.html sha256 53bb89b832c4827b6b9a9d344c107ffbc16a04cd1c50a68c981ca6ea7da81a45' } : { ok: false, reason: `gpt-4o-mini has no documented reasoning control (${t.policy})`, doc: 'R08 openai/gpt-4o-mini.html' };
    case 'claude-haiku-4-5-20251001':
      if (t.policy === 'OFF') return { ok: true, basis: 'extended thinking is manual-only: omitting `thinking` disables it', doc: 'R08 anthropic/extended-thinking.html sha256 9f8002582c6cfb59068cc3c707b7bdcc29e306671761a664d240f770f1b4eee7 (l. 66, 94)' };
      if (t.policy === 'MANUAL') return { ok: true, basis: 'thinking: {type: enabled, budget_tokens >= 1024, < max_tokens}', doc: 'R08 anthropic/extended-thinking.html (l. 94-101)' };
      return { ok: false, reason: `Haiku 4.5 supports only manual extended thinking (requested ${t.policy})`, doc: 'R08 anthropic/extended-thinking.html (per-model: extended-thinking-only models)' };
    case 'claude-haiku-5-5':
      if (t.policy === 'OFF') return { ok: true, basis: 'thinking: {type: "disabled"} accepted at effort high or below (effort omitted = medium); 400 only at xhigh/max', doc: 'runs/R17_REAL/H2_DIAG/docs/effort.html sha256 b069c61b0e62d304c288e588d8b387fe7a336e9f47d1d3f3f2cfdfcb049b35c9 (effort.txt l. 448-460); docs/thinking.html sha256 09378fd55ef10a2f60a7d481c91010d6081c655d8b7bebc15f6a15e80500cd34 (thinking.txt l. 617-620)' };
      if (t.policy === 'ADAPTIVE') return { ok: true, basis: 'adaptive thinking on by default; output_config.effort low|medium|high steers depth (xhigh/max excluded by design: they forbid disabled and maximise thinking)', doc: 'R08 anthropic/haiku-5-5.html sha256 017889df8c09e31a802bd6846eb687d8e7c575a4cbba68a8d11023cf59a518a7 (l. 114); docs/effort.html (l. 428-446)' };
      return { ok: false, reason: `Haiku 5.5 rejects budget_tokens with HTTP 400 and has no MINIMAL level (requested ${t.policy})`, doc: 'R08 anthropic/extended-thinking.html (l. 63, 148)' };
    case 'claude-sonnet-5-5':
    case 'claude-opus-5-5':
      // C157 §9.2 piloto: `thinking: disabled` nao e documentado nas paginas capturadas para o Sonnet 5.5 (a leitura da coordenacao diz nao suportado; so leitura) e o Opus 5.5 tem pensamento adaptativo sempre ligado: nunca se envia `disabled`.
      if (t.policy === 'ADAPTIVE') return { ok: true, basis: `adaptive thinking is always on; output_config.effort ${t.effort} steers depth; thinking disabled is never sent to ${model} (not documented in the captured pages)`, doc: 'runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7' };
      return { ok: false, reason: `${model} cannot disable thinking and has no manual budget in this executor (requested ${t.policy})`, doc: 'runs/NOITE_20261112/N5_CICLO3/CAPTURA_PUBLICA/anthropic_models_overview_20261112.html sha256 97c0e56b09fe81f0b57b372f86704f0f8eb5e248a66f1024e9c7b587616f08b7' };
    case 'gemini-3.5-flash-lite':
      return t.policy === 'MINIMAL' ? { ok: true, basis: 'thinkingConfig.thinkingLevel MINIMAL|LOW|MEDIUM|HIGH; default On (minimal); no OFF', doc: 'R08 google/thinking.html sha256 db73d9499c8f1e09290ad815021abff0f15dbdf190cdae2b71445797a8c57200' } : { ok: false, reason: `Gemini 3.5 Flash-Lite has no documented OFF / adaptive effort / manual budget (requested ${t.policy})`, doc: 'R08 google/thinking.html' };
    // C160 E3G3 (B2): arm models. Only the policy the E3G contract fixes (contract_r2 defaultThinkingFor) is accepted; anything else is refused, never mapped.
    case 'gemini-3.1-flash-lite':
      return t.policy === 'MINIMAL' && t.thinkingLevel === 'minimal' ? { ok: true, basis: 'E3G: thinkingConfig.thinkingLevel=MINIMAL, as contract_r2 defaultThinkingFor (the level table has no row for 3.x flash-lite: NOT_VERIFIED); other levels are not accepted', doc: 'R08 google/thinking.html sha256 db73d9499c8f1e09290ad815021abff0f15dbdf190cdae2b71445797a8c57200; scripts/h2eval/modal/contract_r2.ts' } : { ok: false, reason: `gemini-3.1-flash-lite: the E3G arm accepts only MINIMAL/minimal (requested ${t.policy}${t.policy === 'MINIMAL' ? '/' + t.thinkingLevel : ''})`, doc: 'scripts/h2eval/modal/contract_r2.ts (defaultThinkingFor)' };
    case 'gpt-6-luna':
      return t.policy === 'OFF' ? { ok: true, basis: 'E3G: no reasoning parameter is sent (default effort); reasoning_tokens billed as output (DR-208)', doc: 'scripts/h2eval/modal/contract_r2.ts (defaultThinkingFor); DR-208 literal 6ee16eeb159aa2d3960f5b15638a18034c3882872aa557d694fe6d175eddfe33' } : { ok: false, reason: `gpt-6-luna: the E3G arm sends no reasoning parameter; only OFF is accepted (requested ${t.policy})`, doc: 'scripts/h2eval/modal/contract_r2.ts (defaultThinkingFor)' };
    default:
      return { ok: false, reason: `${String(model)}: no support row (unknown design model)`, doc: 'scripts/h2eval/design/designParams.ts' };
  }
}

/**
 * Plan-level `params.thinking` (contract rev. 2 item 4) derived from the policy.
 *
 * @param t - Thinking policy.
 * @returns `{mode: 'none'}`, `'adaptive'` with effort, `'manual'` with budget, or `'minimal'` with level.
 */
export function thinkingParamsOf(t: ThinkingPolicy): ThinkingParams {
  if (t.policy === 'OFF') return { mode: 'none' };
  if (t.policy === 'ADAPTIVE') return { mode: 'adaptive', effort: t.effort };
  if (t.policy === 'MANUAL') return { mode: 'manual', budgetTokens: t.budgetTokens };
  return { mode: 'minimal', thinkingLevel: t.thinkingLevel };
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
function validatePolicy(model: MatrixModel, d: ModelDesign): void {
  const t = d.thinking as ThinkingPolicy | undefined;
  if (!t || typeof t !== 'object') throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: thinking policy missing`);
  if (t.policy === 'ADAPTIVE' && !['low', 'medium', 'high'].includes(t.effort)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: ADAPTIVE effort must be low|medium|high`);
  if (t.policy === 'MANUAL' && (!isInt(t.budgetTokens, 1024, 128_000) || t.budgetTokens >= d.maxTokens)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: MANUAL budgetTokens must be an integer >= 1024 and < maxTokens`);
  if (t.policy === 'MINIMAL' && !['minimal', 'low', 'medium', 'high'].includes(t.thinkingLevel)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: MINIMAL thinkingLevel invalid`);
  if (!['OFF', 'ADAPTIVE', 'MANUAL', 'MINIMAL'].includes(t.policy)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: unknown policy`);
  const s = thinkingSupport(model, t);
  if (!s.ok) throw new CliError(EXIT.REFUSED_BY_POLICY, 'DESIGN_THINKING_UNDOCUMENTED', `${model} × ${t.policy}: ${s.reason} (see ${s.doc})`);
  if (t.policy === 'OFF' && d.reasoningAllowanceTokens !== 0) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: OFF requires reasoningAllowanceTokens 0 (nothing to reserve for reasoning)`);
  if (t.policy !== 'OFF' && model !== 'gpt-4o-mini-2024-07-18' && d.reasoningAllowanceTokens <= 0) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${model}: a reasoning policy needs reasoningAllowanceTokens > 0 for the cap`);
}

/**
 * Checks a parsed design file against the schema, the value ranges and the documented support matrix.
 *
 * @param p - Parsed JSON (not mutated).
 * @returns The same object, typed as {@link DesignParams}.
 * @throws {CliError} `DESIGN_PARAMS_SCHEMA` or `DESIGN_PARAMS_INVALID` (exit `PLAN_INVALID`) for a wrong schema, a missing
 *   required model, an out-of-range value, bad conditions, arms or `d7`; `DESIGN_THINKING_UNDOCUMENTED` (exit
 *   `REFUSED_BY_POLICY`) for an undocumented model × policy combination.
 */
export function validateDesignParams(p: unknown): DesignParams {
  const d = p as DesignParams;
  if (!d || typeof d !== 'object' || d.schema !== DESIGN_PARAMS_SCHEMA) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_SCHEMA', `expected ${DESIGN_PARAMS_SCHEMA}`);
  if (typeof d.designId !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(d.designId)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'designId');
  if (typeof d.source !== 'string' || d.source.length < 3) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'source');
  if (!d.perModel || typeof d.perModel !== 'object') throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'perModel');
  for (const m of DESIGN_MODELS) {
    const md = d.perModel[m]; if (!md && (OPTIONAL_DESIGN_MODELS as readonly string[]).includes(m)) continue; // pilot models: design files that predate them stay valid; a plan for them is refused (DESIGN_MODEL_NOT_DECLARED)
    if (!md) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `perModel.${m} missing (every matrix model must be declared, even if NOT_RUN)`);
    if (!isInt(md.maxTokens, 1, 128_000)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: maxTokens must be an integer in 1..128000`);
    if (!isInt(md.reasoningAllowanceTokens, 0, 128_000)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: reasoningAllowanceTokens`);
    if (md.inputBound !== undefined && (typeof md.inputBound.factor !== 'number' || !(md.inputBound.factor >= 1 && md.inputBound.factor <= 4) || !isInt(md.inputBound.extraTokens, 0, 10_000))) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: inputBound.factor must be in [1, 4] and extraTokens an integer in 0..10000`);
    validatePolicy(m, md);
    if (md.conditions !== undefined) {
      const c = md.conditions; if (!Array.isArray(c.appliesToArms) || !c.appliesToArms.length || c.appliesToArms.some((a) => !ARMS.includes(a)) || !Array.isArray(c.list) || !c.list.length) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: conditions.appliesToArms/list`);
      const ids = c.list.map((x) => x.conditionId); if (ids.some((x) => typeof x !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{1,23}$/.test(x)) || new Set(ids).size !== ids.length) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: conditionId must be unique [A-Z0-9_-]{2,24}`);
      for (const x of c.list) { if (!isInt(x.maxTokens, 1, 128_000) || !isInt(x.reasoningAllowanceTokens, 0, 128_000)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${x.conditionId}: maxTokens/allowance`); validatePolicy(m, { maxTokens: x.maxTokens, thinking: x.thinking, reasoningAllowanceTokens: x.reasoningAllowanceTokens }); }
      if (c.probe !== undefined && (c.probe.rule !== 'P1' || !ids.includes(c.probe.conditionId))) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: conditions.probe must be {conditionId in list, rule: P1}`);
    }
    for (const [arm, o] of Object.entries(md.arms ?? {})) {
      if (!ARMS.includes(arm as Arm) || !o) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}: arm ${arm}`);
      // C153: optional switch; a disabled arm cannot carry conditions and must expect 0 operations per split (so opsCheck matches by construction, never by reconciliation)
      if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${arm}: enabled must be a boolean`);
      if (o.reason !== undefined && (typeof o.reason !== 'string' || o.reason.length < 1 || o.reason.length > 200)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${arm}: reason must be a string of 1..200 chars`);
      if (o.enabled === false) {
        if (md.conditions?.appliesToArms.includes(arm as Arm)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${arm}: a disabled arm cannot carry conditions`);
        const exp = (d.expectedOpsPerSplit as Record<string, Record<string, Record<string, unknown>> | undefined> | undefined)?.[m]?.[arm];
        if (exp && Object.values(exp).some((v) => typeof v === 'number' && v !== 0)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${arm}: a disabled arm must expect 0 operations per split`);
      }
      const eff = resolveArmDesign(md, arm as Arm);
      if (!isInt(eff.maxTokens, 1, 128_000) || !isInt(eff.reasoningAllowanceTokens, 0, 128_000)) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', `${m}.${arm}: maxTokens/allowance`);
      validatePolicy(m, { maxTokens: eff.maxTokens, thinking: eff.thinking, reasoningAllowanceTokens: eff.reasoningAllowanceTokens });
    }
  }
  if (d.integrity !== undefined && (typeof d.integrity !== 'object' || Object.values(d.integrity).some((v) => typeof v !== 'boolean'))) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'integrity flags must be booleans');
  if (!d.d7 || d.d7.option !== 'A' || !Array.isArray(d.d7.eligibleCalls) || !d.d7.eligibleCalls.every((k) => isInt(k, 2, 3))) throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'd7 must be { option: "A", eligibleCalls: [2, 3] } (D7 option A: calls after the creation call are the eligible positions)');
  return d;
}

/**
 * Reads, parses and validates a design file.
 *
 * @param file - Path of the design file (default {@link DEFAULT_DESIGN_PARAMS_FILE}).
 * @returns The validated params, the SHA-256 of the file bytes and the path.
 * @throws {CliError} `DESIGN_PARAMS_MISSING` (exit `USAGE`) when the file does not exist; `DESIGN_PARAMS_INVALID` when
 *   it is not JSON; any error of {@link validateDesignParams}.
 */
export function loadDesignParams(file: string = DEFAULT_DESIGN_PARAMS_FILE): LoadedDesign {
  if (!existsSync(file)) throw new CliError(EXIT.USAGE, 'DESIGN_PARAMS_MISSING', file);
  const buf = readFileSync(file);
  let parsed: unknown; try { parsed = JSON.parse(buf.toString('utf8')); } catch { throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_INVALID', 'not JSON'); }
  return { params: validateDesignParams(parsed), sha256: createHash('sha256').update(buf).digest('hex'), file };
}

/**
 * VNEXT-8: converter from the ECON-02 proposal file `h2eval.r4_design_params.v0` (runs/B1/R4/R4_DESIGN_PARAMS.json) to this schema.
 * Only the STRUCTURED fields are read: `models.<m>.maxTokensDeclared.<arm>`, `models.<m>.reasoningAllowanceInPlan`, `opsPerSplit`.
 * The Haiku 5.5 reasoning policy per arm is written in prose in v0 ("T1/T2/T4/T5 = OFF …; T3 = ON adaptativo effort low, allowance 1024"):
 * it is NOT parsed; the caller passes it explicitly (`haiku55ArmThinking`) and the output records that transcription in `source`, so a
 * reviewer can check it against the v0 text. The result is a CANDIDATE: it is valid only after the R4 pre-registration is ratified and
 * ECON-02 confirms the transcription (the v0 sha256 is recorded in `source`).
 */
export interface R4DesignV0 { schema: 'h2eval.r4_design_params.v0'; label: string; models: Record<string, { provider: string; maxTokensDeclared?: Partial<Record<Arm, number>>; reasoningAllowanceInPlan?: number; opsPerSplit?: Record<string, Record<string, number | Record<string, number>>> }> }
/**
 * Converts the v0 proposal file into a candidate design (see the comment on {@link R4DesignV0}).
 *
 * @param v0 - Parsed v0 file (not mutated).
 * @param o - `v0Sha256`: SHA-256 of the v0 file, recorded in `source`; `haiku55ArmThinking`: the per-arm Haiku 5.5
 *   policy transcribed by hand; `inputBound`: optional input bound applied to the four base models.
 * @returns A validated candidate design with `designId` `R4-candidate-from-v0`.
 * @throws {CliError} `DESIGN_PARAMS_SCHEMA` when `v0.schema` is wrong; any error of {@link validateDesignParams}.
 */
export function convertR4DesignV0(v0: R4DesignV0, o: { v0Sha256: string; haiku55ArmThinking: Record<Arm, { thinking: ThinkingPolicy; reasoningAllowanceTokens: number }>; inputBound?: { factor: number; extraTokens: number } }): DesignParams {
  if (v0.schema !== 'h2eval.r4_design_params.v0') throw new CliError(EXIT.PLAN_INVALID, 'DESIGN_PARAMS_SCHEMA', 'expected h2eval.r4_design_params.v0');
  const armsMax = (m: string): Partial<Record<Arm, { maxTokens: number }>> => Object.fromEntries(Object.entries(v0.models[m]?.maxTokensDeclared ?? {}).map(([a, t]) => [a, { maxTokens: t as number }]));
  const ib = o.inputBound ? { inputBound: o.inputBound } : {};
  const h55arms: NonNullable<ModelDesign['arms']> = Object.fromEntries(ARMS.map((a) => [a, { ...(armsMax('claude-haiku-5-5')[a] ?? {}), thinking: o.haiku55ArmThinking[a].thinking, reasoningAllowanceTokens: o.haiku55ArmThinking[a].reasoningAllowanceTokens }]));
  const perModel: DesignParams['perModel'] = {
    'claude-haiku-5-5': { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, ...ib, arms: h55arms },
    'claude-haiku-4-5-20251001': { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, ...ib, arms: armsMax('claude-haiku-4-5-20251001') },
    'gpt-4o-mini-2024-07-18': { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, ...ib, arms: armsMax('gpt-4o-mini-2024-07-18') },
    'gemini-3.5-flash-lite': { maxTokens: 256, thinking: { policy: 'MINIMAL', thinkingLevel: 'minimal' }, reasoningAllowanceTokens: v0.models['gemini-3.5-flash-lite']?.reasoningAllowanceInPlan ?? 2048, ...ib },
  };
  const expected: DesignParams['expectedOpsPerSplit'] = {};
  for (const m of DESIGN_MODELS) { const ops = v0.models[m]?.opsPerSplit; if (!ops) continue; const byArm: NonNullable<DesignParams['expectedOpsPerSplit']>[MatrixModel] = {}; for (const [arm, splits] of Object.entries(ops)) { const row: Partial<Record<'train' | 'comparative' | 'validation' | 'holdout', number>> = {}; for (const k of ['train', 'comparative', 'validation', 'holdout'] as const) if (typeof splits[k] === 'number') row[k] = splits[k] as number; byArm[arm as Arm] = row; } expected[m] = byArm; }
  return validateDesignParams({ schema: DESIGN_PARAMS_SCHEMA, designId: 'R4-candidate-from-v0', source: `CANDIDATE converted from runs/B1/R4/R4_DESIGN_PARAMS.json (h2eval.r4_design_params.v0, sha256 ${o.v0Sha256}; label: ${v0.label}). Structured fields read: maxTokensDeclared per arm, reasoningAllowanceInPlan (Gemini), opsPerSplit. Haiku 5.5 per-arm thinking TRANSCRIBED from the v0 prose (reasoningPolicy.primary) by the converter's caller: ${ARMS.map((a) => `${a}=${o.haiku55ArmThinking[a].thinking.policy}`).join(' ')}. NOT RATIFIED: valid only after R4 ratification and ECON-02 confirmation.`, perModel, d7: { option: 'A', eligibleCalls: [2, 3] }, integrity: { stopReasonRequired: true, thinkingDisabledRejectedStops: true }, expectedOpsPerSplit: expected, notes: ['R4 v0 executorRequirements.protocolHash says sha256(preregSha:corpusSha256:phase); v-next uses sha256(preregSha:corpusSha256:phase:designSha256) — the design file is part of the protocol identity.'] });
}

/** Transcription of the Haiku 5.5 per-arm reasoning policy from the v0 prose (`models.claude-haiku-5-5.reasoningPolicy.primary`:
 * "T1/T2/T4/T5 = OFF thinking {type: disabled} …; T3 = ON adaptativo effort low, allowance 1024"). To be confirmed by ECON-02 / the author. */
export const R4_V0_HAIKU55_ARM_THINKING: Record<Arm, { thinking: ThinkingPolicy; reasoningAllowanceTokens: number }> = Object.freeze({
  T1: { thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 }, T2: { thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 },
  T3: { thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1024 },
  T4: { thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 }, T5: { thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 },
});
/** Vendored copy of the ECON-02 v0 file and the candidate produced from it (both committed; the test keeps them in sync). */
export const R4_V0_VENDORED_FILE = path.resolve(path.dirname(DEFAULT_DESIGN_PARAMS_FILE), 'R4_DESIGN_PARAMS.v0.econ02.json');
/** Path of the committed candidate design converted from {@link R4_V0_VENDORED_FILE}. */
export const R4_CANDIDATE_FILE = path.resolve(path.dirname(DEFAULT_DESIGN_PARAMS_FILE), 'R4_DESIGN_PARAMS.candidate.json');
/** R17 lesson (vnext_e2e): U/L0 1.45-1.58 ⇒ the input bound of the cap must cover a 1.6x tokenizer ratio on every provider. */
export const R4_INPUT_BOUND = Object.freeze({ factor: 1.6, extraTokens: 64 });
