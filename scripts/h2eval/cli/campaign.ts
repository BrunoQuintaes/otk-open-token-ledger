/**
 * R18–R20 campaign gating (CARTA C143-A item 2). The campaign plan (phase CAMPAIGN) orders batches train → comparative → validation →
 * holdout. The order is a CODE lock, not a convention:
 *   - a validation batch runs only when `<campaignDir>/gates/TRAIN_FROZEN.json` exists (every train batch terminal, datasets hashed);
 *   - a holdout batch runs only when `<campaignDir>/gates/VALIDATION_SELECTED.json` exists (selection artifact: the predictor profile,
 *     with its parameters' sha256, chosen on validation BEFORE any holdout call);
 *   - for holdout the immutable prediction (profile + expectedCostUsd) is written into the pre-call snapshot (R12), so it cannot be
 *     changed after the response.
 * Nothing here retries an uncertain operation; the first STOP of a batch ends it (run.ts). No network.
 *
 * Also holds the other campaign controls used by `./run.ts` and the CLI entry point (`./main.ts`): the signed human
 * gates (pilot verdict per model, Google account gate, probe gate), the immutable campaign identity and its control
 * registry, the GO nonce registry (anti-replay) and the count of attempts already sent. Files written: the gate files
 * under `<campaignDir>/gates/`, `CAMPAIGN_IDENTITY.json`, `go_nonces.jsonl`, dataset exports in batch folders, and one
 * record per campaign in the control registry folder, which is OUTSIDE the campaign folder (environment variable
 * `H2EVAL_CONTROL_DIR`, default `~/.otk-h2eval/control`).
 *
 * @module scripts/h2eval/cli/campaign
 */
