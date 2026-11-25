/**
 * R15 `run --mode offline|real`: executes ONE batch of a plan through the integrated executor (scripts/h2eval/index.ts).
 *   offline: the simulated provider (cli/offlineProvider.ts) is the only executable mode.
 *   real   : fail-closed. Before anything is constructed: explicit --real flag, plan ratified, GO file (h2eval.go.v1) present and
 *            valid for THIS batch/model/executor sha/ratified hash/window, credential env var PRESENT (never read here), forbidden env
 *            absent. Any miss ⇒ exit 6 with a code, no executor, no socket. Google is NOT_RUN_BRANCH_LOCKED unless its own GO opens it.
 * Serial loop over the batch; the first stop reason ends the batch (R10 R2 §5: STOP/ISOLATE, never retry).
 *
 * Also implements the authorized multi-batch command ({@link runAuthorized}): several batches of one plan under one multi-batch GO, in
 * series, with the campaign lock, nonce registry, signed gates and the stop policy {@link STOP_POLICY}. Called by the
 * CLI entry point (`./main.ts`). Side effects: in real mode it sends provider calls and spends money (within the
 * ledger caps); in both modes it writes the batch journal, ledger, snapshots and records through the executor, plus
 * `run_summary.<ms>.json` and `authorized_run.<ms>.json`. Environment: reads only variable names and the path-like
 * settings listed in `H2EVAL_ENV_NAMES` (`../core/egress.ts`), through `envPresence` in `./common.ts`.
 *
 * @module scripts/h2eval/cli/run
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createH2EvalExecutor, EXECUTOR_VERSION, validateGoV1, loadE3GPriceTable, type H2EvalExecutor } from '../index.js';
import { isArmModel, E3G_LEDGER_FILE } from '../core/e3gArm.js';
import type { GoFileV1 } from '../core/egress.js';
import { createContentStore } from '../cache/contentStore.js';
import { H2EVAL_ENV_NAMES } from '../core/egress.js';
import type { RunnerResult, Provider } from '../types.js';
import { createOfflineProvider, type OfflineProviderConfig } from './offlineProvider.js';
import { CliError, EXIT, REPO_ROOT, acquireDirLock, envPresence, executorIdentity, loadTextCounters, writeJson, type Args } from './common.js';
import { MATRIX_TO_ENCODING } from './common.js';
import type { ForecastFrozen } from '../record/forecast.js';
import { readPlan, type BatchPlan, type PlannedBatch } from './plan.js';
import { gateFor, predictorFrom, g17Verdict, g16GoogleOpen, checkNonce, commitNonce, campaignIdentitySha256, countSentInScope, canonicalPath, verifyCampaignControl, controlDirDefault, p1Verdict } from './campaign.js';
import { CampaignJournalError } from './preflight.js';
import { validateGoMultiV1, type GoFileMultiV1 } from '../core/egress.js';
import { validateModelProbeConfig, type ModelProbeConfig } from '../core/modelProbe.js';
import { POLICY_ID_LIST, reservePolicyMismatches, type InputReserveChoice, type InputReservePolicyId } from '../core/inputReserve.js';
import { LedgerReconciliationError, BatchLockedError, UncertainAckError, validateUncertainAckShape, type PauseAck, type UncertainAck } from '../core/runner.js';
import { JournalIntegrityError } from '../core/journal.js';
import { validateLedgerOpening, LedgerOpeningError, type LedgerOpening } from '../core/ledger.js';
import type { PrecallSnapshot } from '../types.js';
import { readdirSync } from 'node:fs';
import { envFingerprint, preflightGate } from './preflight.js';

/**
 * Options of {@link runBatch}: the plan file, batch id and batch folder, optional corpus folder (default: the plan's),
 * mode, the `--real` flag and GO file for real runs, the executor commit, and the campaign-level hooks described per
 * field below. `now` returns milliseconds since the epoch.
 */
export interface RunOptions {
  planFile: string; batchId: string; batchDir: string; corpusDir?: string; mode: 'offline' | 'real'; realFlag?: boolean; goFile?: string;
  executorCodeSha: string; /** R15-P2-1: git identity of the checkout (default: read from REPO_ROOT); REAL requires sha == executorCodeSha and a clean tree */ identity?: { sha: string; clean: boolean }; offline?: OfflineProviderConfig; /** OFFLINE only: operator's signed acknowledgement of the 80 % pause (`human:<name>`); REAL takes it from the GO */ ackBy?: string; stopFile?: string; now?: () => number;
  /** REAL only: injected for tests of the refusal path; never reached without full preconditions */
  env?: NodeJS.ProcessEnv;
  /** R18–R20: campaign directory holding gates/ (code lock train → validation → holdout). Required for CAMPAIGN plans. */
  campaignDir?: string;
  /** C144 D144-04: shared STUDY ledger path (default <campaignDir>/ledger.jsonl when campaignDir is given, else <batchDir>/ledger.jsonl); reconciled with every journal under <campaignDir>/batches. */
  ledgerPath?: string;
  /** C144 (set by run-authorized from the multi GO): signed acknowledgements / pre-authorisations, scope-remaining worst case, attempts budget, unlocked providers, multi-GO egress context. */
  pauseAck?: readonly PauseAck[]; preAuthorizedTo100?: readonly PauseAck[]; remainingScopeCapPico?: (p: Provider) => bigint; attemptsBudget?: { max: number; used: () => number; onSend: () => void }; lockedProviders?: readonly Provider[];
  goMulti?: { planProtocolHash: string; planBatchIds: readonly string[]; plannedOpsInScope: (ids: readonly string[]) => number; providersUsd: Record<Provider, string>; campaignUsd: string; treeClean: boolean | null; campaignIdentitySha256: string | null; campaignDirCanonical: string | null };
  /** VNEXT-F: admission hook forwarded to the executor (P1 probe gate, isolated conditions). */
  admit?: import('../core/runner.js').ExecutorConfig['admit'];
  /** VNEXT-3 R15-G-2: journal observer handed to the executor (nonce commit on first PLANNED). */
  onJournal?: (line: import('../types.js').JournalLine) => void;
  /** VNEXT-5: explicit opening (default: <campaignDir>/LEDGER_OPENING.json when present). */
  ledgerOpening?: LedgerOpening;
  /** VNEXT-8 (B06 R17-C2-1): preflight age judged at this instant (run-authorized start). */
  preflightNowMs?: number;
  /** C158 cycle 2: HUMAN acknowledgements of uncertain operations (resume after an uncertain operation). Acks of other batches are ignored unless ackUncertainStrict. */
  ackUncertain?: readonly UncertainAck[]; ackUncertainStrict?: boolean;
  /** C158 §3.2: conservative input reserve policy as a pre-send gate (default: none = not active). Can only make the executor stop earlier. */
  inputReservePolicy?: InputReserveChoice;
  /** C158: automatic probe of a new model / unmeasured length region (default: none = not active). Only ever stops earlier. */
  modelProbe?: ModelProbeConfig;
}
/** File name of the signed opening balance inside a campaign folder. */
export const LEDGER_OPENING_FILE = 'LEDGER_OPENING.json';
/**
 * VNEXT-5: the signed opening balance of the study, if the campaign directory carries one (validated: schema, human signature, digest).
 *
 * @param campaignDir - Campaign folder, or `undefined`.
 * @returns The validated opening, or `undefined` when there is no folder or no file.
 * @throws {@link CliError} REFUSED_BY_POLICY when the file exists but is invalid (the validator's code, or
 *   `LEDGER_OPENING_INVALID`).
 */
