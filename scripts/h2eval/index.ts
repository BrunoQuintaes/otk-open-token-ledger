/**
 * H2-EVAL executor — INTEGRATION (B2, BOT-02; INTERFACES.md §9). Wires the three fronts without editing any of them:
 *   core/record (BOT-02)  : createExecutor, journal, ledger, snapshot, cost, egress (OFFLINE only executable; REAL fail-closed)
 *   modal/**   (MET-02)   : ADAPTERS per API (pure), price table h2eval-v1 (tiered), contract R2 helpers, image estimators (EXPERIMENTAL)
 *   cache/**   (E2E-01)   : hash-addressed ContentStore, S2/S3 dialogs (renderCall = pre-registrable reference body), planner
 * Decisions taken here (TERMINAL_B2_INTEGRATION.json):
 *   - binary parts: the pure adapters need `bytesBase64`; the store wrapper `withResolvedBinaries` fetches them by hash right before
 *     buildRequest (never journaled: only hashes reach journal/snapshot/records);
 *   - the modal price table (otk.h2eval.price_table.v1, tiers by prompt length) is adapted to the core PriceTable through
 *     `priceTableFromModal`: null stays null (never 0); the tier is chosen by the prompt-length hint (cap: input upper bound; cost: U);
 *   - modelDeprecation / exploratoryFormulaEstimate come from modal/contract_r2 (requested-model based; served id outside the matrix ⇒ UNKNOWN);
 *   - Google stays NOT_RUN_BRANCH_LOCKED (core default) until its own GO.
 */
import type { UsageApi } from '../../src/types/d1d8/index.js';
import { createExecutor, EXECUTOR_VERSION, DEFAULT_MAX_BATCH_CALLS, type Executor, type ExecutorConfig, type CapPolicy } from './core/runner.js';
import { H2EVAL_ENV_NAMES, validateGoV1 } from './core/egress.js';
import { ADAPTERS as MODAL_ADAPTERS, OFFICIAL_HOSTS } from './modal/index.js';
import { loadPriceTable as loadModalPriceTable, PRICE_TABLE_PATH, REASONING_ALLOWANCE_TOKENS, type PriceTableH2, type PriceKey } from './modal/pricing/pricing.js';
import { modelDeprecationOf, exploratoryFormulaEstimate as modalExploratory } from './modal/contract_r2.js';
import type { MatrixModel } from './modal/types.js';
import { E3G_PRICE_TABLE_PATH, isArmModel, validateArmPriceTable } from './core/e3gArm.js';
import { readFileSync } from 'node:fs';
import { createContentStore as createCacheContentStore, type ContentStore as CacheContentStore } from './cache/contentStore.js';
import type { PriceCategory, PriceEntry, PriceTable } from './record/prices.js';
import type { ContentStore, ExploratoryFormulaEstimate, ModelDeprecation, OperationPlan, ProviderAdapter, ResolvedContent } from './types.js';

export { EXECUTOR_VERSION, DEFAULT_MAX_BATCH_CALLS, createExecutor, H2EVAL_ENV_NAMES, validateGoV1, OFFICIAL_HOSTS, PRICE_TABLE_PATH };
export { operationIdOf } from './core/ids.js';
export { verifyJournalText } from './core/journal.js';
export { readSnapshot } from './record/snapshot.js';
export { contentOf, renderCall, renderDialog, buildDialogs, planArm, classifyCache, resolveArm, costInterval } from './cache/index.js';
export type { Executor, ExecutorConfig, CapPolicy, PriceTable, ContentStore, CacheContentStore };

export const H2EVAL_INTEGRATION_VERSION = 'otk.h2eval.integration.v0';
export const MATRIX_MODELS: readonly MatrixModel[] = Object.freeze(['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.5-flash-lite']);
const isMatrixModel = (m: string): m is MatrixModel => (MATRIX_MODELS as readonly string[]).includes(m);
/** E3G: arm models accept only their own id as served (outside ⇒ EXCL_MODEL_MISMATCH, as for the matrix). They stay OUT of MATRIX_MODELS (deprecation UNKNOWN, no S1 corpus). */
const ARM_MODELS_SERVED: readonly string[] = Object.freeze(['gemini-3.1-flash-lite', 'gpt-6-luna']);