import { constants as fsConstants, copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
import { CliError, EXIT, readJson, sha256File, sha256Text, writeJson } from './common.js';
import type { BatchPlan, PlannedBatch } from './plan.js';
import { exportDataset, status } from './status.js';
import type { Count, OperationPlan, PicoUsd, PrecallSnapshot } from '../types.js';

/** Block an operation belongs to; pilot operations form their own block. */
export type SplitBlock = 'train' | 'comparative' | 'validation' | 'holdout' | 'pilot';
/** Locked execution order of the campaign blocks. */
export const BLOCK_ORDER: readonly SplitBlock[] = Object.freeze(['train', 'comparative', 'validation', 'holdout']);
/** Gate file that must exist under `<campaignDir>/gates/` before a validation or holdout batch runs. */
export const GATE_FILES = Object.freeze({ validation: 'TRAIN_FROZEN.json', holdout: 'VALIDATION_SELECTED.json' });

/**
 * Block of an operation from its split and phase (any unknown split counts as train).
 *
 * @param split - Split of the operation.
 * @param phase - Phase of the operation.
 * @returns The block.
 */
export const blockOf = (split: string, phase: string): SplitBlock => (phase === 'PILOT' ? 'pilot' : phase === 'COMPARATIVE_PAIRED' || split === 'COMPARATIVE' ? 'comparative' : split === 'validation' ? 'validation' : split === 'holdout' ? 'holdout' : 'train');

import type { ForecastFrozen } from '../record/forecast.js';
/**
 * Content of `gates/TRAIN_FROZEN.json`: the protocol hash, the freeze time (ISO-8601 UTC), one row per train or
 * comparative batch with its operation counts and the SHA-256 of its dataset and summary, the SHA-256 of that row
 * list, and the forecast table frozen on train (`null` when none was given).
 */
export interface TrainFrozen { schema: 'h2eval.gate.train_frozen.v0'; protocolHash: string; frozenUtc: string; batches: Array<{ batchId: string; batchDir: string; operations: number; terminal: number; datasetSha256: string; summarySha256: string; /** C2-FIX: basename of the export the hashes refer to (dataset.jsonl, or dataset.v<N>.jsonl when an earlier different export was preserved) */ datasetFile?: string }>; sha256OfBatchList: string; /** E1: frozen OUT_MEAN/OUT_LEARN table fitted on TRAIN only (ECON-02 forecast_fit), used for the validation batches' pre-call forecast */ forecastFrozen: ForecastFrozen | null }
/**
 * Content of `gates/VALIDATION_SELECTED.json`: the protocol hash, selection time, the SHA-256 of the train gate it
 * follows, the validation batches with their dataset hashes, the predictor profile chosen on validation (method,
 * id, parameters and their SHA-256), the human signature (`human:<name>`) and the frozen forecast table.
 */
export interface ValidationSelected { schema: 'h2eval.gate.validation_selected.v0'; protocolHash: string; selectedUtc: string; trainFrozenSha256: string; validationBatches: Array<{ batchId: string; datasetSha256: string }>; profile: { method: 'M0' | 'M1' | 'M1S' | 'M2'; profileId: string; paramsSha256: string; trainedOn: string; /** C154: per model {a, b, out} and, optionally, `byStructure: { S1 | S2 | S3: {a, b, out} }` (profile by structure; the model-level triple is the fallback) */ params: Record<string, ProfileParams> }; selectedBy: string; /** E1: frozen forecast table (fit on train, selected on validation) used for the holdout batches' pre-call forecast */ forecastFrozen: ForecastFrozen | null }

const batchDirOf = (campaignDir: string, batchId: string) => path.join(campaignDir, 'batches', batchId);

/** C2-FIX (E1″): journal lines that are NOT a state of the operation — exactly the kinds the runner's replay filters out (core/runner.ts, replayDecision).
 * Before E1″ only REPLAY_SKIPPED/PAUSE_ACK were skipped here, so an operation that ended in MODEL_PROBE_RESULT (probe) or UNCERTAIN_ACKNOWLEDGED was read as not terminal. */
export const NON_OPERATION_KINDS: ReadonlySet<string> = new Set(['REPLAY_SKIPPED', 'UNCERTAIN_ACKNOWLEDGED', 'MODEL_PROBE_STARTED', 'MODEL_PROBE_RESULT', 'REPLAY_PLAN_MISMATCH', 'PAUSE_ACK', 'PAUSE_REVIEW', 'PAUSE_PREAUTHORIZED']);

/**
 * Every operation of the batch must have reached a terminal state (settled or isolated) and nothing may remain reserved.
 *
 * @param campaignDir - Campaign folder.
 * @param b - The planned batch.
 * @returns Planned operation count, how many reached a terminal state, and whether any is still RESERVED or SENT
 *   (no journal yet means 0 terminal).
 */
export function batchTerminal(campaignDir: string, b: PlannedBatch): { operations: number; terminal: number; openReservations: boolean } {
  const dir = batchDirOf(campaignDir, b.batchId);
  if (!existsSync(path.join(dir, 'journal.jsonl'))) return { operations: b.operations.length, terminal: 0, openReservations: false };
  const st = status(dir);
  const TERMINAL = new Set(['SETTLED', 'UNCERTAIN_ISOLATED', 'STOP_GLOBAL', 'STOP_BUDGET', 'ABORTED_BEFORE_SEND', 'NOT_SUPPORTED', 'NOT_RUN_BRANCH_LOCKED', 'REPLAY_SKIPPED', 'REPLAY_PLAN_MISMATCH']);
  let terminal = 0; let open = false;
  for (const op of b.operations) { const o = st.operations[op.operationId]; if (!o) continue; const real = [...o.kinds].reverse().find((k) => !NON_OPERATION_KINDS.has(k)); if (real && TERMINAL.has(real)) terminal += 1; if (real === 'RESERVED' || real === 'SENT') open = true; }
  return { operations: b.operations.length, terminal, openReservations: open };
}

/** C2-FIX (E1″, ressalva R3 da auditoria v9): the freeze NEVER overwrites an existing dataset export with other content.
 * The export is written to a temporary file; with no previous export it becomes dataset.jsonl; with a byte-identical one (dataset + summary) the existing file is used;
 * with a DIFFERENT one the existing dataset.jsonl/dataset_summary.json stay untouched and the freeze export goes to the first free dataset.v<N>.jsonl (N >= 2).
 * Every placement is an exclusive copy (COPYFILE_EXCL): a name that already exists is never replaced.
 *
 * @param batchDir - Batch folder.
 * @returns The dataset and summary files the freeze refers to, and whether an earlier different export was kept.
 */
export function exportDatasetForFreeze(batchDir: string): { file: string; summaryFile: string; preservedPrevious: boolean } {
  const sumOf = (f: string) => f.replace(/\.jsonl$/, '_summary.json');
  const base = path.join(batchDir, 'dataset.jsonl'); const tmp = path.join(batchDir, 'dataset.freeze_tmp.jsonl');
  exportDataset(batchDir, tmp);
  const place = (dst: string) => { copyFileSync(tmp, dst, fsConstants.COPYFILE_EXCL); copyFileSync(sumOf(tmp), sumOf(dst), fsConstants.COPYFILE_EXCL); };
  const cleanup = () => { unlinkSync(tmp); unlinkSync(sumOf(tmp)); };
  let out: { file: string; summaryFile: string; preservedPrevious: boolean };
  if (!existsSync(base) && !existsSync(sumOf(base))) { place(base); out = { file: base, summaryFile: sumOf(base), preservedPrevious: false }; }
  else if (existsSync(base) && existsSync(sumOf(base)) && sha256File(base) === sha256File(tmp) && sha256File(sumOf(base)) === sha256File(sumOf(tmp))) out = { file: base, summaryFile: sumOf(base), preservedPrevious: false };
  else {
    let n = 2; let dst = path.join(batchDir, `dataset.v${n}.jsonl`);
    while (existsSync(dst) || existsSync(sumOf(dst))) { n += 1; dst = path.join(batchDir, `dataset.v${n}.jsonl`); }
    place(dst); out = { file: dst, summaryFile: sumOf(dst), preservedPrevious: true };
  }
  cleanup();
  return out;
}

/** Gate 1: freeze the train block (all train + comparative batches terminal; datasets exported and hashed). */
/**
 * Validates an optional frozen forecast table before it is written into a gate.
 *
 * @param f - The table, or `null`/`undefined` for none.
 * @returns The table, or `null`.
 * @throws {@link CliError} USAGE `FORECAST_FROZEN_INVALID` for a malformed table; REFUSED_BY_POLICY
 *   `FORECAST_FROZEN_READ_HOLDOUT` when it was fitted with holdout rows.
 */
const checkFrozen = (f: ForecastFrozen | null | undefined): ForecastFrozen | null => { if (!f) return null; if (f.schema !== 'h2eval.forecast_frozen.v0' || !/^[0-9a-f]{64}$/.test(f.freezeSha256 ?? '') || typeof f.perModel !== 'object') throw new CliError(EXIT.USAGE, 'FORECAST_FROZEN_INVALID', 'expected h2eval.forecast_frozen.v0 with freezeSha256 and perModel'); if (f.holdoutRead === true) throw new CliError(EXIT.REFUSED_BY_POLICY, 'FORECAST_FROZEN_READ_HOLDOUT', 'a forecast table that read holdout rows cannot be used ex ante'); return f; };

/**
 * Writes the train gate after checking that every train and comparative batch (Google branch-locked batches skipped)
 * is terminal, exporting and hashing their datasets.
 *
 * @param plan - The campaign plan.
 * @param campaignDir - Campaign folder.
 * @param now - Clock returning ISO-8601 UTC.
 * @param forecastFrozen - Optional forecast table fitted on train only.
 * @returns The gate content written to `gates/TRAIN_FROZEN.json`.
 * @throws {@link CliError} REFUSED_BY_POLICY when the gate already exists, a batch is not terminal or the forecast
 *   table read holdout rows; PLAN_INVALID when the plan has no train batch; USAGE when the forecast table is malformed.
 */
export function freezeTrain(plan: BatchPlan, campaignDir: string, now = () => new Date().toISOString(), forecastFrozen?: ForecastFrozen | null): TrainFrozen {
  const gatesDir = path.join(campaignDir, 'gates'); const out = path.join(gatesDir, GATE_FILES.validation);
  if (existsSync(out)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'TRAIN_ALREADY_FROZEN', out);
  const trainBatches = plan.batches.filter((b) => b.block === 'train' || b.block === 'comparative');
  if (!trainBatches.length) throw new CliError(EXIT.PLAN_INVALID, 'NO_TRAIN_BATCHES', plan.phase);
  const rows: TrainFrozen['batches'] = [];
  for (const b of trainBatches) {
    if (b.branchLocked) continue; // Google: planned, never run, never part of the freeze
    const t = batchTerminal(campaignDir, b);
    if (t.terminal !== t.operations || t.openReservations) throw new CliError(EXIT.REFUSED_BY_POLICY, 'TRAIN_BATCH_NOT_TERMINAL', `${b.batchId}: ${t.terminal}/${t.operations} terminal, open reservations: ${t.openReservations}`);
    const dir = batchDirOf(campaignDir, b.batchId);
    const ds = exportDatasetForFreeze(dir); // C2-FIX: never overwrites an earlier export (R3)
    rows.push({ batchId: b.batchId, batchDir: dir, operations: t.operations, terminal: t.terminal, datasetSha256: sha256File(ds.file), summarySha256: sha256File(ds.summaryFile), datasetFile: path.basename(ds.file) });
  }
  const art: TrainFrozen = { schema: 'h2eval.gate.train_frozen.v0', protocolHash: plan.protocolHash, frozenUtc: now(), batches: rows, sha256OfBatchList: sha256Text(JSON.stringify(rows)), forecastFrozen: checkFrozen(forecastFrozen) };
  writeJson(out, art);
  return art;
}

/** C154 (ciclo 2): parametros de um modelo no perfil. `byStructure` e OPCIONAL: sem ele o comportamento e o de a4da8651/abf16a01 (um {a,b,out} por modelo). */
/** Linear predictor of one model: input tokens = a + b * L0 (L0 = local estimate), output tokens = out. */
export type ProfileTriple = { a: number; b: number; out: number };
/** Predictor parameters of one model: an optional model-level triple and optional triples per structure (S1, S2, S3). */
export type ProfileParams = Partial<ProfileTriple> & { byStructure?: Partial<Record<'S1' | 'S2' | 'S3', ProfileTriple>> } & Record<string, unknown>;
/** Accepted predictor methods of a selected profile. */
export const PROFILE_METHODS: readonly string[] = Object.freeze(['M0', 'M1', 'M1S', 'M2']);
const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** C154: validates the shape of `params` (per model: a/b/out numbers when present; byStructure keys ⊂ {S1,S2,S3}, each a full finite triple). null = OK, else a short reason. */
/**
 * Validates the shape of predictor profile parameters (per model: optional finite a/b/out, and optional full
 * triples per structure S1, S2, S3).
 *
 * @param params - Profile parameters keyed by model.
 * @returns `null` when valid, otherwise a short reason such as `<model>:a_not_finite`.
 */
export function profileParamsProblem(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params_not_object';
  for (const [model, p] of Object.entries(params as Record<string, unknown>)) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return `${model}:not_object`;
    const q = p as Record<string, unknown>;
    for (const k of ['a', 'b', 'out']) if (q[k] !== undefined && !finiteNum(q[k])) return `${model}:${k}_not_finite`;
    if (q['byStructure'] !== undefined) {
      const bs = q['byStructure']; if (!bs || typeof bs !== 'object' || Array.isArray(bs)) return `${model}:byStructure_not_object`;
      for (const [st, t] of Object.entries(bs as Record<string, unknown>)) {
        if (!['S1', 'S2', 'S3'].includes(st)) return `${model}:byStructure_key_${st}`;
        const tt = t as Record<string, unknown> | null; if (!tt || typeof tt !== 'object' || !finiteNum(tt['a']) || !finiteNum(tt['b']) || !finiteNum(tt['out'])) return `${model}:byStructure_${st}_triple`;
      }
    }
  }
  return null;
}
/**
 * Gate 2: record the predictor selected on validation (profile + params sha256) BEFORE any holdout call.
 *
 * @param plan - The campaign plan.
 * @param campaignDir - Campaign folder.
 * @param profile - The selected profile; `paramsSha256` must equal SHA-256 of `JSON.stringify(params)`.
 * @param selectedBy - Human signature, `human:<name>`.
 * @param now - Clock returning ISO-8601 UTC.
 * @param forecastFrozen - Optional frozen forecast table for the holdout.
 * @returns The gate content written to `gates/VALIDATION_SELECTED.json`.
 * @throws {@link CliError} REFUSED_BY_POLICY when train is not frozen, the gate already exists, a validation batch is
 *   not terminal or the forecast table read holdout rows; USAGE for an unsigned selection, a hash mismatch, an
 *   unknown method, malformed params or a malformed forecast table.
 */