export function readLedgerOpening(campaignDir: string | undefined): LedgerOpening | undefined {
  if (!campaignDir) return undefined; const p = path.join(campaignDir, LEDGER_OPENING_FILE); if (!existsSync(p)) return undefined;
  try { return validateLedgerOpening(JSON.parse(readFileSync(p, 'utf8'))); } catch (e) { throw new CliError(EXIT.REFUSED_BY_POLICY, e instanceof LedgerOpeningError ? e.code : 'LEDGER_OPENING_INVALID', p); }
}
/**
 * Summary of one batch run: mode, planned and executed counts (replayed operations not counted as executed), one
 * result per operation reached, the stop reason (`null` when the batch finished), the ledger state, the executor
 * version and commit, and the simulated provider's log in offline mode.
 */
export interface RunSummary { schema: 'h2eval.run_summary.v0'; batchId: string; mode: 'OFFLINE' | 'REAL'; planned: number; executed: number; results: Array<RunnerResult & { model: string }>; stoppedBy: string | null; ledger: unknown; executorVersion: string; executorCodeSha: string; offlineLog?: unknown }

/**
 * Finds a batch in a plan.
 *
 * @param plan - The plan.
 * @param batchId - Batch id.
 * @returns The batch.
 * @throws {@link CliError} USAGE `BATCH_NOT_IN_PLAN` when the id is not in the plan.
 */
export function selectBatch(plan: BatchPlan, batchId: string): PlannedBatch { const b = plan.batches.find((x) => x.batchId === batchId); if (!b) throw new CliError(EXIT.USAGE, 'BATCH_NOT_IN_PLAN', batchId); return b; }

/**
 * REAL preconditions, evaluated BEFORE any executor exists. Returns the list of failing codes (empty = may proceed to the executor's own preflight).
 *
 * Reads the GO file and, with a campaign folder, the campaign journal; never reads a credential value.
 *
 * @param plan - The plan.
 * @param batch - The batch about to run (its provider and model are checked against the GO).
 * @param o - The `--real` flag, GO file (default from the environment), executor commit, environment, clock in
 *   milliseconds, git identity, campaign folder and the instant the preflight age is judged at.
 * @returns Failing codes such as `REAL_FLAG_MISSING`, `PLAN_NOT_RATIFIED`, `GO_FILE_MISSING`; empty when all hold.
 */
export function realPreconditions(plan: BatchPlan, batch: PlannedBatch, o: { realFlag?: boolean; goFile?: string; executorCodeSha: string; env?: NodeJS.ProcessEnv; nowMs?: number; identity?: { sha: string; clean: boolean }; /** CYCLE2-B: when given, the credential-less preflight of the batch provider must be PASS, fresh and from the same env shape */ campaignDir?: string; /** VNEXT-8 (B06 R17-C2-1): the instant the preflight age is judged against — run-authorized passes its START time so a long series never goes STALE mid-campaign */ preflightNowMs?: number }): string[] {
  const codes: string[] = [];
  const env = envPresence(o.env);
  if (o.campaignDir) { try { const pf = preflightGate(o.campaignDir, batch.provider, { envFingerprint: envFingerprint(o.env ?? process.env), nowMs: o.preflightNowMs ?? o.nowMs ?? Date.now() }); if (pf) codes.push(`${pf}:${batch.provider}`); } catch (e) { codes.push(e instanceof CampaignJournalError ? e.code : 'CAMPAIGN_JOURNAL_ERROR'); } } // VNEXT-F (R17-V-9): own code
  // VNEXT-4: the launch environment must be the documented explicit list (names only)
  if (env.unlisted.length) codes.push(`LAUNCH_ENV_UNLISTED:${env.unlisted.slice(0, 12).join(',')}${env.unlisted.length > 12 ? ',…' : ''}`);
  if (o.realFlag !== true) codes.push('REAL_FLAG_MISSING');
  // R15-P2-1: the GO's codeSha must be the checked-out HEAD of a CLEAN tree (never a typed value)
  if (o.identity !== undefined) { if (o.identity.sha !== o.executorCodeSha) codes.push('EXECUTOR_SHA_NOT_HEAD'); if (!o.identity.clean) codes.push('EXECUTOR_TREE_DIRTY'); }
  if (!plan.preregistration.ratified || !plan.preregistration.ratifiedSha256) codes.push('PLAN_NOT_RATIFIED');
  if (env.forbiddenPresent.length) codes.push(`FORBIDDEN_ENV_PRESENT:${env.forbiddenPresent.join(',')}`);
  if (env.credentials[batch.provider] && env.envFile) codes.push('CREDENTIAL_SOURCE_AMBIGUOUS');
  if (!env.credentials[batch.provider] && !env.envFile) codes.push(`CREDENTIAL_ENV_MISSING:${H2EVAL_ENV_NAMES.credentials[batch.provider]} (or ${H2EVAL_ENV_NAMES.envFile})`);
  const go = o.goFile ?? env.goFile;
  if (!go) codes.push('GO_FILE_MISSING');
  else if (!existsSync(go)) codes.push('GO_FILE_NOT_FOUND');
  else {
    const first = batch.operations[0]?.plan;
    const text = readFileSync(go, 'utf8'); let schema = ''; try { schema = String((JSON.parse(text) as { schema?: string }).schema ?? ''); } catch { codes.push('GO_FILE_INVALID'); return codes; }
    if (schema === 'h2eval.go.multi.v1') { const code = validateGoMultiV1(text, { campaign: plan.studyId, preregistrationSha256: plan.preregistration.ratifiedSha256 ?? undefined, executorCodeSha: o.executorCodeSha, treeClean: o.identity?.clean ?? null, planProtocolHash: plan.protocolHash, planBatchIds: plan.batches.map((b) => b.batchId), plannedOpsInScope: (ids) => plan.batches.filter((b) => ids.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), ledgerCaps: { campaignUsd: plan.policy.capsUsd.campaign, providersUsd: plan.policy.capsUsd.providers }, nowMs: o.nowMs ?? Date.now(), campaignIdentitySha256: o.campaignDir ? campaignIdentitySha256(o.campaignDir) : null, campaignDirCanonical: o.campaignDir ? canonicalPath(o.campaignDir) : null }); if (code) codes.push(code); return codes; }
    const code = validateGoV1(text, { provider: batch.provider, phase: first?.phase ?? plan.phase, modelRequested: batch.model, batchId: batch.batchId, executorVersion: EXECUTOR_VERSION, executorCodeSha: o.executorCodeSha, preregistrationSha256: plan.preregistration.ratifiedSha256 ?? undefined, campaign: plan.studyId, nowMs: o.nowMs ?? Date.now(), ledgerCaps: { campaignUsd: plan.policy.capsUsd.campaign, providerUsd: plan.policy.capsUsd.providers[batch.provider] }, batchCapUsd: picoToUsd(batch.batchCapUsdPico) });
    if (code) codes.push(code);
  }
  return codes;
}

