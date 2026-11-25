/**
 * H2-EVAL / R13 — manifesto do corpus novo (`otk.h2eval_corpus.v1`): hash de cada prompt, de cada diálogo e do corpus inteiro,
 * gravado ANTES de qualquer chamada (R09 §1). A semente é parâmetro (escolha do Bruno, D-3). Função pura: o que vem de fora
 * (contadores de tokens, hash do código) entra por parâmetro, para o `corpusSha256` depender só do conteúdo.
 *
 * In English: builds the whole corpus (S1 prompts via `s1Corpus.ts`, dialogs via `cache/dialogs.ts`) and its manifest:
 * a hash per prompt and per dialog and one `corpusSha256` for the corpus, recorded before any provider call. Pure
 * function: token counters, generator file hashes, the seed scan and the collision report come in as parameters and
 * appear in the manifest, but `corpusSha256` depends only on the version, seed, parameters, content and designs.
 * Called by `corpus/build.ts` and by tests.
 *
 * @module scripts/h2eval/corpus/manifest
 */
import { auditNonceTokens, buildDialogs, contentOf, type Dialog, type DialogOptions } from '../cache/dialogs.js';
import { contentOfS1 } from '../cache/contentStore.js';
import { DEFAULT_DESIGNS, s1PlanFor, summarizeDesign, type Design, type ModelId } from './s1Plan.js';
import type { CollisionReport } from './collision.js';
import type { SeedVerification } from './seedVerify.js';
import { buildS1, S1_CORPUS_VERSION, type S1Options, type S1Prompt } from './s1Corpus.js';
import { canonicalJson, sha256Hex } from './util.js';
import { CELL_IDS } from './s1Corpus.js';
import type { SplitCounts } from './split.js';
import type { Arm } from '../cache/dialogs.js';

/** C154 (R5): composicao explicita do corpus. Presente => entra em params (logo no corpusSha256); ausente => params e bytes identicos aos de antes. */
export interface SplitPlan { cells?: Readonly<Record<string, SplitCounts>>; dialogs?: Readonly<Partial<Record<Arm, SplitCounts>>>; pilotGroupsPerCell?: number }
/** C154: um split plan e aceito so com celulas conhecidas, bracos de dialogo conhecidos e contagens inteiras >= 0. */
/**
 * Validates an explicit split plan (how many groups or dialogs go to train, validation and holdout).
 *
 * @param sp - The plan to check (not mutated).
 * @throws {RangeError} When a cell id is not in `CELL_IDS`, a dialog arm is not `S2_NOHIT`/`S3_HITATTEMPT`, a
 *   `train`/`validation`/`holdout` count is not an integer >= 0, or `pilotGroupsPerCell` is not an integer >= 1.
 */
export function validateSplitPlan(sp: SplitPlan): void {
  const okCounts = (c: unknown, where: string) => { const x = c as Record<string, unknown>; for (const k of ['train', 'validation', 'holdout']) if (!x || !Number.isInteger(x[k]) || (x[k] as number) < 0) throw new RangeError(`split plan: ${where}.${k} tem de ser inteiro >= 0`); };
  if (sp.cells) for (const [cell, c] of Object.entries(sp.cells)) { if (!CELL_IDS.includes(cell)) throw new RangeError(`split plan: celula desconhecida ${cell}`); okCounts(c, cell); }
  if (sp.dialogs) for (const [arm, c] of Object.entries(sp.dialogs)) { if (arm !== 'S2_NOHIT' && arm !== 'S3_HITATTEMPT') throw new RangeError(`split plan: braco desconhecido ${arm}`); okCounts(c, arm); }
  if (sp.pilotGroupsPerCell !== undefined && (!Number.isInteger(sp.pilotGroupsPerCell) || sp.pilotGroupsPerCell < 1)) throw new RangeError('split plan: pilotGroupsPerCell');
}

/** Local token counter for one tokenizer encoding: text in, token count out (an estimate, not the provider's count). */
export type Counter = (text: string) => number;
/** Optional local counters by encoding name; a missing counter makes the manifest record `'UNKNOWN'`, never zero. */
export interface Counters { o200k_base?: Counter; cl100k_base?: Counter }

/** Result of `buildCorpus`: the generated content, its JSONL serialisations and the manifest. */
export interface CorpusBuild {
  s1: ReturnType<typeof buildS1>; dialogs: Dialog[];
  s1Jsonl: string; dialogsJsonl: string; manifest: Record<string, unknown>;
}