export function selectOnValidation(plan: BatchPlan, campaignDir: string, profile: ValidationSelected['profile'], selectedBy: string, now = () => new Date().toISOString(), forecastFrozen?: ForecastFrozen | null): ValidationSelected {
  const gatesDir = path.join(campaignDir, 'gates'); const frozenPath = path.join(gatesDir, GATE_FILES.validation); const out = path.join(gatesDir, GATE_FILES.holdout);
  if (!existsSync(frozenPath)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'TRAIN_NOT_FROZEN', frozenPath);
  if (existsSync(out)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'VALIDATION_ALREADY_SELECTED', out);
  if (!/^human:\S/.test(selectedBy)) throw new CliError(EXIT.USAGE, 'SELECTED_BY_UNSIGNED', 'selectedBy must be human:<name>');
  if (profile.paramsSha256 !== sha256Text(JSON.stringify(profile.params))) throw new CliError(EXIT.USAGE, 'PROFILE_PARAMS_SHA_MISMATCH', 'paramsSha256 != sha256(JSON.stringify(params))');
  if (!PROFILE_METHODS.includes(profile.method)) throw new CliError(EXIT.USAGE, 'PROFILE_METHOD_INVALID', String(profile.method)); // C154
  const pp = profileParamsProblem(profile.params); if (pp) throw new CliError(EXIT.USAGE, 'PROFILE_PARAMS_INVALID', pp); // C154: shape checked BEFORE the gate is written
  const rows: ValidationSelected['validationBatches'] = [];
  for (const b of plan.batches.filter((x) => x.block === 'validation' && !x.branchLocked)) {
    const t = batchTerminal(campaignDir, b);
    if (t.terminal !== t.operations || t.openReservations) throw new CliError(EXIT.REFUSED_BY_POLICY, 'VALIDATION_BATCH_NOT_TERMINAL', `${b.batchId}: ${t.terminal}/${t.operations}`);
    const ds = exportDataset(batchDirOf(campaignDir, b.batchId));
    rows.push({ batchId: b.batchId, datasetSha256: sha256File(ds.file) });
  }
  const art: ValidationSelected = { schema: 'h2eval.gate.validation_selected.v0', protocolHash: plan.protocolHash, selectedUtc: now(), trainFrozenSha256: sha256File(frozenPath), validationBatches: rows, profile, selectedBy, forecastFrozen: checkFrozen(forecastFrozen) };
  writeJson(out, art);
  return art;
}