/** C158 cycle 2: shape check (refuses without a "human:" signature, the operation id and the authorising text) + only the acknowledgements that belong to this batch. */
/**
 * Validates every uncertain-operation acknowledgement and keeps those of this batch.
 *
 * @param o - Run options (acknowledgements and strict flag).
 * @param ops - Operations of the batch, keyed by operation id.
 * @returns The acknowledgements whose operation is in this batch.
 * @throws {@link CliError} REFUSED_BY_POLICY for a malformed acknowledgement, or (strict mode) one for another batch.
 */
function uncertainAckFor(o: RunOptions, ops: ReadonlyMap<string, unknown>): UncertainAck[] {
  const all = o.ackUncertain ?? [];
  for (const a of all) { try { validateUncertainAckShape(a); } catch (e) { throw new CliError(EXIT.REFUSED_BY_POLICY, e instanceof UncertainAckError ? e.code : 'UNCERTAIN_ACK_INVALID', e instanceof Error ? e.message : String(e)); } }
  if (o.ackUncertainStrict) for (const a of all) if (!ops.has(a.operationId)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'UNCERTAIN_ACK_NOT_IN_BATCH', a.operationId.slice(0, 12));
  return all.filter((a) => ops.has(a.operationId));
}
/**
 * Runs one batch of a plan, operation by operation, until it ends or a stop reason appears.
 *
 * @param o - Run options.
 * @returns The run summary, also written to `<batchDir>/run_summary.<ms>.json`.
 * @throws {@link CliError} USAGE when the batch, campaign folder or corpus content is missing; REFUSED_BY_POLICY when
 *   a split gate refuses the batch, an uncertain-operation acknowledgement is invalid, the ledger opening is invalid
 *   or the input reserve policy is undeclared in real mode; REAL_PRECONDITIONS when a real-run precondition fails;
 *   PLAN_INVALID when an operation is not in the batch.
 */