/** Adapters of the matrix (MET-02), keyed by UsageApi, with the R2 `modelDeprecation` hook attached (served id outside the matrix ⇒ UNKNOWN). */
export const ADAPTERS: Readonly<Partial<Record<UsageApi, ProviderAdapter>>> = Object.freeze(Object.fromEntries(
  Object.entries(MODAL_ADAPTERS).map(([api, a]) => [api, Object.freeze({ ...(a as unknown as ProviderAdapter), modelDeprecation: (served: string): ModelDeprecation => (isMatrixModel(served) ? modelDeprecationOf(served).modelDeprecation : 'UNKNOWN') })]),
)) as Partial<Record<UsageApi, ProviderAdapter>>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Price table: modal (tiered by prompt length) → core PriceTable
// ---------------------------------------------------------------------------------------------------------------------------------
const CATEGORY_TO_MODAL: Record<PriceCategory, PriceKey[]> = {
  input: ['input'], output: ['output'], input_cache_read: ['cacheRead'], input_cache_write: ['cacheWrite5m', 'cacheWrite'], input_cache_write_1h: ['cacheWrite1h'],
  output_reasoning: ['reasoning'], input_image: ['imageTokens'], input_audio: ['audioTokens'],
};
/** Tier threshold from the tier id (`prompt_le_100k` / `prompt_gt_100k`); flat tiers (`standard`) have none. REFERENCE_ONLY tiers are never used. */
function tierFor(model: PriceTableH2['models'][string], hint: number | undefined) {
  const usable = model.tiers.filter((t) => !/REFERENCE_ONLY/i.test(t.id));
  if (usable.length === 0) return null;
  const parsed = usable.map((t) => { const m = /^prompt_(le|gt)_(\d+)k$/.exec(t.id); return { t, kind: m ? (m[1] as 'le' | 'gt') : 'flat', k: m ? Number(m[2]) * 1000 : 0 }; });
  const flat = parsed.find((p) => p.kind === 'flat'); if (flat && parsed.length === 1) return flat.t;
  if (hint === undefined || !Number.isFinite(hint)) return parsed.find((p) => p.kind === 'le')?.t ?? parsed[0]!.t; // base tier when nothing is known
  const le = parsed.filter((p) => p.kind === 'le' && hint <= p.k).sort((a, b) => a.k - b.k)[0];
  if (le) return le.t;
  const gt = parsed.filter((p) => p.kind === 'gt' && hint > p.k).sort((a, b) => b.k - a.k)[0];
  return gt?.t ?? null; // above every documented tier: unknown (never guessed)
}