/** Parameters of the corpus; every value that changes content also enters `params` and therefore `corpusSha256`. */
export interface BuildOptions extends Pick<S1Options, 'groupsPerCell' | 'variantsPerGroup' | 'repeatsPerCell' | 'pilotCells'>, Pick<DialogOptions, 's2Dialogs' | 's3Dialogs' | 'pilotS2' | 'pilotS3' | 'prefixChars'> {
  seed: number; extraForbiddenSeeds?: readonly number[]; /** C154 (R5) */ splitPlan?: SplitPlan;
  /** desenho do S1 por modelo (padrão: Haiku 4.5 na opção B recomendada pelo R07 R2; os demais completos) */
  designs?: Partial<Record<ModelId, Design>>;
}

const est = (c: Counter | undefined, t: string): number | 'UNKNOWN' => (c ? c(t) : 'UNKNOWN');

/**
 * Generates the S1 prompts and the dialogs for a seed and builds the corpus manifest.
 *
 * @param o - Corpus parameters (seed, sizes, optional split plan and designs).
 * @param ctx - Outside facts recorded in the manifest only: token counters, generator file hashes, tokenizer version,
 *   seed scan result and collision report. Missing values are recorded as `'UNKNOWN'` / `NOT_SCANNED` / `NOT_COMPARED`.
 * @returns The content, the JSONL texts and the manifest (no file is written here).
 * @throws {RangeError} When `o.splitPlan` is invalid (see {@link validateSplitPlan}), or errors from the S1 and dialog
 *   generators for invalid sizes or forbidden seeds.
 */