export async function runBatch(o: RunOptions): Promise<RunSummary> {
  const plan = readPlan(o.planFile);
  const batch = selectBatch(plan, o.batchId);
  // R18–R20 code lock: validation needs TRAIN_FROZEN, holdout needs VALIDATION_SELECTED (same protocolHash); the prediction for holdout is pinned here
  let predictor: ReturnType<typeof predictorFrom> | undefined; let forecastTable: ForecastFrozen | null = null; let gateUsed: PrecallSnapshot['gateUsed'] = null;
  if (plan.phase === 'CONFIRMATORY') {
    if (!o.campaignDir) throw new CliError(EXIT.USAGE, 'CAMPAIGN_DIR_REQUIRED', '--campaign-dir <dir> (holds gates/)');
    const g = gateFor(plan, batch, o.campaignDir);
    if (g.code) throw new CliError(EXIT.REFUSED_BY_POLICY, g.code, `${batch.batchId} (${batch.block}) requires ${g.required}`);
    if (g.selection) predictor = predictorFrom(g.selection);
    forecastTable = g.forecastFrozen; gateUsed = g.gateUsed; // validation: table frozen on train; holdout: table of the selection; train: none (NAO_REGISTRADA)
  }
  const counters = loadTextCounters(); const textTokenCounter = counters ? counters[MATRIX_TO_ENCODING[batch.model]] : undefined;
  // C144 D144-04: ONE study ledger for pilot + campaign (aggregated 11/5/3/3), reconciled with every journal of the study
  // E3G (C160 BRACO-GO): an arm batch (gemini-3.1-flash-lite / gpt-6-luna) uses its OWN ledger file per provider (ledger.<provider>.jsonl) and the attested arm price table; every other batch is unchanged
  const arm = isArmModel(batch.model);
  const ledgerPath = o.ledgerPath ?? (arm ? path.join(o.campaignDir ?? o.batchDir, E3G_LEDGER_FILE(batch.provider as Provider)) : o.campaignDir ? path.join(o.campaignDir, 'ledger.jsonl') : undefined);
  const journals = o.campaignDir && existsSync(path.join(o.campaignDir, 'batches')) ? readdirSync(path.join(o.campaignDir, 'batches')).map((b) => path.join(o.campaignDir!, 'batches', b, 'journal.jsonl')).filter((p) => existsSync(p)) : [];
  const corpusDir = o.corpusDir ?? plan.corpus.dir;
  if (!existsSync(path.join(corpusDir, 'content'))) throw new CliError(EXIT.USAGE, 'CORPUS_CONTENT_MISSING', path.join(corpusDir, 'content'));
  const capById = new Map(batch.operations.map((op) => [op.operationId, op]));
  const common = {
    batchDir: o.batchDir, contentStore: createContentStore(corpusDir), executorCodeSha: o.executorCodeSha, stopFile: o.stopFile,
    ledger: { campaignUsd: plan.policy.capsUsd.campaign, providersUsd: plan.policy.capsUsd.providers, batchesUsd: { [batch.batchId]: picoToUsd(batch.batchCapUsdPico) } },
    capPolicy: { inputUpperBoundTokens: (p: { protocolHash: string; cellId: string; promptId: string; rep: number; modelRequested: string }) => { const op = capById.get(idOf(p)); if (!op) throw new CliError(EXIT.PLAN_INVALID, 'OPERATION_NOT_IN_BATCH', idOf(p)); return op.inputUpperBoundTokens; }, reasoningAllowanceTokens: (p: { protocolHash: string; cellId: string; promptId: string; rep: number; modelRequested: string }) => capById.get(idOf(p))?.reasoningAllowanceTokens ?? 0 },
    maxBatchCalls: plan.policy.maxCallsPerBatch, consecutiveFailureStop: 2, predictor, forecastTable, textTokenCounter, gateUsed,
    ledgerPath, reconcileJournalPaths: journals, preAuthorizedTo100: o.preAuthorizedTo100, remainingScopeCapPico: o.remainingScopeCapPico, attemptsBudget: o.attemptsBudget, lockedProviders: o.lockedProviders, onJournal: o.onJournal,
    ledgerOpening: o.ledgerOpening ?? readLedgerOpening(o.campaignDir), integrity: plan.policy.design?.integrity, admit: o.admit,
    uncertainAck: uncertainAckFor(o, capById), inputReservePolicy: o.inputReservePolicy, modelProbe: o.modelProbe,
    ...(arm ? { prices: loadE3GPriceTable() } : {}),
  };
  const operatorAck: PauseAck[] = [...(o.pauseAck ?? []), ...(o.mode === 'offline' && o.ackBy && /^human:\S/.test(o.ackBy) ? [{ provider: batch.provider as Provider, acknowledgedBy: o.ackBy, source: 'operator' as const, reference: 'cli --ack-80pct' }] : [])];
  let ex: H2EvalExecutor; let offline: ReturnType<typeof createOfflineProvider> | null = null;
  if (o.mode === 'offline') {
    offline = createOfflineProvider(o.offline);
    ex = createH2EvalExecutor({ ...common, pauseAck: operatorAck, egress: { mode: 'OFFLINE', campaign: plan.studyId, allowedHosts: ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'], double: offline.double, timeoutMs: o.offline?.timeoutMs, goMulti: o.goMulti } });
  } else {
    const failing = realPreconditions(plan, batch, { realFlag: o.realFlag, goFile: o.goFile, executorCodeSha: o.executorCodeSha, env: o.env, nowMs: o.now?.(), identity: o.identity ?? executorIdentity(REPO_ROOT), campaignDir: o.campaignDir, preflightNowMs: o.preflightNowMs });
    if (failing.length) throw new CliError(EXIT.REAL_PRECONDITIONS, 'REAL_PRECONDITIONS_FAILED', failing.join('; '));
    requireDeclaredReservePolicy(o.inputReservePolicy);
    // Every precondition holds: the executor still runs its own preflight per operation (GO per provider, host allowlist, credential at send time).
    const goPath = o.goFile ?? envPresence(o.env).goFile!;
    const go = JSON.parse(readFileSync(goPath, 'utf8')) as GoFileV1; // already validated by realPreconditions
    const goAck = go.pauseAck80pct && !('schema' in go && (go as unknown as { schema: string }).schema === 'h2eval.go.multi.v1') ? [{ provider: batch.provider as Provider, acknowledgedBy: go.pauseAck80pct.acknowledgedBy, source: 'go' as const, reference: `go:${go.goDigestSha256.slice(0, 16)}` }] : [...(o.pauseAck ?? [])];
    ex = createH2EvalExecutor({ ...common, pauseAck: goAck, egress: { mode: 'REAL', realFlag: true, goFile: goPath, campaign: plan.studyId, allowedHosts: ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'], preregistrationSha256: plan.preregistration.ratifiedSha256 ?? undefined, envFile: envPresence(o.env).envFile ?? undefined, goMulti: o.goMulti } });
  }
  const results: RunSummary['results'] = []; let stoppedBy: string | null = null;
  try {
    for (const op of batch.operations) {
      const r = await ex.run(op.plan);
      results.push({ ...r, model: op.plan.modelRequested });
      if (r.stop) { stoppedBy = r.stop; break; }
      if (r.state === 'NOT_RUN_BRANCH_LOCKED') { stoppedBy = 'NOT_RUN_BRANCH_LOCKED'; break; }
    }
  } finally { ex.close(); }
  const summary: RunSummary = { schema: 'h2eval.run_summary.v0', batchId: batch.batchId, mode: ex.mode, planned: batch.operations.length, executed: results.filter((r) => !r.replayed).length, results, stoppedBy, ledger: ex.ledger.state(), executorVersion: EXECUTOR_VERSION, executorCodeSha: o.executorCodeSha, offlineLog: offline?.log };
  writeJson(path.join(o.batchDir, `run_summary.${Date.now()}.json`), summary);
  return summary;
}

const idOf = (p: { protocolHash: string; cellId: string; promptId: string; rep: number; modelRequested: string }): string => { const { operationIdOf } = idsSync(); return operationIdOf(p); };
import { operationIdOf as _opId } from '../core/ids.js';
const idsSync = () => ({ operationIdOf: _opId });
const picoToUsd = (pico: string): string => { const p = BigInt(pico); const PICO = 1_000_000_000_000n; return `${p / PICO}.${(p % PICO).toString().padStart(12, '0')}`; };

/**
 * C158 cycle 2: resume after an UNCERTAIN operation needs a HUMAN act of the author/designated operator (never the coordinator session on its own):
 * --ack-uncertain <operationId> --ack-uncertain-by human:<name> --ack-uncertain-ref "<text/order that authorises>". The uncertain operation is NEVER resent; the ack only releases the next ones.
 */
/** C158 §3.2: --input-reserve-policy R-A-1.03|R-A-1.05 [--input-reserve-outside STOP|ALLOW]. Absent => no policy (not active). Anything else is refused. */
/**
 * Reads the input reserve policy from `--input-reserve-policy` and `--input-reserve-outside`.
 *
 * @param get - Reads a string option by name.
 * @returns The policy choice (`none`, or an id with the outside-range behaviour, default STOP), or `undefined` when
 *   no policy flag was given.
 * @throws {@link CliError} USAGE for an unknown policy, an invalid outside value, or the outside flag without a policy.
 */
export function inputReservePolicyFromArgs(get: (k: string) => string | undefined): InputReserveChoice | undefined {
  const id = get('input-reserve-policy'); const outside = get('input-reserve-outside');
  if (id === 'none') { if (outside) throw new CliError(EXIT.USAGE, 'INPUT_RESERVE_OUTSIDE_WITHOUT_POLICY', '--input-reserve-outside is meaningless with --input-reserve-policy none'); return 'none'; }
  if (!id) { if (outside) throw new CliError(EXIT.USAGE, 'INPUT_RESERVE_OUTSIDE_WITHOUT_POLICY', '--input-reserve-outside needs --input-reserve-policy'); return undefined; }
  if (!(POLICY_ID_LIST as readonly string[]).includes(id)) throw new CliError(EXIT.USAGE, 'INPUT_RESERVE_POLICY_UNKNOWN', `--input-reserve-policy ${POLICY_ID_LIST.join('|')}|none`);
  if (outside && outside !== 'STOP' && outside !== 'ALLOW') throw new CliError(EXIT.USAGE, 'INPUT_RESERVE_OUTSIDE', '--input-reserve-outside STOP|ALLOW');
  return { id: id as InputReservePolicyId, outsideMeasuredRange: (outside as 'STOP' | 'ALLOW' | undefined) ?? 'STOP' };
}
/**
 * MET-02 R4(a): in REAL the choice is explicit: a policy or a deliberate `none` (journaled in every RESERVED). Forgetting the flag is refused, never a silent off.
 *
 * @param choice - The parsed choice, or `undefined` when the flag was not given.
 * @throws {@link CliError} REFUSED_BY_POLICY `INPUT_RESERVE_POLICY_UNDECLARED` when `choice` is `undefined`.
 */
export function requireDeclaredReservePolicy(choice: InputReserveChoice | undefined): void {
  if (choice === undefined) throw new CliError(EXIT.REFUSED_BY_POLICY, 'INPUT_RESERVE_POLICY_UNDECLARED', 'REAL needs an explicit --input-reserve-policy R-A-1.03|R-A-1.05 or a deliberate none (journaled as reservePolicy in every RESERVED)');
}
/** C158: --model-probe-max-ratio <n> (n in [1,10]). Absent => the probe is not active. No default: the limit is the operator's number. */
/**
 * Reads the model probe limit from `--model-probe-max-ratio`.
 *
 * @param get - Reads a string option by name.
 * @returns The probe configuration, or `undefined` when the flag is absent.
 * @throws {@link CliError} USAGE `MODEL_PROBE_RATIO` when the value is empty or outside the accepted range.
 */
export function modelProbeFromArgs(get: (k: string) => string | undefined): ModelProbeConfig | undefined {
  const v = get('model-probe-max-ratio'); if (v === undefined) return undefined;
  const n = Number(v); const cfg = { maxMeasuredToEstimatedRatio: n };
  try { if (v.trim() === '') throw new RangeError('empty'); validateModelProbeConfig(cfg); } catch (e) { throw new CliError(EXIT.USAGE, 'MODEL_PROBE_RATIO', `--model-probe-max-ratio <number between 1 and 10>: ${e instanceof Error ? e.message : String(e)}`); }
  return cfg;
}
/**
 * Reads the human acknowledgement of an uncertain operation from `--ack-uncertain`, `--ack-uncertain-by` and
 * `--ack-uncertain-ref` (all three or none). The acknowledged operation is never resent; the acknowledgement only
 * lets the following operations run.
 *
 * @param get - Reads a string option by name.
 * @returns One acknowledgement, or an empty list when none of the three flags is given.
 * @throws {@link CliError} REFUSED_BY_POLICY `UNCERTAIN_ACK_INCOMPLETE` when only some of the flags are given.
 */
export function uncertainAckFromArgs(get: (k: string) => string | undefined): UncertainAck[] {
  const op = get('ack-uncertain'); const by = get('ack-uncertain-by'); const ref = get('ack-uncertain-ref');
  if (!op && !by && !ref) return [];
  if (!op || !by || !ref) throw new CliError(EXIT.REFUSED_BY_POLICY, 'UNCERTAIN_ACK_INCOMPLETE', '--ack-uncertain <operationId> --ack-uncertain-by human:<name> --ack-uncertain-ref "<text/order that authorises>"');
  return [{ operationId: op, acknowledgedBy: by, authority: ref }];
}
/**
 * Runs the `run` command from parsed arguments; the batch folder, GO file and stop file fall back to the environment
 * settings when the flags are absent.
 *
 * @param a - Parsed arguments.
 * @param opts - The executor commit (already checked against git HEAD).
 * @returns The run summary.
 * @throws {@link CliError} USAGE when the mode or a required argument is missing; otherwise as {@link runBatch}.
 */
export function runFromArgs(a: Args, opts: { executorCodeSha: string }): Promise<RunSummary> {
  const get = (k: string) => (typeof a.opts[k] === 'string' ? (a.opts[k] as string) : undefined);
  const mode = get('mode'); if (mode !== 'offline' && mode !== 'real') throw new CliError(EXIT.USAGE, 'MODE', '--mode offline|real');
  const planFile = get('plan'); const batchId = get('batch'); const batchDir = get('batch-dir') ?? envPresence().batchDir ?? undefined;
  if (!planFile || !batchId || !batchDir) throw new CliError(EXIT.USAGE, 'ARGS', '--plan <plan.json> --batch <batchId> --batch-dir <dir> (or H2EVAL_BATCH_DIR)');
  return runBatch({ planFile, batchId, batchDir, corpusDir: get('corpus'), mode, ackUncertain: uncertainAckFromArgs(get), ackUncertainStrict: true, inputReservePolicy: inputReservePolicyFromArgs(get), modelProbe: modelProbeFromArgs(get), realFlag: a.opts['real'] === true, goFile: get('go') ?? envPresence().goFile ?? undefined, executorCodeSha: opts.executorCodeSha, stopFile: get('stop-file') ?? envPresence().stopFile ?? undefined, ackBy: get('ack-80pct'), campaignDir: get('campaign-dir') });
}

/**
 * `run-authorized` (C144 D144-05): ONE multi-batch GO (h2eval.go.multi.v1) lists an explicit, finite set of batchIds of ONE plan. The
 * batches run IN SERIES, in plan order, under a single campaign lock (one paid operation at a time, globally) and one shared study
 * ledger (pilot + campaign aggregated, 11/5/3/3). Per batch: nonce anti-replay registry; G17 PASS required for every campaign batch
 * (model without PASS => SKIPPED_GATE, the other arms continue); Google requires a signed G16-GOOGLE PASS AND being listed in the GO
 * (else SKIPPED_GATE); the split gates (TRAIN_FROZEN / VALIDATION_SELECTED) are never dispensed: a missing artifact HALTS and waits.
 * Stops are classified by STOP_POLICY: a stop that isolates the arm skips the remaining batches of that MODEL; any budget / ledger /
 * uncertain-state / integrity stop halts everything. In doubt: halt. maxAttempts of the GO bounds the sends of the whole scope.
 * OFFLINE and REAL share the same path; REAL additionally needs the usual preconditions (clean tree, env, forbidden vars, ratified plan).
 */
/** What a stop does to an authorized series: halt everything, isolate the model's arm, or isolate one condition of the model. */
export type StopDisposition = 'HALT_ALL' | 'ISOLATE_ARM' | 'ISOLATE_CONDITION';
/** Disposition of each known stop reason in an authorized series; any reason not listed halts everything. */
export const STOP_POLICY: Readonly<Record<string, StopDisposition>> = Object.freeze({
  // budget / ledger / cap / integrity / uncertain state / persistence / operator stop / attempts => everything stops
  STOP_FILE: 'HALT_ALL', STOP_BUDGET_CAMPAIGN: 'HALT_ALL', STOP_BUDGET_PROVIDER: 'HALT_ALL', STOP_BUDGET_BATCH: 'HALT_ALL', STOP_BUDGET_OPERATION: 'HALT_ALL',
  STOP_CAP_VIOLATION: 'HALT_ALL', STOP_INPUT_ABOVE_RESERVATION: 'HALT_ALL', STOP_INPUT_RESERVE_POLICY: 'HALT_ALL', STOP_MODEL_PROBE_FAILED: 'HALT_ALL', STOP_PERSISTENCE: 'HALT_ALL', STOP_UNCERTAIN: 'HALT_ALL', STOP_REPLAY_PLAN_MISMATCH: 'HALT_ALL', STOP_WATCHDOG: 'HALT_ALL',
  PAUSE_REVIEW_AT_80PCT: 'HALT_ALL', STOP_MAX_ATTEMPTS: 'HALT_ALL', STOP_STOP_REASON_MISSING: 'HALT_ALL', PAUSE_PROBE_GATE: 'HALT_ALL', STOP_PROBE_FAILED: 'HALT_ALL',
  // model-specific conditions => isolate that arm, continue the others
  STOP_CONSECUTIVE_FAILURES: 'ISOLATE_ARM', STOP_PRICE_UNKNOWN: 'ISOLATE_ARM', STOP_BATCH_SIZE: 'ISOLATE_ARM', STOP_BATCH_MODEL_MIX: 'ISOLATE_ARM',
  NOT_RUN_BRANCH_LOCKED: 'ISOLATE_ARM', SKIPPED_GATE: 'ISOLATE_ARM',
  // VNEXT-F (R17-V-5): a 400 to a thinking-disabled request isolates the OFF CONDITION of that model (its ON operations continue); on the P1 probe it halts everything
  STOP_THINKING_DISABLED_REJECTED: 'ISOLATE_CONDITION',
});
/**
 * Disposition of a stop reason.
 *
 * @param stop - Stop reason code.
 * @returns Its disposition from {@link STOP_POLICY}, or `HALT_ALL` when unknown.
 */
export const dispositionOf = (stop: string): StopDisposition => STOP_POLICY[stop] ?? 'HALT_ALL';

/**
 * Summary of an authorized series: GO and plan identity, mode, one row per batch in scope with its outcome, the probe
 * and isolated conditions, attempt counts (prior, this run, used, maximum), where and why it halted (`null` when it
 * did not), isolated models, the last ledger state and the campaign identity hash.
 */
export interface AuthorizedRunSummary {
  schema: 'h2eval.authorized_run.v1'; goDigestSha256: string; planProtocolHash: string; mode: 'OFFLINE' | 'REAL';
  executed: Array<{ batchId: string; model: string; provider: string; block: string; outcome: 'DONE' | 'STOPPED' | 'SKIPPED_GATE' | 'HALTED_BEFORE' | 'NOT_REACHED'; stoppedBy: string | null; disposition: StopDisposition | null; planned: number; executed: number; reason?: string }>;
  /** VNEXT-F: OFF conditions isolated after STOP_THINKING_DISABLED_REJECTED (`<model>|OFF`) */ isolatedConditions: string[]; /** VNEXT-F: P1 probe state seen by this run */ probe: { operationId: string; model: string; gate: string } | null;
  attemptsUsed: number; /** VNEXT-3 R15-G-4: SENT lines already present in the scoped journals before this process (attemptsUsed starts from it) */ attemptsPrior: number; /** sends made by THIS process */ attemptsThisRun: number; maxAttempts: number; haltedAt: string | null; haltReason: string | null; isolatedModels: string[]; ledger: unknown; /** VNEXT-3 R15-G-1 */ campaignIdentitySha256: string | null;
}
/**
 * Runs every batch listed in a multi-batch GO, in plan order, under the campaign lock (rules in the comment above
 * {@link StopDisposition}).
 *
 * @param o - Plan, GO and campaign folder; optional corpus folder, mode and `--real` flag, executor commit and git
 *   identity, offline simulation settings, environment, clock in milliseconds, pilot protocol hash, control registry
 *   folder, uncertain-operation acknowledgements, input reserve policy and model probe.
 * @returns The series summary, also written to `<campaignDir>/authorized_run.<ms>.json`.
 * @throws {@link CliError} REFUSED_BY_POLICY when the GO, the control registry, the ledger opening or the pilot hash
 *   refuses the series; REAL_PRECONDITIONS when a real-run precondition fails. A refusal inside a batch does not
 *   throw: it halts the series and is reported in the summary.
 * @throws {@link DirLockedError} When another live process holds the campaign lock.
 */
export async function runAuthorized(o: { planFile: string; goFile: string; campaignDir: string; corpusDir?: string; mode: 'offline' | 'real'; realFlag?: boolean; executorCodeSha: string; identity?: { sha: string; clean: boolean }; offline?: OfflineProviderConfig; env?: NodeJS.ProcessEnv; nowMs?: number; pilotProtocolHash?: string; /** VNEXT-F (R17-V-1): control registry directory (default H2EVAL_CONTROL_DIR or ~/.otk-h2eval/control) */ controlDir?: string; /** C158 cycle 2: human acknowledgements of uncertain operations (each applies to the batch that owns the operation) */ ackUncertain?: readonly UncertainAck[]; /** C158 §3.2: conservative input reserve policy (pre-send gate; default none) */ inputReservePolicy?: InputReserveChoice; /** C158: automatic model probe (default none) */ modelProbe?: ModelProbeConfig }): Promise<AuthorizedRunSummary> {
  const plan = readPlan(o.planFile);
  const text = readFileSync(o.goFile, 'utf8');
  const startedMs = o.nowMs ?? Date.now(); // VNEXT-8 (R17-C2-1): preflight freshness is judged once, here
  const identitySha = campaignIdentitySha256(o.campaignDir); const dirCanonical = canonicalPath(o.campaignDir);
  const multiCtx = { planProtocolHash: plan.protocolHash, planBatchIds: plan.batches.map((b) => b.batchId), plannedOpsInScope: (ids: readonly string[]) => plan.batches.filter((b) => ids.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), providersUsd: plan.policy.capsUsd.providers, campaignUsd: plan.policy.capsUsd.campaign, treeClean: o.mode === 'real' ? (o.identity?.clean ?? null) : null, campaignIdentitySha256: identitySha, campaignDirCanonical: dirCanonical };
  // the GO is validated ONCE here (fail-closed before any lock or executor) and again per operation by the egress preflight
  const code = validateGoMultiV1(text, { campaign: plan.studyId, preregistrationSha256: plan.preregistration.ratifiedSha256 ?? (o.mode === 'offline' ? plan.preregistration.sha256 : undefined), executorCodeSha: o.executorCodeSha, treeClean: multiCtx.treeClean, planProtocolHash: plan.protocolHash, planBatchIds: multiCtx.planBatchIds, plannedOpsInScope: multiCtx.plannedOpsInScope, ledgerCaps: { campaignUsd: plan.policy.capsUsd.campaign, providersUsd: plan.policy.capsUsd.providers }, nowMs: o.nowMs ?? Date.now(), campaignIdentitySha256: identitySha, campaignDirCanonical: dirCanonical });
  if (code) throw new CliError(EXIT.REFUSED_BY_POLICY, code, 'multi-batch GO refused');
  const go = JSON.parse(text) as GoFileMultiV1;
  // VNEXT-F (R17-V-1): the directory's identity must be registered in the machine's control registry under THIS canonical path (a byte copy elsewhere is refused)
  // the control registry is a property of the MACHINE, not of the launch env
  const ctl = verifyCampaignControl(o.campaignDir, o.controlDir ?? controlDirDefault(process.env)); if (ctl.code) throw new CliError(EXIT.REFUSED_BY_POLICY, ctl.code, `${o.campaignDir}: campaign control registry`);
  // VNEXT-F (R17-V-2): the GO pins the opening (or 'none'); the file must exist and match before the lock, and every ledger open re-checks it (R17-V-3)
  const opening = readLedgerOpening(o.campaignDir);
  if (go.ledgerOpeningDigestSha256 === 'none') { if (opening) throw new CliError(EXIT.REFUSED_BY_POLICY, 'LEDGER_OPENING_UNEXPECTED', 'the GO authorises no inherited balance but LEDGER_OPENING.json is present'); }
  else { if (!opening) throw new CliError(EXIT.REFUSED_BY_POLICY, 'LEDGER_OPENING_MISSING', 'the GO pins an inherited balance; LEDGER_OPENING.json is absent'); if (opening.digestSha256 !== go.ledgerOpeningDigestSha256) throw new CliError(EXIT.REFUSED_BY_POLICY, 'LEDGER_OPENING_DIGEST_MISMATCH', 'LEDGER_OPENING.json differs from the one the GO pins'); }
  // VNEXT-3 R15-G-3: campaign batches need the pilot protocol hash (a G17 of another pilot must never qualify); the GO may pin it too
  const hasCampaignBatches = plan.batches.some((b) => go.batchIds.includes(b.batchId) && b.block !== 'pilot');
  if (hasCampaignBatches && !o.pilotProtocolHash) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PILOT_PROTOCOL_HASH_REQUIRED', '--pilot-protocol-hash <hex64> is mandatory for any batch outside the pilot block (R15-G-3)');
  if (go.pilotProtocolHash !== undefined && o.pilotProtocolHash !== undefined && go.pilotProtocolHash !== o.pilotProtocolHash) throw new CliError(EXIT.REFUSED_BY_POLICY, 'GO_PILOT_HASH_MISMATCH', 'the GO pins another pilot protocol hash');
  if (o.mode === 'real') {
    const anyBatch = plan.batches.find((b) => go.batchIds.includes(b.batchId))!;
    const failing = realPreconditions(plan, anyBatch, { realFlag: o.realFlag, goFile: o.goFile, executorCodeSha: o.executorCodeSha, env: o.env, nowMs: o.nowMs, identity: o.identity ?? executorIdentity(REPO_ROOT), campaignDir: o.campaignDir, preflightNowMs: startedMs });
    // CYCLE2-B: the credential-less preflight is required for EVERY provider with batches in the GO scope (not only the first batch's)
    const fp = envFingerprint(o.env ?? process.env);
    for (const p of new Set(plan.batches.filter((b) => go.batchIds.includes(b.batchId)).map((b) => b.provider))) { if (p === anyBatch.provider) continue; const pf = preflightGate(o.campaignDir, p, { envFingerprint: fp, nowMs: startedMs }); if (pf) failing.push(`${pf}:${p}`); }
    if (failing.length) throw new CliError(EXIT.REAL_PRECONDITIONS, 'REAL_PRECONDITIONS_FAILED', failing.join('; '));
    requireDeclaredReservePolicy(o.inputReservePolicy);
  }
  const ordered = plan.batches.filter((b) => go.batchIds.includes(b.batchId)); // plan order, never the GO's order
  const release = acquireDirLock(o.campaignDir); // single campaign lock: one paid operation at a time, globally
  // VNEXT-3 R15-G-4: maxAttempts is CUMULATIVE for the scope: attempts already spent = SENT lines in the scoped journals (survives restarts)
  const attemptsPrior = countSentInScope(o.campaignDir, go.batchIds);
  const out: AuthorizedRunSummary = { schema: 'h2eval.authorized_run.v1', goDigestSha256: go.goDigestSha256, planProtocolHash: plan.protocolHash, mode: o.mode === 'real' ? 'REAL' : 'OFFLINE', executed: [], attemptsUsed: attemptsPrior, attemptsPrior, attemptsThisRun: 0, maxAttempts: go.maxAttempts, haltedAt: null, haltReason: null, isolatedModels: [], isolatedConditions: [], probe: null, ledger: null, campaignIdentitySha256: identitySha };
  const isolatedConditions = new Set<string>();
  const isolated = new Set<string>(); let halted = false;
  const sumFrom = (i: number, provider: Provider): bigint => { let s = 0n; for (let k = i; k < ordered.length; k += 1) { const b = ordered[k]!; if (b.provider !== provider || isolated.has(b.model)) continue; for (const op of b.operations) s += BigInt(op.costCapUsdPico); } return s; };
  const ackOf = (m: GoFileMultiV1['pauseAck80pct'], src: string): PauseAck[] => Object.entries(m ?? {}).map(([p, v]) => ({ provider: p as Provider, acknowledgedBy: v!.acknowledgedBy, source: 'go' as const, reference: `${src}:${go.goDigestSha256.slice(0, 16)}` }));
  const googleOpen = go.providers.includes('google') && g16GoogleOpen(o.campaignDir);
  let lastLedger: unknown = null;
  try {
    for (let i = 0; i < ordered.length; i += 1) {
      const b = ordered[i]!;
      const row: AuthorizedRunSummary['executed'][number] = { batchId: b.batchId, model: b.model, provider: b.provider, block: b.block, outcome: 'NOT_REACHED', stoppedBy: null, disposition: null, planned: b.calls, executed: 0 };
      out.executed.push(row);
      if (halted) { row.outcome = 'HALTED_BEFORE'; continue; }
      if (isolated.has(b.model)) { row.outcome = 'SKIPPED_GATE'; row.reason = 'arm isolated by an earlier stop'; continue; }
      // gates: G17 per model for campaign batches (D144-05); G16-GOOGLE for Google (D144-03)
      if (b.block !== 'pilot') { const v = g17Verdict(o.campaignDir, b.model, o.pilotProtocolHash); if (v !== 'PASS') { row.outcome = 'SKIPPED_GATE'; row.reason = `G17 ${v} for ${b.model}`; isolated.add(b.model); continue; } }
      if (b.provider === 'google' && !googleOpen) { row.outcome = 'SKIPPED_GATE'; row.reason = go.providers.includes('google') ? 'G16-GOOGLE gate missing or not PASS' : 'google not listed in the GO'; isolated.add(b.model); continue; }
      let s: RunSummary;
      // VNEXT-F (R17-V-8): the P1 probe runs alone; every later operation of the batch is admitted only with a signed P1 gate (PASS) for that probe
      const probeOp = b.operations.find((op) => op.probe === 'P1') ?? null;
      const gateV = probeOp ? p1Verdict(o.campaignDir, b.model, probeOp.operationId) : null;
      if (probeOp) out.probe = { operationId: probeOp.operationId, model: b.model, gate: gateV! };
      const admit: NonNullable<RunOptions['admit']> = (plan): ReturnType<NonNullable<RunOptions['admit']>> => {
        if (isolatedConditions.has(`${plan.modelRequested}|OFF`) && plan.params.thinking.mode === 'none') return { kind: 'SKIP', reason: 'OFF condition isolated after STOP_THINKING_DISABLED_REJECTED (R4 contingency: ON policy is a human decision)' };
        if (probeOp && plan.probe !== 'P1') { if (gateV === 'MISSING') return { kind: 'STOP', stop: 'PAUSE_PROBE_GATE', detail: { probeOperationId: probeOp.operationId, gate: 'gates/P1_<model>.json missing' } }; if (gateV === 'FAIL' || gateV === 'WRONG_PROBE') return { kind: 'STOP', stop: 'STOP_PROBE_FAILED', detail: { probeOperationId: probeOp.operationId, verdict: gateV } }; }
        return null;
      };
      let committed = false; const onJournal = (line: { kind: string }) => { if (!committed && line.kind === 'PLANNED') { committed = true; commitNonce(o.campaignDir, b.batchId, go.nonces[b.batchId]!, go.goDigestSha256, identitySha ?? undefined); } };
      try {
        // anti-replay nonce (R15-G-2): CHECK before the batch (refusal halts the series); the row is COMMITTED only after the batch's first PLANNED line,
        // so a batch halted by a split gate or a refusal leaves no row and may run later under another GO
        checkNonce(o.campaignDir, b.batchId, go.nonces[b.batchId]!);
        s = await runBatch({ onJournal, preflightNowMs: startedMs, admit, ledgerOpening: opening, planFile: o.planFile, batchId: b.batchId, batchDir: path.join(o.campaignDir, 'batches', b.batchId), corpusDir: o.corpusDir, mode: o.mode, realFlag: o.realFlag, goFile: o.goFile, executorCodeSha: o.executorCodeSha, identity: o.identity, offline: o.offline, env: o.env, campaignDir: o.campaignDir,
          ackUncertain: o.ackUncertain, inputReservePolicy: o.inputReservePolicy, modelProbe: o.modelProbe, pauseAck: ackOf(go.pauseAck80pct, 'go'), preAuthorizedTo100: ackOf(go.preAuthorizeTo100pct, 'go-preauth'), remainingScopeCapPico: (p) => sumFrom(i, p), attemptsBudget: { max: go.maxAttempts, used: () => out.attemptsUsed, onSend: () => { out.attemptsUsed += 1; } }, lockedProviders: googleOpen ? [] : ['google'], goMulti: multiCtx });
      } catch (e) {
        // split gate missing (train not frozen / validation not selected) or any refusal: halt and wait for the artifact; never skip ahead
        row.outcome = 'STOPPED'; row.stoppedBy = e instanceof CliError ? e.code : e instanceof LedgerReconciliationError ? 'LEDGER_RECONCILIATION' : e instanceof JournalIntegrityError ? 'JOURNAL_INTEGRITY' : e instanceof LedgerOpeningError ? e.code : e instanceof BatchLockedError ? e.code : 'INTERNAL'; row.disposition = 'HALT_ALL'; row.reason = e instanceof Error ? e.message.slice(0, 200) : String(e); halted = true; out.haltedAt = b.batchId; out.haltReason = row.stoppedBy; continue;
      }
      lastLedger = s.ledger; row.executed = s.executed;
      if (o.inputReservePolicy !== undefined) { // MET-02 R4(a): every RESERVED of the batch carries the declared choice (a resume without the flag, or a mixed journal, halts)
        const jf = path.join(o.campaignDir, 'batches', b.batchId, 'journal.jsonl');
        const mism = existsSync(jf) ? reservePolicyMismatches(readFileSync(jf, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> }), o.inputReservePolicy) : [];
        if (mism.length) { row.outcome = 'STOPPED'; row.stoppedBy = 'RESERVE_POLICY_MISMATCH'; row.disposition = 'HALT_ALL'; row.reason = `${mism.length} RESERVED line(s) without the declared reservePolicy (first: ${mism[0]!.slice(0, 12)})`; halted = true; out.haltedAt = b.batchId; out.haltReason = 'RESERVE_POLICY_MISMATCH'; continue; }
      }
      if (s.stoppedBy === 'STOP_THINKING_DISABLED_REJECTED' && !(probeOp && s.results.find((r) => r.stop)?.operationId === probeOp.operationId)) {
        // VNEXT-F (R17-V-5): isolate the OFF condition of this model and finish the batch's other operations (the rejected op is terminal: replay skips it)
        isolatedConditions.add(`${b.model}|OFF`); row.reason = 'OFF condition isolated after STOP_THINKING_DISABLED_REJECTED';
        try { const s2 = await runBatch({ onJournal, preflightNowMs: startedMs, admit, ledgerOpening: opening, planFile: o.planFile, batchId: b.batchId, batchDir: path.join(o.campaignDir, 'batches', b.batchId), corpusDir: o.corpusDir, mode: o.mode, realFlag: o.realFlag, goFile: o.goFile, executorCodeSha: o.executorCodeSha, identity: o.identity, offline: o.offline, env: o.env, campaignDir: o.campaignDir, ackUncertain: o.ackUncertain, inputReservePolicy: o.inputReservePolicy, modelProbe: o.modelProbe, pauseAck: ackOf(go.pauseAck80pct, 'go'), preAuthorizedTo100: ackOf(go.preAuthorizeTo100pct, 'go-preauth'), remainingScopeCapPico: (p) => sumFrom(i, p), attemptsBudget: { max: go.maxAttempts, used: () => out.attemptsUsed, onSend: () => { out.attemptsUsed += 1; } }, lockedProviders: googleOpen ? [] : ['google'], goMulti: multiCtx }); lastLedger = s2.ledger; row.executed += s2.executed; s = { ...s2, stoppedBy: s2.stoppedBy }; }
        catch (e) { row.outcome = 'STOPPED'; row.stoppedBy = e instanceof CliError ? e.code : 'INTERNAL'; row.disposition = 'HALT_ALL'; row.reason = e instanceof Error ? e.message.slice(0, 200) : String(e); halted = true; out.haltedAt = b.batchId; out.haltReason = row.stoppedBy; continue; }
        if (!s.stoppedBy) { row.outcome = 'DONE'; row.stoppedBy = 'STOP_THINKING_DISABLED_REJECTED'; row.disposition = 'ISOLATE_CONDITION'; continue; }
      }
      if (s.stoppedBy) {
        row.outcome = 'STOPPED'; row.stoppedBy = s.stoppedBy; row.disposition = dispositionOf(s.stoppedBy);
        const stoppedOnProbe = probeOp !== null && s.results.find((r) => r.stop)?.operationId === probeOp.operationId;
        if (stoppedOnProbe) row.disposition = 'HALT_ALL'; // R4 P1: a stop on the probe sends nothing more (contingency is a human decision)
        if (row.disposition === 'ISOLATE_ARM') isolated.add(b.model); else { halted = true; out.haltedAt = b.batchId; out.haltReason = s.stoppedBy; }
      } else row.outcome = 'DONE';
    }
  } finally { release(); }
  out.isolatedModels = [...isolated]; out.isolatedConditions = [...isolatedConditions]; out.ledger = lastLedger; out.attemptsThisRun = out.attemptsUsed - attemptsPrior;
  writeJson(path.join(o.campaignDir, `authorized_run.${Date.now()}.json`), out);
  return out;
}