/** Code lock consulted by `run` before a batch starts: which gate artifact the block requires, and whether it is present and matches the protocol. */
const HEX64 = /^[0-9a-f]{64}$/;
const frozenCode = (f: unknown): string | null => { if (f === null || f === undefined) return null; const t = f as ForecastFrozen; if (t.schema !== 'h2eval.forecast_frozen.v0' || !HEX64.test(t.freezeSha256 ?? '') || typeof t.perModel !== 'object') return 'GATE_FORECAST_INVALID'; if (t.holdoutRead === true) return 'GATE_FORECAST_READ_HOLDOUT'; return null; };
/**
 * R15-D-1: TRAIN_FROZEN revalidated WHOLE (schema, protocolHash, non-empty rows with hex64 digests, recomputed sha256 of the batch list, forecast table).
 *
 * @param plan - The campaign plan.
 * @param file - Path of the train gate file.
 * @returns `code: null` and the artifact when valid; otherwise a `GATE_*` code and `art: null`. Never throws.
 */
export function validateTrainFrozen(plan: BatchPlan, file: string): { code: string | null; art: TrainFrozen | null } {
  let art: TrainFrozen; try { art = readJson<TrainFrozen>(file); } catch { return { code: 'GATE_ARTIFACT_UNREADABLE', art: null }; }
  if (!art || art.schema !== 'h2eval.gate.train_frozen.v0') return { code: 'GATE_ARTIFACT_SCHEMA', art: null };
  if (art.protocolHash !== plan.protocolHash) return { code: 'GATE_PROTOCOL_MISMATCH', art: null };
  if (!Array.isArray(art.batches) || !art.batches.length || art.batches.some((r) => !r || typeof r.batchId !== 'string' || !HEX64.test(r.datasetSha256 ?? '') || !HEX64.test(r.summarySha256 ?? '') || r.terminal !== r.operations)) return { code: 'GATE_BATCH_LIST_INVALID', art: null };
  if (art.sha256OfBatchList !== sha256Text(JSON.stringify(art.batches))) return { code: 'GATE_BATCH_LIST_SHA_MISMATCH', art: null };
  const planIds = new Set(plan.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => b.batchId));
  if (art.batches.length !== planIds.size || art.batches.some((r) => !planIds.has(r.batchId))) return { code: 'GATE_BATCH_LIST_NOT_PLAN', art: null };
  const fc = frozenCode(art.forecastFrozen); if (fc) return { code: fc, art: null };
  return { code: null, art };
}
/**
 * R15-D-1: VALIDATION_SELECTED revalidated WHOLE (schema, protocolHash, human signature, paramsSha256 recomputed, trainFrozenSha256 == sha256 of the CURRENT TRAIN_FROZEN, which is itself revalidated, rows, forecast table).
 *
 * @param plan - The campaign plan.
 * @param file - Path of the validation gate file.
 * @param trainFrozenFile - Path of the current train gate file.
 * @returns `code: null` and the artifact when valid; otherwise a `GATE_*` code and `art: null`.
 */
export function validateValidationSelected(plan: BatchPlan, file: string, trainFrozenFile: string): { code: string | null; art: ValidationSelected | null } {
  let art: ValidationSelected; try { art = readJson<ValidationSelected>(file); } catch { return { code: 'GATE_ARTIFACT_UNREADABLE', art: null }; }
  if (!art || art.schema !== 'h2eval.gate.validation_selected.v0') return { code: 'GATE_ARTIFACT_SCHEMA', art: null };
  if (art.protocolHash !== plan.protocolHash) return { code: 'GATE_PROTOCOL_MISMATCH', art: null };
  if (!/^human:\S/.test(art.selectedBy ?? '')) return { code: 'GATE_UNSIGNED', art: null };
  const p = art.profile; if (!p || !PROFILE_METHODS.includes(p.method) || typeof p.profileId !== 'string' || typeof p.params !== 'object' || p.params === null || profileParamsProblem(p.params) !== null) return { code: 'GATE_PROFILE_INVALID', art: null }; // C154: byStructure shape revalidated at every use
  if (p.paramsSha256 !== sha256Text(JSON.stringify(p.params))) return { code: 'GATE_PROFILE_SHA_MISMATCH', art: null };
  if (!existsSync(trainFrozenFile)) return { code: 'GATE_TRAIN_NOT_FROZEN', art: null };
  const tf = validateTrainFrozen(plan, trainFrozenFile); if (tf.code) return { code: tf.code, art: null };
  if (art.trainFrozenSha256 !== sha256File(trainFrozenFile)) return { code: 'GATE_TRAIN_FROZEN_CHANGED', art: null };
  if (!Array.isArray(art.validationBatches) || !art.validationBatches.length || art.validationBatches.some((r) => !r || typeof r.batchId !== 'string' || !HEX64.test(r.datasetSha256 ?? ''))) return { code: 'GATE_BATCH_LIST_INVALID', art: null };
  const valIds = new Set(plan.batches.filter((b) => b.block === 'validation' && !b.branchLocked).map((b) => b.batchId));
  if (art.validationBatches.length !== valIds.size || art.validationBatches.some((r) => !valIds.has(r.batchId))) return { code: 'GATE_BATCH_LIST_NOT_PLAN', art: null };
  const fc = frozenCode(art.forecastFrozen); if (fc) return { code: fc, art: null };
  return { code: null, art };
}
/**
 * Code lock consulted before a batch starts: which gate file its block requires, whether it is present and valid.
 *
 * @param plan - The campaign plan.
 * @param batch - The batch about to run.
 * @param campaignDir - Campaign folder.
 * @returns `required` (gate path, `null` for train, comparative and pilot), `present`, a refusal `code` (`null` when
 *   the batch may run), the selection (holdout only), the frozen forecast table, and the gate file name and SHA-256
 *   that go into every pre-call snapshot.
 */