export function buildCorpus(o: BuildOptions, ctx: { counters?: Counters; generatorFiles?: Array<{ path: string; sha256: string }>; tokenizerVersion?: string | null; seedVerification?: SeedVerification | null; collision?: CollisionReport | null } = {}): CorpusBuild {
  const sp = o.splitPlan; if (sp !== undefined) validateSplitPlan(sp);
  const s1 = buildS1({ seed: o.seed, groupsPerCell: o.groupsPerCell, variantsPerGroup: o.variantsPerGroup, repeatsPerCell: o.repeatsPerCell, pilotCells: o.pilotCells, extraForbiddenSeeds: o.extraForbiddenSeeds, ...(sp?.cells ? { splitPlanCells: sp.cells } : {}), ...(sp?.pilotGroupsPerCell !== undefined ? { pilotGroupsPerCell: sp.pilotGroupsPerCell } : {}) });
  const dialogs = buildDialogs({ seed: o.seed, extraForbiddenSeeds: o.extraForbiddenSeeds, s2Dialogs: o.s2Dialogs, s3Dialogs: o.s3Dialogs, pilotS2: o.pilotS2, pilotS3: o.pilotS3, prefixChars: o.prefixChars, ...(sp?.dialogs ? { splitPlanDialogs: sp.dialogs } : {}) });
  const s1Jsonl = s1.prompts.map((p) => canonicalJson(p)).join('\n') + '\n';
  const dialogsJsonl = dialogs.map((d) => canonicalJson(d)).join('\n') + '\n';
  const c = ctx.counters ?? {};
  const prompts = s1.prompts.map((p: S1Prompt) => ({ promptSha256: contentOfS1(p).promptSha256, promptId: p.promptId, cellId: p.cellId, groupId: p.groupId, variant: p.variant, task: p.task, size: p.size, phase: p.phase, split: p.split, textSha256: p.textSha256, chars: p.chars, tokensEst: { o200k_base: est(c.o200k_base, p.text), cl100k_base: est(c.cl100k_base, p.text) } }));
  const dlg = dialogs.map((d) => ({
    dialogId: d.dialogId, arm: d.arm, phase: d.phase, split: d.split, prefixSha256: d.prefixSha256, prefixChars: d.prefix.length,
    prefixTokensEst: { o200k_base: est(c.o200k_base, d.prefix), cl100k_base: est(c.cl100k_base, d.prefix) },
    turnsSha256: sha256Hex(canonicalJson(d.turns)),
    calls: ([1, 2, 3] as const).map((k) => ({ call: k, promptSha256: contentOf(d, k).promptSha256, nonce: d.arm === 'S2_NOHIT' ? d.nonces[k - 1] : undefined })),
    nonces: d.arm === 'S2_NOHIT' ? d.nonces : undefined,
    nonceTokenDelta: d.arm === 'S2_NOHIT' ? { o200k_base: auditNonceTokens(d, c.o200k_base ?? null).map((a) => a.delta), cl100k_base: auditNonceTokens(d, c.cl100k_base ?? null).map((a) => a.delta) } : undefined,
  }));
  const bySplit = (rows: Array<{ split: string; groupId?: string; dialogId?: string; phase: string }>) => {
    const out: Record<string, { items: number; units: number }> = {};
    for (const r of rows.filter((x) => x.phase === 'CONFIRMATORY')) { const e = (out[r.split] ??= { items: 0, units: 0 }); e.items += 1; }
    return out;
  };
  const groupsBySplit: Record<string, number> = {};
  for (const g of new Set(s1.prompts.filter((p) => p.phase === 'CONFIRMATORY').map((p) => `${p.groupId}|${p.split}`))) { const sp = g.split('|')[1]!; groupsBySplit[sp] = (groupsBySplit[sp] ?? 0) + 1; }
  const dialogsBySplit: Record<string, Record<string, number>> = {};
  for (const d of dialogs.filter((x) => x.phase === 'CONFIRMATORY')) { const a = (dialogsBySplit[d.arm] ??= {}); a[d.split] = (a[d.split] ?? 0) + 1; }
  const designs = { ...DEFAULT_DESIGNS, ...(o.designs ?? {}) } as Record<ModelId, Design>;
  const modelDesigns = Object.fromEntries((Object.keys(designs) as ModelId[]).map((m) => [m, summarizeDesign(s1PlanFor(s1, designs[m]), designs[m])]));
  const s1Sha = sha256Hex(s1Jsonl); const dlgSha = sha256Hex(dialogsJsonl);
  const params = { groupsPerCell: o.groupsPerCell ?? 8, variantsPerGroup: o.variantsPerGroup ?? 3, repeatsPerCell: o.repeatsPerCell ?? 3, s2Dialogs: o.s2Dialogs ?? 15, s3Dialogs: o.s3Dialogs ?? 30, pilotS2: o.pilotS2 ?? 2, pilotS3: o.pilotS3 ?? 3, prefixChars: o.prefixChars ?? null, ...(sp !== undefined ? { splitPlan: sp } : {}) }; // C154: a chave so existe com split plan (byte-identidade)
  const corpusSha256 = sha256Hex(canonicalJson({ version: S1_CORPUS_VERSION, seed: o.seed, params, s1Sha256: s1Sha, dialogsSha256: dlgSha, designs }));
  const manifest = {
    schema: 'otk.h2eval_corpus.manifest.v1', corpusVersion: S1_CORPUS_VERSION, seed: o.seed, params, corpusSha256, s1Sha256: s1Sha, dialogsSha256: dlgSha,
    counts: { s1Prompts: s1.prompts.filter((p) => p.phase === 'CONFIRMATORY').length, s1PilotPrompts: s1.prompts.filter((p) => p.phase === 'PILOT').length, s1Repeats: s1.repeats.length, s1Calls: s1.prompts.filter((p) => p.phase === 'CONFIRMATORY').length + s1.repeats.length, dialogsConfirmatory: dialogs.filter((d) => d.phase === 'CONFIRMATORY').length, dialogsPilot: dialogs.filter((d) => d.phase === 'PILOT').length },
    splitSummary: { s1PromptsBySplit: bySplit(s1.prompts), s1GroupsBySplit: groupsBySplit, dialogsByArmAndSplit: dialogsBySplit },
    modelDesigns, s1: { cells: s1.cells, prompts, repeats: s1.repeats }, dialogs: dlg,
    seedVerification: ctx.seedVerification ? { verdict: ctx.seedVerification.verdict, candidateFoundInAnyRef: ctx.seedVerification.candidateFoundInAnyRef, allRefsScanned: ctx.seedVerification.allRefsScanned, refs: ctx.seedVerification.refs.length, file: 'seed_verification.json' } : { verdict: 'NOT_SCANNED', file: null },
    textCollision: ctx.collision ? { verdict: ctx.collision.verdict, exactCollisions: ctx.collision.exactCollisions.length, refs: ctx.collision.refs.map((r) => `${r.name}:${r.count}`), file: 'text_collision_report.json' } : { verdict: 'NOT_COMPARED', file: null },
    generator: { files: ctx.generatorFiles ?? [], codeSha256: ctx.generatorFiles ? sha256Hex(ctx.generatorFiles.map((f) => `${f.path}:${f.sha256}`).join('\n')) : 'UNKNOWN' },
    tokenEstimator: { package: 'js-tiktoken', version: ctx.tokenizerVersion ?? 'UNKNOWN', encodings: Object.keys(c), note: 'estimativa local; NÃO é a contagem do provedor' },
    rules: { splitUnit: 'grupo (S1) / diálogo (S2,S3)', allocation: 'balanceada por célula, ordem sha256(semente|célula|índice)', seedPolicy: 'semente nova, recusada se repetir H1/CAL-ANTH', pilot: 'grupos próprios, phase PILOT, split NONE, fora do treino e da amostra confirmatória' },
  };
  return { s1, dialogs, s1Jsonl, dialogsJsonl, manifest };
}