export function priceTableFromModal(loaded: { table: PriceTableH2; sha256: string } = loadModalPriceTable()): PriceTable {
  const t = loaded.table;
  if (t.schema !== 'otk.h2eval.price_table.v1' || t.currency !== 'USD') throw new TypeError('modal price table: unexpected schema/currency');
  const micro = (provider: string, model: string, category: PriceCategory, _atUtc: string, hint?: number): bigint | null => {
    const m = t.models[model]; if (!m || m.provider !== provider) return null;
    const tier = tierFor(m, hint); if (!tier) return null;
    for (const key of CATEGORY_TO_MODAL[category]) { const v = tier.prices[key]; if (typeof v === 'string' && /^\d+$/.test(v) && v !== '0') return BigInt(v); }
    return null; // null or "0" in the table: unknown, never zero
  };
  const entries: PriceEntry[] = [];
  for (const [model, m] of Object.entries(t.models)) for (const tier of m.tiers) for (const [k, v] of Object.entries(tier.prices)) if (typeof v === 'string') entries.push({ provider: m.provider, model, category: `${k}@${tier.id}`, pricePerMTokMicroUsd: v, effectiveFrom: t.capturedUtc.split('..')[0]!, effectiveUntil: null, source: 'modal/pricing/price_table_h2eval_v1.json (R08)' });
  return { id: t.version, sha256: loaded.sha256, capturedUtc: t.capturedUtc, schema: t.schema, currency: t.currency, micro, entries: Object.freeze(entries) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Content: resolve binary bytes by hash right before the pure adapter builds the request
// ---------------------------------------------------------------------------------------------------------------------------------
export function withResolvedBinaries(store: ContentStore): ContentStore {
  return {
    async get(sha) {
      const c = await store.get(sha);
      const messages = await Promise.all(c.messages.map(async (m) => ({ ...m, parts: await Promise.all(m.parts.map(async (p) => {
        if (p.type === 'text' || p.bytesBase64) return p;
        const bytes = await store.getBytes(p.bytesSha256);
        return { ...p, bytesBase64: Buffer.from(bytes).toString('base64') };
      })) })));
      return { ...c, messages } as ResolvedContent;
    },
    getBytes: (sha) => store.getBytes(sha),
  };
}

/** R2 item 7: EXPERIMENTAL image formula (MET-02) for the first image part; never replaces L0. Google ⇒ null (formula declared rough). */
export function exploratoryFormulaFor(plan: OperationPlan, _req: unknown, content: ResolvedContent): ExploratoryFormulaEstimate | null {
  if (plan.modality !== 'image' || !isMatrixModel(plan.modelRequested)) return null;
  const img = content.messages.flatMap((m) => m.parts).find((p): p is Extract<ResolvedContent['messages'][number]['parts'][number], { type: 'image' }> => p.type === 'image');
  if (!img) return null;
  const e = modalExploratory(plan.modelRequested, 'image', { width: img.width, height: img.height });
  if (!e) return null;
  const rawInputs: Record<string, number> = {}; for (const [k, v] of Object.entries(e.rawInputs)) if (typeof v === 'number') rawInputs[k] = v;
  return { tokens: e.tokens, formula: e.formula, rawInputs };
}

/** R10 R2 reasoning allowance per matrix model (MET-02 constant: 0 / 0 / 1 024 / 2 048); non-matrix ⇒ 0 (Gemini API then refuses, fail-closed). E3G arm models: their own constants (pricing.ts). */
export const defaultReasoningAllowance = (plan: OperationPlan): number => Number(isMatrixModel(plan.modelRequested) ? REASONING_ALLOWANCE_TOKENS[plan.modelRequested] : isArmModel(plan.modelRequested) ? REASONING_ALLOWANCE_TOKENS[plan.modelRequested] : 0n);

/**
 * E3G (C160 BRACO-GO): the ATTESTED arm price table (gemini-3.1-flash-lite, gpt-6-luna), validated for provenance (core/e3gArm.ts A1) and adapted to the core PriceTable.
 * `armAttestedModels` is what the runner checks before reserving for an arm model. Never the default table: the Anthropic path keeps price_table_h2eval_v3.json.
 */
export function loadE3GPriceTable(p: string = E3G_PRICE_TABLE_PATH): PriceTable & { armAttestedModels: readonly string[] } {
  const v = validateArmPriceTable(readFileSync(p));
  return Object.freeze({ ...priceTableFromModal({ table: v.table as unknown as PriceTableH2, sha256: v.sha256 }), armAttestedModels: Object.freeze([...v.attestedModels]) });
}

export interface H2EvalExecutorOptions extends Omit<ExecutorConfig, 'adapters' | 'contentStore' | 'prices' | 'capPolicy' | 'exploratoryFormula'> {
  /** Where `content/<sha256>` lives (default: batchDir). Ignored when `contentStore` is given. */
  contentDir?: string;
  contentStore?: ContentStore;
  prices?: PriceTable;
  /** inputUpperBoundTokens is policy from the ratified manifest (never defaulted here); the reasoning allowance defaults to R10 R2 values. */
  capPolicy: { inputUpperBoundTokens: CapPolicy['inputUpperBoundTokens']; reasoningAllowanceTokens?: CapPolicy['reasoningAllowanceTokens']; /** EXEC-ECON item 9 */ thoughtsBoundedByMaxOutput?: CapPolicy['thoughtsBoundedByMaxOutput'] };
  adapters?: Partial<Record<UsageApi, ProviderAdapter>>;
}

export interface H2EvalExecutor extends Executor { contentStore: ContentStore; rawContentStore: ContentStore | CacheContentStore; prices: PriceTable; integrationVersion: string }

export function createH2EvalExecutor(o: H2EvalExecutorOptions): H2EvalExecutor {
  const raw = o.contentStore ?? createCacheContentStore(o.contentDir ?? o.batchDir);
  const contentStore = withResolvedBinaries(raw as ContentStore);
  const prices = o.prices ?? priceTableFromModal();
  const { contentDir: _cd, contentStore: _cs, prices: _p, capPolicy, adapters, ...rest } = o;
  const ex = createExecutor({
    ...rest,
    adapters: adapters ?? ADAPTERS,
    contentStore,
    prices,
    capPolicy: { inputUpperBoundTokens: capPolicy.inputUpperBoundTokens, reasoningAllowanceTokens: capPolicy.reasoningAllowanceTokens ?? defaultReasoningAllowance, ...(capPolicy.thoughtsBoundedByMaxOutput ? { thoughtsBoundedByMaxOutput: capPolicy.thoughtsBoundedByMaxOutput } : {}) },
    exploratoryFormula: exploratoryFormulaFor,
    acceptedModelsServed: o.acceptedModelsServed ?? Object.fromEntries([...MATRIX_MODELS, ...ARM_MODELS_SERVED].map((m) => [m, [m]])),
  });
  return { ...ex, contentStore, rawContentStore: raw, prices, integrationVersion: H2EVAL_INTEGRATION_VERSION };
}