export function gateFor(plan: BatchPlan, batch: PlannedBatch, campaignDir: string): { required: string | null; present: boolean; code: string | null; selection: ValidationSelected | null; forecastFrozen: ForecastFrozen | null; gateUsed: { block: string; file: string; sha256: string } | null } {
  const block = batch.block ?? 'train';
  if (block === 'train' || block === 'comparative' || block === 'pilot') return { required: null, present: true, code: null, selection: null, forecastFrozen: null, gateUsed: null };
  const gates = path.join(campaignDir, 'gates'); const file = path.join(gates, block === 'validation' ? GATE_FILES.validation : GATE_FILES.holdout);
  if (!existsSync(file)) return { required: file, present: false, code: block === 'validation' ? 'GATE_TRAIN_NOT_FROZEN' : 'GATE_VALIDATION_NOT_SELECTED', selection: null, forecastFrozen: null, gateUsed: null };
  // R15-D-1: the artifact is revalidated WHOLE at every use (a forged or later-edited gate is refused), and its digest goes into every pre-call snapshot
  if (block === 'validation') { const v = validateTrainFrozen(plan, file); if (v.code) return { required: file, present: true, code: v.code, selection: null, forecastFrozen: null, gateUsed: null }; return { required: file, present: true, code: null, selection: null, forecastFrozen: v.art!.forecastFrozen ?? null, gateUsed: { block, file: path.basename(file), sha256: sha256File(file) } }; }
  const v = validateValidationSelected(plan, file, path.join(gates, GATE_FILES.validation)); if (v.code) return { required: file, present: true, code: v.code, selection: null, forecastFrozen: null, gateUsed: null };
  return { required: file, present: true, code: null, selection: v.art, forecastFrozen: v.art!.forecastFrozen ?? null, gateUsed: { block, file: path.basename(file), sha256: sha256File(file) } };
}

/** Immutable prediction for holdout operations from the selected profile (linear in L0 per model: tokens = a + b·L0; cost at the input price is left to the executor's table).
 * C154: with `params[model].byStructure[plan.structure]` the triple of that structure is used; otherwise the model-level triple (unchanged behaviour). */
/**
 * Builds the holdout predictor from the validation selection; a per-structure triple wins over the model-level one.
 *
 * @param sel - The validation selection.
 * @returns A function of (plan, L0, input price, output price) giving the profile identity and the expected cost
 *   (pico-USD as integer text, when the prices are pico-USD per token), or `UNKNOWN` when the model has no parameters,
 *   L0 is unknown or a price is `null`. Missing a/b/out default to 0/1/0.
 */
export function predictorFrom(sel: ValidationSelected): (plan: OperationPlan, L0: Count, microInput: bigint | null, microOutput: bigint | null) => { profile: PrecallSnapshot['profile']; expectedCostUsd: PicoUsd | 'UNKNOWN' } {
  return (plan, L0, microInput, microOutput) => {
    const pm = sel.profile.params[plan.modelRequested];
    const profile = { method: sel.profile.method, profileId: sel.profile.profileId, paramsSha256: sel.profile.paramsSha256, trainedOn: sel.profile.trainedOn };
    if (!pm || typeof L0 !== 'number' || microInput === null || microOutput === null) return { profile, expectedCostUsd: 'UNKNOWN' };
    const p: Partial<ProfileTriple> = pm.byStructure?.[plan.structure as 'S1' | 'S2' | 'S3'] ?? pm; // C154
    const inTok = Math.max(0, Math.round((p.a ?? 0) + (p.b ?? 1) * L0)); const outTok = Math.max(0, Math.round(p.out ?? 0));
    return { profile, expectedCostUsd: (BigInt(inTok) * microInput + BigInt(outTok) * microOutput).toString() };
  };
}

// ---------------------------------------------------------------- C144: pilot verdict per model (G17), Google account gate (G16-GOOGLE), nonce registry
/** Signed pilot verdict for one model, required before its campaign batches (file `gates/G17_<model>.json`). */
export interface GateG17 { schema: 'h2eval.gate.g17.v0'; model: string; verdict: 'PASS' | 'FAIL' | 'NOT_RUN'; pilotProtocolHash: string; signedBy: string; atUtc: string; note?: string }
/** Signed Google account gate: four guarantees about the billing project, exposure limit, billed outputs and credential. */
export interface GateG16Google { schema: 'h2eval.gate.g16_google.v0'; verdict: 'PASS' | 'FAIL'; dedicatedProjectAndBilling: boolean; effectiveExposureLimitVerified: boolean; billedOutputsAndReasoningVerified: boolean; credentialVerified: boolean; signedBy: string; atUtc: string }
const gatePath = (campaignDir: string, name: string) => path.join(campaignDir, 'gates', name);
/**
 * File name of a model's pilot verdict gate.
 *
 * @param model - Model id.
 * @returns `G17_<model>.json`.
 */
export const g17FileOf = (model: string) => `G17_${model}.json`;
/**
 * Writes a model's signed pilot verdict gate (never overwritten).
 *
 * @param campaignDir - Campaign folder.
 * @param g - Gate content without the schema.
 * @returns Path of the written gate.
 * @throws {@link CliError} USAGE when unsigned or the verdict is not PASS, FAIL or NOT_RUN; REFUSED_BY_POLICY when
 *   the gate already exists.
 */
export function writeGateG17(campaignDir: string, g: Omit<GateG17, 'schema'>): string {
  if (!/^human:\S/.test(g.signedBy)) throw new CliError(EXIT.USAGE, 'GATE_UNSIGNED', 'signedBy must be human:<name>');
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(g.verdict)) throw new CliError(EXIT.USAGE, 'GATE_VERDICT', 'PASS|FAIL|NOT_RUN');
  const p = gatePath(campaignDir, g17FileOf(g.model)); if (existsSync(p)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GATE_ALREADY_WRITTEN', p);
  writeJson(p, { schema: 'h2eval.gate.g17.v0', ...g }); return p;
}
/**
 * Reads a model's pilot verdict gate.
 *
 * @param campaignDir - Campaign folder.
 * @param model - Model id.
 * @param pilotProtocolHash - When given, the gate must name this pilot protocol.
 * @returns The verdict; `MISSING` when absent, of another schema or unsigned; `WRONG_PILOT` when the hash differs.
 */
export function g17Verdict(campaignDir: string, model: string, pilotProtocolHash?: string): 'PASS' | 'FAIL' | 'NOT_RUN' | 'MISSING' | 'WRONG_PILOT' {
  const p = gatePath(campaignDir, g17FileOf(model)); if (!existsSync(p)) return 'MISSING';
  const g = readJson<GateG17>(p); if (g.schema !== 'h2eval.gate.g17.v0' || !/^human:\S/.test(g.signedBy ?? '')) return 'MISSING';
  if (pilotProtocolHash && g.pilotProtocolHash !== pilotProtocolHash) return 'WRONG_PILOT';
  return g.verdict;
}
/**
 * Writes the signed Google account gate `gates/G16_GOOGLE.json` (never overwritten).
 *
 * @param campaignDir - Campaign folder.
 * @param g - Gate content without the schema.
 * @returns Path of the written gate.
 * @throws {@link CliError} USAGE when unsigned; REFUSED_BY_POLICY when the gate already exists.
 */
export function writeGateG16Google(campaignDir: string, g: Omit<GateG16Google, 'schema'>): string {
  if (!/^human:\S/.test(g.signedBy)) throw new CliError(EXIT.USAGE, 'GATE_UNSIGNED', 'signedBy must be human:<name>');
  const p = gatePath(campaignDir, 'G16_GOOGLE.json'); if (existsSync(p)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GATE_ALREADY_WRITTEN', p);
  writeJson(p, { schema: 'h2eval.gate.g16_google.v0', ...g }); return p;
}
/**
 * D144-03: Google is open ONLY with a signed G16-GOOGLE PASS whose four guarantees are all true.
 *
 * @param campaignDir - Campaign folder.
 * @returns `true` only for a signed PASS gate with all four guarantees true.
 */
export function g16GoogleOpen(campaignDir: string): boolean {
  const p = gatePath(campaignDir, 'G16_GOOGLE.json'); if (!existsSync(p)) return false;
  const g = readJson<GateG16Google>(p);
  return g.schema === 'h2eval.gate.g16_google.v0' && g.verdict === 'PASS' && g.dedicatedProjectAndBilling === true && g.effectiveExposureLimitVerified === true && g.billedOutputsAndReasoningVerified === true && g.credentialVerified === true && /^human:\S/.test(g.signedBy ?? '');
}
/**
 * VNEXT-3 R15-G-1: IMMUTABLE CAMPAIGN IDENTITY. `<campaignDir>/CAMPAIGN_IDENTITY.json` is created ONCE (random campaignId + studyId +
 * corpusSha256); its sha256 is pinned in every multi GO (`campaignIdentitySha256`) and the validator refuses a directory whose identity
 * differs (GO_CAMPAIGN_IDENTITY_MISMATCH) or has none (GO_CAMPAIGN_IDENTITY_MISSING). The same GO can therefore not execute twice in two
 * directories: a second directory initialised on its own gets another campaignId; a byte copy of the first carries its ledger and journals,
 * so the replay never resends. The identity is content, not a path: moving the directory keeps it.
 */
export const CAMPAIGN_IDENTITY_FILE = 'CAMPAIGN_IDENTITY.json';
/** Content of `CAMPAIGN_IDENTITY.json`: a random 128-bit campaign id (hex), the study id, the corpus hash, creation time and creator. */
export interface CampaignIdentity { schema: 'h2eval.campaign_identity.v1'; campaignId: string; studyId: string; corpusSha256: string; createdUtc: string; createdBy: string }
/**
 * Creates the campaign identity once and records it in the control registry; on later calls returns the existing one.
 *
 * @param campaignDir - Campaign folder (created when missing).
 * @param i - Study id, corpus hash (64 hex), optional creator (default `executor`), clock and control registry folder.
 * @returns The identity, the SHA-256 of its file and whether it was created now.
 * @throws {@link CliError} REFUSED_BY_POLICY `CAMPAIGN_IDENTITY_MISMATCH` when the folder belongs to another study or
 *   corpus; USAGE `CAMPAIGN_IDENTITY_INVALID` for a malformed corpus hash.
 */
export function initCampaignIdentity(campaignDir: string, i: { studyId: string; corpusSha256: string; createdBy?: string; now?: () => string; /** VNEXT-F (R17-V-1): control registry (default H2EVAL_CONTROL_DIR or ~/.otk-h2eval/control) */ controlDir?: string }): { identity: CampaignIdentity; sha256: string; created: boolean } {
  const fs = require('node:fs') as typeof import('node:fs'); const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const p = path.join(campaignDir, CAMPAIGN_IDENTITY_FILE);
  if (existsSync(p)) {
    const cur = readJson<CampaignIdentity>(p);
    if (cur.schema !== 'h2eval.campaign_identity.v1' || cur.studyId !== i.studyId || cur.corpusSha256 !== i.corpusSha256) throw new CliError(EXIT.REFUSED_BY_POLICY, 'CAMPAIGN_IDENTITY_MISMATCH', `${campaignDir} belongs to another study/corpus (identity is never rewritten)`);
    return { identity: cur, sha256: sha256File(p), created: false };
  }
  if (!/^[0-9a-f]{64}$/.test(i.corpusSha256)) throw new CliError(EXIT.USAGE, 'CAMPAIGN_IDENTITY_INVALID', 'corpusSha256 must be hex64');
  fs.mkdirSync(campaignDir, { recursive: true });
  const identity: CampaignIdentity = { schema: 'h2eval.campaign_identity.v1', campaignId: randomBytes(16).toString('hex'), studyId: i.studyId, corpusSha256: i.corpusSha256, createdUtc: (i.now ?? (() => new Date().toISOString()))(), createdBy: i.createdBy ?? 'executor' };
  fs.writeFileSync(p, JSON.stringify(identity, null, 1) + '\n', { flag: 'wx' });
  const sha = sha256File(p); writeCampaignControl(i.controlDir ?? controlDirDefault(), { campaignId: identity.campaignId, identitySha256: sha, campaignDirCanonical: canonicalPath(campaignDir), createdUtc: identity.createdUtc });
  return { identity, sha256: sha, created: true };
}
/**
 * SHA-256 of the campaign identity file.
 *
 * @param campaignDir - Campaign folder.
 * @returns Hex digest, or `null` when the folder has no identity.
 */
export const campaignIdentitySha256 = (campaignDir: string): string | null => (existsSync(path.join(campaignDir, CAMPAIGN_IDENTITY_FILE)) ? sha256File(path.join(campaignDir, CAMPAIGN_IDENTITY_FILE)) : null);
/**
 * VNEXT-F (R17-V-1): canonical absolute path (forward slashes; lower-cased drive letter on Windows).
 *
 * @param p - Any path.
 * @returns The canonical absolute path.
 */
export function canonicalPath(p: string): string { const r = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? r.replace(/^([A-Za-z]):/, (m) => m.toLowerCase()) : r; }
/** VNEXT-F (R17-V-1): CONTROL REGISTRY outside the campaign directory (fixed per machine: H2EVAL_CONTROL_DIR or ~/.otk-h2eval/control). One record per campaignId,
 * written once at init, binding the identity to its canonical path; a byte copy of the directory elsewhere, or a directory whose identity has no record here, is refused.
 *
 * @param env - Environment to read `H2EVAL_CONTROL_DIR` from; default `process.env`.
 * @returns The control registry folder.
 */
export const controlDirDefault = (env: NodeJS.ProcessEnv = process.env): string => (typeof env['H2EVAL_CONTROL_DIR'] === 'string' && env['H2EVAL_CONTROL_DIR'] !== '' ? env['H2EVAL_CONTROL_DIR'] : path.join((require('node:os') as typeof import('node:os')).homedir(), '.otk-h2eval', 'control'));
/** Control record of one campaign: id, SHA-256 of its identity file, canonical folder path and creation time. */
export interface CampaignControl { schema: 'h2eval.campaign_control.v1'; campaignId: string; identitySha256: string; campaignDirCanonical: string; createdUtc: string }
/**
 * Writes `<controlDir>/<campaignId>.json` (exclusive create: fails when it exists).
 *
 * @param controlDir - Control registry folder (created when missing).
 * @param c - Control record without the schema.
 * @returns Path of the written record.
 */
export function writeCampaignControl(controlDir: string, c: Omit<CampaignControl, 'schema'>): string {
  const fs = require('node:fs') as typeof import('node:fs'); fs.mkdirSync(controlDir, { recursive: true });
  const p = path.join(controlDir, `${c.campaignId}.json`); fs.writeFileSync(p, JSON.stringify({ schema: 'h2eval.campaign_control.v1', ...c }, null, 1) + '\n', { flag: 'wx' }); return p;
}
/**
 * Checks that a campaign folder has an identity, that the registry has its record, that the record matches the
 * identity file's hash and that the folder is the one recorded (path compared case-insensitively).
 *
 * @param campaignDir - Campaign folder.
 * @param controlDir - Control registry folder; default from {@link controlDirDefault}.
 * @returns `code: null` when everything matches, otherwise the mismatch code; `control` is the record when found.
 */
export function verifyCampaignControl(campaignDir: string, controlDir: string = controlDirDefault()): { code: 'CAMPAIGN_CONTROL_MISSING' | 'CAMPAIGN_CONTROL_IDENTITY_MISMATCH' | 'CAMPAIGN_CONTROL_DIR_MISMATCH' | 'CAMPAIGN_IDENTITY_MISSING' | null; control: CampaignControl | null } {
  const idp = path.join(campaignDir, CAMPAIGN_IDENTITY_FILE); if (!existsSync(idp)) return { code: 'CAMPAIGN_IDENTITY_MISSING', control: null };
  const id = readJson<CampaignIdentity>(idp); const cp = path.join(controlDir, `${id.campaignId}.json`); if (!existsSync(cp)) return { code: 'CAMPAIGN_CONTROL_MISSING', control: null };
  const c = readJson<CampaignControl>(cp);
  if (c.identitySha256 !== sha256File(idp)) return { code: 'CAMPAIGN_CONTROL_IDENTITY_MISMATCH', control: c };
  if (c.campaignDirCanonical.toLowerCase() !== canonicalPath(campaignDir).toLowerCase()) return { code: 'CAMPAIGN_CONTROL_DIR_MISMATCH', control: c };
  return { code: null, control: c };
}
/** VNEXT-F (R17-V-8): P1 gate — human verdict on the probe operation (acceptance of `thinking: disabled` on this account). */
export interface GateP1 { schema: 'h2eval.gate.p1.v0'; model: string; probeOperationId: string; verdict: 'PASS' | 'FAIL'; signedBy: string; atUtc: string; note?: string }
/**
 * File name of a model's probe gate.
 *
 * @param model - Model id.
 * @returns `P1_<model>.json`.
 */
export const p1FileOf = (model: string) => `P1_${model}.json`;
/**
 * Writes a model's signed probe gate (never overwritten).
 *
 * @param campaignDir - Campaign folder.
 * @param g - Gate content without the schema.
 * @returns Path of the written gate.
 * @throws {@link CliError} USAGE when unsigned, the verdict is not PASS or FAIL, or the probe id is not 64 hex;
 *   REFUSED_BY_POLICY when the gate already exists.
 */
export function writeGateP1(campaignDir: string, g: Omit<GateP1, 'schema'>): string {
  if (!/^human:\S/.test(g.signedBy)) throw new CliError(EXIT.USAGE, 'GATE_UNSIGNED', 'signedBy must be human:<name>');
  if (!['PASS', 'FAIL'].includes(g.verdict)) throw new CliError(EXIT.USAGE, 'GATE_VERDICT', 'PASS|FAIL');
  if (!/^[0-9a-f]{64}$/.test(g.probeOperationId)) throw new CliError(EXIT.USAGE, 'GATE_PROBE_ID', 'probeOperationId must be hex64');
  const p = path.join(campaignDir, 'gates', p1FileOf(g.model)); if (existsSync(p)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GATE_ALREADY_WRITTEN', p);
  writeJson(p, { schema: 'h2eval.gate.p1.v0', ...g }); return p;
}
/**
 * Reads a model's probe gate.
 *
 * @param campaignDir - Campaign folder.
 * @param model - Model id.
 * @param probeOperationId - The probe operation the gate must name.
 * @returns The verdict; `MISSING` when absent, of another schema or unsigned; `WRONG_PROBE` when it names another
 *   operation.
 */
export function p1Verdict(campaignDir: string, model: string, probeOperationId: string): 'PASS' | 'FAIL' | 'MISSING' | 'WRONG_PROBE' {
  const p = path.join(campaignDir, 'gates', p1FileOf(model)); if (!existsSync(p)) return 'MISSING';
  const g = readJson<GateP1>(p); if (g.schema !== 'h2eval.gate.p1.v0' || !/^human:\S/.test(g.signedBy ?? '')) return 'MISSING';
  if (g.probeOperationId !== probeOperationId) return 'WRONG_PROBE'; return g.verdict;
}

/** Anti-replay registry: a batch, once started under a GO nonce, can only be continued (journal replay) under the SAME nonce; a nonce never serves two batches. */
type NonceRow = { batchId: string; nonce: string; goDigestSha256: string; campaignIdentitySha256?: string };
const nonceRows = (campaignDir: string): NonceRow[] => { const p = path.join(campaignDir, 'go_nonces.jsonl'); return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as NonceRow) : []; };
/**
 * VNEXT-3 R15-G-2: PURE check (no write). Called before a batch; the row is written only by `commitNonce`, after the batch's first PLANNED.
 *
 * @param campaignDir - Campaign folder (reads `go_nonces.jsonl`).
 * @param batchId - Batch about to run.
 * @param nonce - Nonce of the GO.
 * @returns `NEW` when the batch was never started, `SAME` when it was started under this nonce.
 * @throws {@link CliError} REFUSED_BY_POLICY when the batch was started under another nonce, or the nonce was used for
 *   another batch.
 */
export function checkNonce(campaignDir: string, batchId: string, nonce: string): 'NEW' | 'SAME' {
  const rows = nonceRows(campaignDir); const sameBatch = rows.filter((r) => r.batchId === batchId);
  if (sameBatch.length && sameBatch.some((r) => r.nonce !== nonce)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GO_NONCE_MISMATCH_FOR_STARTED_BATCH', `${batchId} was started under another GO nonce; a new GO cannot reopen it (replay happens only under the same nonce)`);
  if (rows.some((r) => r.nonce === nonce && r.batchId !== batchId)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GO_NONCE_REUSED', `nonce already used for another batch`);
  return sameBatch.length ? 'SAME' : 'NEW';
}
/**
 * Appends the row (idempotent for the same batch+nonce). A batch that never reached PLANNED (gate missing, refusal) leaves NO row and may run later under another GO.
 *
 * @param campaignDir - Campaign folder.
 * @param batchId - Batch.
 * @param nonce - Nonce of the GO.
 * @param goDigestSha256 - SHA-256 of the GO.
 * @param campaignIdentitySha256 - SHA-256 of the campaign identity, when known.
 * @returns `NEW` when a row was appended, `SAME` when it already existed.
 * @throws {@link CliError} REFUSED_BY_POLICY in the cases of {@link checkNonce}.
 */
export function commitNonce(campaignDir: string, batchId: string, nonce: string, goDigestSha256: string, campaignIdentitySha256?: string): 'NEW' | 'SAME' {
  if (checkNonce(campaignDir, batchId, nonce) === 'SAME') return 'SAME';
  const { appendFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs'); mkdirSync(campaignDir, { recursive: true });
  appendFileSync(path.join(campaignDir, 'go_nonces.jsonl'), JSON.stringify({ batchId, nonce, goDigestSha256, campaignIdentitySha256: campaignIdentitySha256 ?? null, startedUtc: new Date().toISOString() }) + '\n'); return 'NEW';
}
/** Pre-VNEXT behaviour (check + immediate commit); kept for callers outside run-authorized. */
/**
 * Checks the nonce and records it at once (the older behaviour, without waiting for the first PLANNED line).
 *
 * @param campaignDir - Campaign folder.
 * @param batchId - Batch.
 * @param nonce - Nonce of the GO.
 * @param goDigestSha256 - SHA-256 of the GO.
 * @returns `NEW` or `SAME`, as {@link commitNonce}.
 */
export function registerNonce(campaignDir: string, batchId: string, nonce: string, goDigestSha256: string): 'NEW' | 'SAME' { return commitNonce(campaignDir, batchId, nonce, goDigestSha256, campaignIdentitySha256(campaignDir) ?? undefined); }
/**
 * VNEXT-3 R15-G-4: attempts already SPENT in the scope = SENT lines in the journals of the scoped batches (survives restarts).
 *
 * @param campaignDir - Campaign folder.
 * @param batchIds - Batches in the scope of the GO.
 * @returns Number of SENT journal lines across those batches (unparsable lines are skipped).
 */
export function countSentInScope(campaignDir: string, batchIds: readonly string[]): number {
  let n = 0;
  for (const b of batchIds) { const jp = path.join(campaignDir, 'batches', b, 'journal.jsonl'); if (!existsSync(jp)) continue; for (const l of readFileSync(jp, 'utf8').split('\n')) { if (!l) continue; try { if ((JSON.parse(l) as { kind?: string }).kind === 'SENT') n += 1; } catch { /* a partial last line is refused later by the journal itself */ } } }
  return n;
}

/**
 * Lists the file names in `<campaignDir>/gates/`.
 *
 * @param campaignDir - Campaign folder.
 * @returns File names, or an empty list when the folder does not exist.
 */
export const listGateFiles = (campaignDir: string): string[] => (existsSync(path.join(campaignDir, 'gates')) ? readdirSync(path.join(campaignDir, 'gates')) : []);
/**
 * Reads and parses a gate file (no validation).
 *
 * @param campaignDir - Campaign folder.
 * @param name - Gate file name.
 * @returns The parsed content.
 */
export const readGate = <T>(campaignDir: string, name: string): T => JSON.parse(readFileSync(path.join(campaignDir, 'gates', name), 'utf8')) as T;
