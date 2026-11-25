/**
 * R11 runner: serial (concurrency 1), deterministic operationId, replay-safe, journal+snapshot+reservation fsync'd BEFORE egress,
 * no retry, no fallback, stop by file / budget / cap violation / unknown price / persistence / watchdog.
 * Crash semantics (contract §0.2): anything after the SENT line without a terminal line is UNCERTAIN on replay (isolated,
 * possibly charged, never resent). A reservation without SENT is released on replay and the operation is ABORTED_BEFORE_SEND.
 *
 * In short: {@link createExecutor} opens one batch folder (journal, ledger, snapshots, records, lock) and returns an
 * executor whose `run(plan)` takes one operation through the whole path: replay check, stops and gates, request
 * build, pre-call snapshot, ledger reservation, egress send, usage parsing, cost and settlement. Created through
 * `../index.ts` by the CLI (`../cli/run.ts`). Side effects: files under the batch folder and the shared ledger file;
 * in REAL mode, provider calls that spend money within the ledger caps. Environment: none directly (the egress reads
 * the credential at send time).
 *
 * @module scripts/h2eval/core/runner
 */
import { mkdirSync, closeSync, fsyncSync, openSync, writeSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createLocalCounter } from '../../../src/tokenization/localCounter.js';
import type { UsageApi } from '../../../src/types/d1d8/index.js';
import { H2EVAL_SCHEMA, type BuiltRequest, type ContentStore, type Count, type ExploratoryFormulaEstimate, type OperationPlan, type OperationState, type PostcallRecord, type PrecallSnapshot, type Provider, type ProviderAdapter, type ResolvedContent, type RunnerResult, type StopReason } from '../types.js';
import { sha256Canon, sha256Hex } from './canon.js';
import { operationIdOf } from './ids.js';
import { openJournal, JournalPersistenceError, type Journal } from './journal.js';
import type { JournalLine } from '../types.js';
import { openLedger, BudgetStop, type Ledger, type LedgerConfig, type LedgerOpening } from './ledger.js';
import { createStopChecker } from './stop.js';
import { createEgress, EgressRefused, EgressGoEconRefused, EgressTimeout, classifySendFailure, type EgressConfig, type SendFailureClass } from './egress.js';
import { NOT_AVAILABLE, providerRequestIdFromResponse, requestIdFields, wireBodySha256Of, wireFields, type InstrumentedValue } from './requestInstrumentation.js';
import { computeCost, computeCostCap } from '../record/cost.js';
import { sealSnapshot, writeSnapshot, SnapshotError } from '../record/snapshot.js';
import { validateUsage, UsageInvalid } from '../record/usage.js';
import { buildForecast, type ForecastFrozen } from '../record/forecast.js';
import type { PriceTable } from '../record/prices.js';

/** Version string of this executor; a GO must name it. */
export const EXECUTOR_VERSION = 'otk.h2eval.executor.v0';
/** C158 §3 + BOT-01 M19: blocking stops (HALT_ALL) that are journaled after the money is settled/isolated; once present, NO new operation is sent from this batch journal, restart included. */
import { evaluateInputReserve, type InputReserveChoice } from './inputReserve.js';
import { measuredRangeOf } from './inputReserve.js';
import { isArmModel, armPriceAttested, armLedgerViolation, servedTierVerdict, E3G_TIER_RULE, googleCacheUpperBound, googleUpperBoundRecordUsage, CACHE_READ_EVIDENCE_UPPER_BOUND, openaiCacheWriteUpperBound, CACHE_WRITE_EVIDENCE_UPPER_BOUND } from './e3gArm.js';
import { aboveRangeBand, probeRegionOf, probeKeyOf, probeStateOf, judgeProbe, validateModelProbeConfig, type ModelProbeConfig } from './modelProbe.js';
/** Human acknowledgement of one uncertain operation: its id (hex), the signer (`human:<name>`) and the authorising text. */
export interface UncertainAck { operationId: string; acknowledgedBy: string; authority: string }
/** Error raised for an invalid acknowledgement; `code` starts with `UNCERTAIN_ACK_`. */
export class UncertainAckError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'UncertainAckError'; } }
/**
 * The ack is a HUMAN act of the author/designated operator: signature "human:<name>", the operation id and the text/order that authorises it. Pure format check (also used by the CLI).
 *
 * @param a - The acknowledgement.
 * @throws {@link UncertainAckError} `UNCERTAIN_ACK_NOT_HUMAN`, `UNCERTAIN_ACK_NO_OPERATION` (id not hex, under 8
 *   characters) or `UNCERTAIN_ACK_NO_AUTHORITY` (text under 8 characters).
 */
export function validateUncertainAckShape(a: UncertainAck): void {
  if (!/^human:\S/.test(a.acknowledgedBy ?? '')) throw new UncertainAckError('UNCERTAIN_ACK_NOT_HUMAN', 'acknowledgedBy must be "human:<name>"');
  if (!/^[0-9a-f]{8,}$/i.test(a.operationId ?? '')) throw new UncertainAckError('UNCERTAIN_ACK_NO_OPERATION', 'operationId (hex) is required');
  if (typeof a.authority !== 'string' || a.authority.trim().length < 8) throw new UncertainAckError('UNCERTAIN_ACK_NO_AUTHORITY', 'the text/order that authorises the acknowledgement is required');
}
const LATCHING_STOPS: ReadonlySet<string> = new Set(['STOP_INPUT_ABOVE_RESERVATION', 'STOP_INPUT_RESERVE_POLICY', 'STOP_MODEL_PROBE_FAILED', 'STOP_CAP_VIOLATION', 'STOP_STOP_REASON_MISSING', 'STOP_TIER_NOT_STANDARD']); // E3G: STOP_TIER_NOT_STANDARD (arm only; never written by the Anthropic path)
/**
 * C158 cycle 2 (BOT-01 R01): the blocking state is DERIVED from the journal facts, not only from a STOP line that may never have been written (a crash between SETTLED and that line).
 * Blocking: a latching STOP_GLOBAL; any UNCERTAIN_ISOLATED / TIMEOUT_UNCERTAIN (possibly charged, never resend: timeout, incomplete response, network error, crash after send);
 * USAGE_PARSED.U above the input upper bound journaled with the RESERVED line. Journals written before the bound was recorded cannot be judged by the third rule (no bound => no decision).
 *
 * @param lines - All lines of the batch journal.
 * @param opts - `stopReasonRequired` adds the rule "response with usage but unknown stop reason".
 * @returns The blocking stop, the operation that caused it and the rule, or `null` when the batch may continue.
 */
function blockingStop(lines: readonly JournalLine[], opts: { stopReasonRequired?: boolean } = {}): { stop: StopReason; by: string; kind: 'STOP_LINE' | 'UNCERTAIN' | 'USAGE_ABOVE_BOUND' | 'STOP_REASON_UNKNOWN' | 'PROBE_UNRESOLVED' } | null {
  const bound = new Map<string, number>();
  for (const l of lines) if (l.kind === 'RESERVED') { const b = (l.body as { reservedInputUpperBoundTokens?: unknown }).reservedInputUpperBoundTokens; if (typeof b === 'number') bound.set(l.operationId, b); }
  // precedence: an explicit STOP line (the journaled reason) > uncertain > derived from usage
  // an uncertain operation that the journal ALREADY assigned another (isolating) disposition, e.g. STOP_THINKING_DISABLED_REJECTED (money stays conservative, the OFF arm is isolated, the other arms go on), is not a batch-wide block
  const ackedOps = new Set<string>(lines.filter((l) => l.kind === 'UNCERTAIN_ACKNOWLEDGED').map((l) => l.operationId));
  const isolatedOps = new Set<string>(); for (const l of lines) if (l.kind === 'STOP_GLOBAL' && !LATCHING_STOPS.has(String((l.body as { reason?: string }).reason))) isolatedOps.add(l.operationId);
  let uncertain: { stop: StopReason; by: string; kind: 'UNCERTAIN' } | null = null; let derived: { stop: StopReason; by: string; kind: 'USAGE_ABOVE_BOUND' | 'STOP_REASON_UNKNOWN' } | null = null;
  // BOT-01 S10: STOP_STOP_REASON_MISSING is also derived from the facts (response line stopReason UNKNOWN + usage present) when the integrity policy requires the stop reason
  const reasonUnknown = new Set<string>(); if (opts.stopReasonRequired) for (const l of lines) if ((l.kind === 'RESPONSE_RECEIVED' || l.kind === 'ERROR_WITH_USAGE') && (l.body as { stopReason?: string }).stopReason === 'UNKNOWN') reasonUnknown.add(l.operationId);
  for (const l of lines) {
    if (l.kind === 'STOP_GLOBAL') { const r = String((l.body as { reason?: string }).reason); if (LATCHING_STOPS.has(r)) return { stop: r as StopReason, by: l.operationId, kind: 'STOP_LINE' }; }
    else if ((l.kind === 'UNCERTAIN_ISOLATED' || l.kind === 'TIMEOUT_UNCERTAIN') && !uncertain && !isolatedOps.has(l.operationId) && !ackedOps.has(l.operationId)) uncertain = { stop: 'STOP_UNCERTAIN', by: l.operationId, kind: 'UNCERTAIN' };
    else if (l.kind === 'USAGE_PARSED' && !derived) { const u = (l.body as { U?: unknown }).U; const b = bound.get(l.operationId); if (typeof u === 'number' && b !== undefined && u > b) derived = { stop: 'STOP_INPUT_ABOVE_RESERVATION', by: l.operationId, kind: 'USAGE_ABOVE_BOUND' }; else if (reasonUnknown.has(l.operationId) && !isolatedOps.has(l.operationId) && (l.body as { completeness?: string }).completeness !== 'MISSING') derived = { stop: 'STOP_STOP_REASON_MISSING', by: l.operationId, kind: 'STOP_REASON_UNKNOWN' }; }
  }
  // C158 model probe: a probe that was STARTED and has no PASSED verdict (failed, interrupted, incomplete) blocks the batch journal from the journal facts alone
  let probeUnresolved: { stop: StopReason; by: string; kind: 'PROBE_UNRESOLVED' } | null = null;
  const passedKeys = new Set<string>(); for (const l of lines) if (l.kind === 'MODEL_PROBE_RESULT' && (l.body as { verdict?: string }).verdict === 'PASSED') passedKeys.add(String((l.body as { key?: string }).key));
  for (const l of lines) if (l.kind === 'MODEL_PROBE_STARTED' && !passedKeys.has(String((l.body as { key?: string }).key))) { probeUnresolved = { stop: 'STOP_MODEL_PROBE_FAILED', by: l.operationId, kind: 'PROBE_UNRESOLVED' }; break; }
  return uncertain ?? derived ?? probeUnresolved;
}
const TERMINAL: ReadonlySet<string> = new Set(['SETTLED', 'ABORTED_BEFORE_SEND', 'STOP_BUDGET', 'STOP_GLOBAL', 'UNSUPPORTED_FOR_ESTIMATION', 'NOT_SUPPORTED', 'UNCERTAIN_ISOLATED', 'REPLAY_SKIPPED', 'NOT_RUN_BRANCH_LOCKED']);
/** Default maximum number of operations in one batch. */
export const DEFAULT_MAX_BATCH_CALLS = 60;

/** Policy injected by the caller (R10 R2, parametrizable, not fixed here): input upper bound by size bucket; reasoning allowance per model (Haiku 5.5: 1 024, Gemini: 2 048, others 0). */
export interface CapPolicy { inputUpperBoundTokens: (plan: OperationPlan, L0: Count) => number; reasoningAllowanceTokens: (plan: OperationPlan) => number;
  /** EXEC-ECON C160 (delta v3.1 item 9): true only when the G-7b established that maxOutputTokens bounds the Gemini thoughts (allowance 0 accepted). Absent => fail-closed as before. */
  thoughtsBoundedByMaxOutput?: (plan: OperationPlan) => boolean }
/**
 * Configuration of {@link createExecutor}: the batch folder, adapters per API, content store, price table, ledger
 * caps, egress settings, cap policy and executor commit, plus the optional hooks and policies documented per field.
 * `clock` returns ISO-8601 UTC.
 */
export interface ExecutorConfig {
  batchDir: string;
  adapters: Partial<Record<UsageApi, ProviderAdapter>>;
  contentStore: ContentStore;
  prices: PriceTable;
  ledger: LedgerConfig;
  egress: Omit<EgressConfig, 'campaign'> & { campaign: string };
  capPolicy: CapPolicy;
  executorCodeSha: string;
  clock?: () => string;
  stopFile?: string;
  /** C158 cycle 2: human acknowledgements of uncertain operations of THIS batch journal (default: none => an uncertain operation blocks the batch). Never resends the acknowledged operation. */
  uncertainAck?: readonly UncertainAck[];
  /** C158 §3.2: conservative input reserve policy applied as a PRE-SEND gate (default: none => not active; it can only stop earlier, never spend more). */
  inputReservePolicy?: InputReserveChoice;
  /** C158: automatic probe of a new model / unmeasured length region (default: none => not active). The first operation of a region is judged; a failed or unresolved probe halts the batch. */
  modelProbe?: ModelProbeConfig;
  watchdogMs?: number;
  /** Test hook: throw at a named point to simulate a crash (never used in production configs). */
  crashAt?: (point: string) => void;
  maxTextBytes?: number;
  /** Policy: pause after N consecutive failures of the same model (R10 proposal); 0 disables. */
  consecutiveFailureStop?: number;
  /** R2 item 11: providers whose branch is locked until their own GO (default ['google']). OFFLINE never unlocks them. */
  lockedProviders?: readonly Provider[];
  /** R2 item 12 / R15-M4: signed acknowledgements to continue past 80% of a provider sub-ledger (journaled as PAUSE_ACK). In REAL mode only `source: 'go'` counts. */
  pauseAck?: readonly PauseAck[];
  /** C144 D144-06: signed pre-authorisation to continue past 80 % up to 100 % of the sub-ledger, honoured ONLY when committed + every future reservation of the remaining scope fits the cap (journaled PAUSE_PREAUTHORIZED). */
  preAuthorizedTo100?: readonly PauseAck[];
  /** C144 D144-06: worst-case pico-USD of the operations of the scope still to be reserved for a provider (including the current one); without it a pre-authorisation can never be honoured. */
  remainingScopeCapPico?: (provider: Provider) => bigint;
  /** C144 D144-04: study-level attempts budget (sends counted across batches by the caller); exhausted => STOP_MAX_ATTEMPTS before PLANNED. */
  attemptsBudget?: { max: number; used: () => number; onSend: () => void };
  /** C144 D144-04: path of the SHARED study ledger (default <batchDir>/ledger.jsonl). Pilot + campaign batches must share one file so the 5/3/3/11 caps aggregate. */
  ledgerPath?: string;
  /** C144: other journals whose RESERVED/SETTLED/UNCERTAIN lines the shared ledger must reconcile with (all batches of the study). */
  reconcileJournalPaths?: readonly string[];
  /** R2 item 12: batch size limit (default 60; the GO may lower it, never raise it). */
  maxBatchCalls?: number;
  /** R10 R2 §5.3: accepted served-model ids per requested model (dated ids); outside ⇒ EXCL_MODEL_MISMATCH recorded. */
  acceptedModelsServed?: Record<string, readonly string[]>;
  /** R2 item 7: exploratory image formula (never replaces L0); absent ⇒ null in the snapshot. */
  exploratoryFormula?: (plan: OperationPlan, req: BuiltRequest, content: ResolvedContent) => ExploratoryFormulaEstimate | null;
  /** E1: frozen forecast table (ECON-02 forecast_frozen.json) for OUT_MEAN / OUT_LEARN / COST_SIMPLE; absent ⇒ those fields NAO_REGISTRADA. */
  forecastTable?: ForecastFrozen | null;
  /** E3: local text token counter (same encoding family as the plan's estimate) for cacheableTokens / nonceTokensDeclared; absent ⇒ UNKNOWN. */
  textTokenCounter?: (text: string) => number;
  /** R18–R20: immutable prediction (selected profile + expected cost) written into the pre-call snapshot; absent ⇒ profile null, expectedCostUsd UNKNOWN. */
  predictor?: (plan: OperationPlan, L0: Count, microInput: bigint | null, microOutput: bigint | null) => { profile: PrecallSnapshot['profile']; expectedCostUsd: PrecallSnapshot['expectedCostUsd'] };
  /** R15-D-1: digest of the gate artifact revalidated by the caller for this batch (written into every pre-call snapshot). */
  gateUsed?: PrecallSnapshot['gateUsed'];
  /** VNEXT-3 R15-G-2: observer called after every journal line is durably appended (run-authorized commits the GO nonce on the first PLANNED). */
  onJournal?: (line: JournalLine) => void;
  /** VNEXT-5: signed opening balance inherited from a previous study (applied once when the study ledger is created). */
  ledgerOpening?: LedgerOpening;
  /** VNEXT-8 (R4 stops): a response whose provider stop reason is absent ⇒ STOP_STOP_REASON_MISSING after settlement (HALT_ALL); an HTTP 400 to a request that disabled thinking ⇒ STOP_THINKING_DISABLED_REJECTED (ISOLATE_ARM: the OFF arms are NOT_RUN, the contingency policy is a human decision). */
  integrity?: { stopReasonRequired?: boolean; thinkingDisabledRejectedStops?: boolean };
  /** VNEXT-F: admission decided by the caller BEFORE anything is reserved: SKIP (journaled SKIPPED_GATE, e.g. an isolated OFF condition) or STOP (journaled STOP_GLOBAL, e.g. P1 gate missing). Replays are decided first and never consult it. */
  admit?: (plan: OperationPlan) => { kind: 'SKIP'; reason: string } | { kind: 'STOP'; stop: StopReason; detail?: Record<string, string | number | boolean | null> } | null;
  /**
   * EXEC-ECON C160 (delta v3.1, ECON study only; absent => every legacy behaviour unchanged):
   *  - item 3: the response body is persisted content-addressed in <batchDir>/responses/<responseSha256>.json (wx + fsync) BEFORE the money is settled;
   *    the text never goes to the journal, the ledger or a log (only its sha256);
   *  - item 4: the CRONOGRAMA mixes the 5 models inside one block: the one-model-per-batch rule is not applied (batch size <= 60 still is);
   *  - the E3G per-provider arm-ledger profile (A2) is replaced by the single study ledger, validated by the ECON consumer (econ/consumer.ts).
   */
  econ?: { study: string };
}

/** Signed acknowledgement to continue past 80% of a provider sub-ledger: who signed (`human:<name>`), where it came from and a reference. */
export interface PauseAck { provider: Provider; acknowledgedBy: string; source: 'go' | 'operator'; reference: string }
/** An open batch executor: `run` executes one operation, `journal` and `ledger` are the open files, `close` releases the lock. */
export interface Executor { run(plan: OperationPlan): Promise<RunnerResult>; journal: Journal; ledger: Ledger; readonly mode: 'OFFLINE' | 'REAL'; /** releases the batchDir lock (R15-M2) */ close(): void }

/** Error raised when the batch folder lock is held by a busy holder in this process, by a live process, or was lost. */
export class BatchLockedError extends Error { constructor(public readonly code: 'LOCK_HELD_IN_PROCESS' | 'LOCK_HELD_BY_PID' | 'LOCK_LOST', public readonly lockPath: string, detail = '') { super(`batch locked (${code}) ${lockPath} ${detail}`); this.name = 'BatchLockedError'; } }
/** Error raised when the ledger totals differ from the totals derived from the journals; `detail` shows both. */
export class LedgerReconciliationError extends Error { constructor(public readonly detail: Record<string, unknown>) { super(`ledger does not reconcile with the journal: ${JSON.stringify(detail)}`); this.name = 'LedgerReconciliationError'; } }
/** In-process holders: a holder that is mid-operation is refused; an idle one is superseded (same-process reopen = restart) and its later run() throws LOCK_LOST. */
const LIVE_LOCKS = new Map<string, { busy: () => boolean; invalidate: () => void }>();
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/**
 * R15-M2: exclusive <batchDir>/.lock (wx). Refuses a busy holder in this process or a live holder in another pid; takes over a stale lock.
 *
 * @param batchDir - Batch folder.
 * @param holder - Callbacks telling whether the new holder is busy and invalidating it when superseded.
 * @returns The lock file path.
 * @throws {@link BatchLockedError} `LOCK_HELD_IN_PROCESS` or `LOCK_HELD_BY_PID`.
 */
function acquireLock(batchDir: string, holder: { busy: () => boolean; invalidate: () => void }): string {
  const lockPath = path.join(batchDir, '.lock'); const key = path.resolve(lockPath);
  const prev = LIVE_LOCKS.get(key);
  if (prev) { if (prev.busy()) throw new BatchLockedError('LOCK_HELD_IN_PROCESS', lockPath); prev.invalidate(); LIVE_LOCKS.delete(key); }
  if (existsSync(lockPath)) {
    let held: { pid?: number } = {}; try { held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number }; } catch { held = {}; }
    if (typeof held.pid === 'number' && held.pid !== process.pid && pidAlive(held.pid)) throw new BatchLockedError('LOCK_HELD_BY_PID', lockPath, `pid ${held.pid}`);
    unlinkSync(lockPath); // stale (dead pid, or an abandoned instance of this process)
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString('hex'), sinceUtc: new Date().toISOString() }), { flag: 'wx' });
  LIVE_LOCKS.set(key, holder);
  return lockPath;
}

/**
 * R15-M3: the committed money per provider must be re-derivable from the journal; any divergence refuses to open the batch.
 *
 * @param lines - Journal lines of every batch that shares the ledger.
 * @param ledger - The open ledger.
 * @throws {@link LedgerReconciliationError} When spent, possibly charged or reserved pico-USD differ for a provider.
 */
export function reconcileLedgerWithJournal(lines: readonly JournalLine[], ledger: Ledger): void {
  const byOp = new Map<string, JournalLine[]>();
  for (const l of lines) { if (l.operationId === 'NONE') continue; const a = byOp.get(l.operationId) ?? []; a.push(l); byOp.set(l.operationId, a); }
  const exp: Record<string, { spent: bigint; uncertain: bigint; reserved: bigint }> = {};
  const bump = (p: string, k: 'spent' | 'uncertain' | 'reserved', v: bigint) => { const e = (exp[p] ??= { spent: 0n, uncertain: 0n, reserved: 0n }); e[k] += v; };
  for (const ls of byOp.values()) {
    const res = ls.find((l) => l.kind === 'RESERVED'); if (!res) continue;
    const b = res.body as { provider: string; usd: string }; const cap = BigInt(b.usd);
    const settled = ls.find((l) => l.kind === 'SETTLED');
    const uncertain = ls.some((l) => l.kind === 'UNCERTAIN_ISOLATED' || l.kind === 'TIMEOUT_UNCERTAIN' || (l.kind === 'STOP_GLOBAL' && (l.body as { reason?: string }).reason === 'STOP_CAP_VIOLATION'));
    const released = ls.some((l) => l.kind === 'ABORTED_BEFORE_SEND' && (l.body as { reason?: string }).reason === 'crash_before_sent_reservation_released');
    if (settled) bump(b.provider, 'spent', BigInt((settled.body as { usd: string }).usd));
    else if (uncertain) bump(b.provider, 'uncertain', cap);
    else if (!released) bump(b.provider, 'reserved', cap);
  }
  const st = ledger.state();
  for (const [p, s] of Object.entries(st.providers)) {
    const e = exp[p] ?? { spent: 0n, uncertain: 0n, reserved: 0n };
    if (BigInt(s.spentUsd) !== e.spent || BigInt(s.possiblyChargedUsd) !== e.uncertain || BigInt(s.reservedUsd) !== e.reserved) throw new LedgerReconciliationError({ provider: p, ledger: { spent: s.spentUsd, possiblyCharged: s.possiblyChargedUsd, reserved: s.reservedUsd }, journal: { spent: e.spent.toString(), possiblyCharged: e.uncertain.toString(), reserved: e.reserved.toString() } });
  }
}

/**
 * EXEC-ECON item 3: <batchDir>/responses/<sha256>.json, bytes = JSON.stringify(body) (so the file sha256 IS responseSha256), created with wx and fsync'd; an existing file must hold the same bytes.
 *
 * @param batchDir - Batch folder.
 * @param body - Parsed response body.
 * @returns SHA-256 (hex) of the stored bytes.
 * @throws {Error} When the file exists with other bytes, or the write fails.
 */
export function persistResponse(batchDir: string, body: unknown): string {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8'); const sha = sha256Hex(bytes);
  const dir = path.join(batchDir, 'responses'); mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sha}.json`);
  let fd: number;
  try { fd = openSync(p, 'wx'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST' && sha256Hex(readFileSync(p)) === sha) return sha; throw e; }
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return sha;
}

/**
 * Opens a batch executor: validates the probe settings, creates the batch folders, takes the lock, opens and verifies
 * the journal, opens the ledger, journals the uncertain-operation acknowledgements and reconciles the ledger with
 * every journal that shares it.
 *
 * @param cfg - Executor configuration.
 * @returns The executor; call `close()` when done.
 * @throws {@link BatchLockedError} When the batch folder is locked.
 * @throws {@link UncertainAckError} For an invalid acknowledgement or one for an operation that is not uncertain.
 * @throws {@link LedgerReconciliationError} When the ledger does not match the journals.
 * @throws {RangeError} When the model probe settings are invalid.
 */
export function createExecutor(cfg: ExecutorConfig): Executor {
  if (cfg.modelProbe) validateModelProbeConfig(cfg.modelProbe); // refused before any lock or file
  mkdirSync(path.join(cfg.batchDir, 'snapshots'), { recursive: true });
  mkdirSync(path.join(cfg.batchDir, 'records'), { recursive: true });
  let busy = false; let lost = false;
  const lockPath = acquireLock(cfg.batchDir, { busy: () => busy, invalidate: () => { lost = true; } });
  const lockKey = path.resolve(lockPath);
  const clock = cfg.clock ?? (() => new Date().toISOString());
  let journal: Journal; let ledger: Ledger;
  try {
    const raw = openJournal(path.join(cfg.batchDir, 'journal.jsonl'), clock);
    journal = cfg.onJournal ? { get path() { return raw.path; }, get seq() { return raw.seq; }, get lastHash() { return raw.lastHash; }, append: (k, id, body) => { const line = raw.append(k, id, body); cfg.onJournal!(line); return line; }, lines: () => raw.lines(), of: (id) => raw.of(id) } : raw;
    ledger = openLedger(cfg.ledgerPath ?? path.join(cfg.batchDir, 'ledger.jsonl'), cfg.ledger, clock, cfg.ledgerOpening, cfg.econ ? { econEnvelope: true } : {}); // EXEC-ECON delta 7b: só o estudo aceita o envelope (tetos do GO <= DR-277)
    // C158 cycle 2: human acknowledgements are journaled BEFORE anything runs; each one needs an operation that is really uncertain in THIS journal (never an invented one)
    for (const a of cfg.uncertainAck ?? []) {
      validateUncertainAckShape(a); const ls = journal.of(a.operationId);
      if (!ls.some((l) => l.kind === 'UNCERTAIN_ISOLATED' || l.kind === 'TIMEOUT_UNCERTAIN')) throw new UncertainAckError('UNCERTAIN_ACK_NOT_UNCERTAIN', `${a.operationId.slice(0, 12)} is not an uncertain operation of this batch journal`);
      if (ls.some((l) => l.kind === 'UNCERTAIN_ACKNOWLEDGED')) continue;
      journal.append('UNCERTAIN_ACKNOWLEDGED', a.operationId, { acknowledgedBy: a.acknowledgedBy, authority: a.authority, authoritySha256: sha256Hex(a.authority), resend: false, releases: 'NEXT_OPERATIONS_ONLY' });
    }
    const own = path.resolve(path.join(cfg.batchDir, 'journal.jsonl'));
    const others = (cfg.reconcileJournalPaths ?? []).filter((p) => path.resolve(p) !== own && existsSync(p)).flatMap((p) => openJournal(p, clock).lines());
    reconcileLedgerWithJournal([...others, ...journal.lines()], ledger);
  } catch (e) { LIVE_LOCKS.delete(lockKey); try { unlinkSync(lockPath); } catch { /* already gone */ } throw e; }
  const close = () => { if (lost) return; lost = true; LIVE_LOCKS.delete(lockKey); try { unlinkSync(lockPath); } catch { /* already gone */ } };
  const stop = createStopChecker({ stopFile: cfg.stopFile ?? path.join(cfg.batchDir, 'STOP'), watchdogMs: cfg.watchdogMs });
  const egress = createEgress({ ...cfg.egress });
  const crash = cfg.crashAt ?? (() => {});
  const failures: Record<string, number> = {};
  const locked = new Set<Provider>(cfg.lockedProviders ?? ['google']);

  /**
   * Batch composition from the journal (survives restarts): calls planned and models used per batch.
   *
   * @param batchId - Batch id.
   * @returns Number of PLANNED lines and the set of models requested.
   */
  const batchStats = (batchId: string) => { const planned = journal.lines().filter((l) => l.kind === 'PLANNED' && (l.body as { batchId?: string }).batchId === batchId); return { calls: planned.length, models: new Set(planned.map((l) => (l.body as { modelRequested?: string }).modelRequested)) }; };

  /**
   * E3: cacheable (stable-prefix) tokens and S2 nonce tokens, by the injected local counter; UNKNOWN without it (never 0).
   *
   * @param plan - Operation plan.
   * @param content - Resolved content of the operation.
   * @returns Both estimates in tokens, or `UNKNOWN` / `NOT_APPLICABLE`.
   */
  const cacheEstimates = (plan: OperationPlan, content: ResolvedContent): { cacheableTokens: Count; nonceTokensDeclared: Count } => {
    const count = cfg.textTokenCounter;
    const textOf = (ms: ResolvedContent['messages']) => ms.flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    if (!count) return { cacheableTokens: 'UNKNOWN', nonceTokensDeclared: plan.nonce === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'UNKNOWN' };
    const n = content.prefixMessages;
    const cacheable: Count = plan.plannedCacheArm === 'S1' ? 'NOT_APPLICABLE' : typeof n === 'number' && n > 0 ? count(textOf(content.messages.slice(0, n))) : 'UNKNOWN';
    let nonceTokens: Count = 'NOT_APPLICABLE';
    if (plan.nonce !== 'NOT_APPLICABLE') { const sys = content.messages[0]; const t = sys ? textOf([sys]) : ''; const without = t.replace(/^\[ref [0-9a-f]{16}\]\n/, ''); nonceTokens = t === without ? 'UNKNOWN' : count(t) - count(without); }
    return { cacheableTokens: cacheable, nonceTokensDeclared: nonceTokens };
  };

  const writeRecord = (r: PostcallRecord) => { const p = path.join(cfg.batchDir, 'records', `${r.operationId}.json`); const fd = openSync(p, 'w'); try { writeSync(fd, JSON.stringify(r)); fsyncSync(fd); } finally { closeSync(fd); } };

  /**
   * Replay: decide from the journal what happened to a known operation.
   *
   * @param id - Operation id.
   * @returns The result to report without resending, or `null` when the operation has no history and may run.
   */
  const replayDecision = (id: string): RunnerResult | null => {
    // VNEXT-F: PAUSE_REVIEW / PAUSE_PREAUTHORIZED lines are NOT a history of the operation (nothing was reserved or sent): a paused operation is run again
    // after the human act (80 % ack in the GO, P1 gate). Before this, a paused operation was aborted on resume (crash_before_reserve) and lost.
    const lines = journal.of(id).filter((l) => l.kind !== 'REPLAY_SKIPPED' && l.kind !== 'UNCERTAIN_ACKNOWLEDGED' && l.kind !== 'MODEL_PROBE_STARTED' && l.kind !== 'MODEL_PROBE_RESULT' && l.kind !== 'REPLAY_PLAN_MISMATCH' && l.kind !== 'PAUSE_ACK' && l.kind !== 'PAUSE_REVIEW' && l.kind !== 'PAUSE_PREAUTHORIZED');
    if (!lines.length) return null;
    const kinds = lines.map((l) => l.kind);
    const last = kinds[kinds.length - 1]!;
    if (TERMINAL.has(last)) {
      // C158 cycle 2: the replay of a terminal operation re-derives its blocking stop from the journal facts (a crash after SETTLED but before the STOP line, or an uncertain operation, must not read as stop:null).
      const blk = blockingStop(journal.of(id), { stopReasonRequired: cfg.integrity?.stopReasonRequired });
      if (blk && (blk.kind === 'USAGE_ABOVE_BOUND' || blk.kind === 'STOP_REASON_UNKNOWN' || blk.kind === 'PROBE_UNRESOLVED')) journal.append('STOP_GLOBAL', id, { reason: blk.stop, phase: 'REPLAY_RECONSTRUCTED', detail: blk.kind === 'PROBE_UNRESOLVED' ? 'model probe STARTED without a PASSED verdict; the stop line was not journaled before the interruption' : blk.kind === 'USAGE_ABOVE_BOUND' ? 'USAGE_PARSED.U above the reserved input upper bound; the stop line was not journaled before the interruption' : 'provider stop reason UNKNOWN with the stop reason required; the stop line was not journaled before the interruption' });
      journal.append('REPLAY_SKIPPED', id, { lastKind: last });
      return { operationId: id, state: last === 'SETTLED' ? 'COST_COMPUTED' : (last as OperationState), stop: blk ? blk.stop : null, replayed: true };
    }
    if (kinds.includes('SENT')) {
      // intention recorded, no terminal: possibly charged; isolate; never resend
      const p = lines.find((l) => l.kind === 'RESERVED')?.body as { provider: Provider; batchId: string } | undefined;
      if (p && ledger.reservedOf(id) !== null) ledger.markUncertain(id, p.provider, p.batchId);
      journal.append('UNCERTAIN_ISOLATED', id, { reason: 'crash_after_sent', possiblyCharged: true });
      return { operationId: id, state: 'UNCERTAIN', stop: 'STOP_UNCERTAIN', replayed: true };
    }
    if (kinds.includes('RESERVED')) {
      const p = lines.find((l) => l.kind === 'RESERVED')!.body as { provider: Provider; batchId: string };
      if (ledger.reservedOf(id) !== null) ledger.release(id, p.provider, p.batchId);
      journal.append('ABORTED_BEFORE_SEND', id, { reason: 'crash_before_sent_reservation_released' });
      return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: null, replayed: true };
    }
    // PLANNED / snapshot committed but never reserved: abort (snapshot stays; a new attempt needs a new rep)
    journal.append('ABORTED_BEFORE_SEND', id, { reason: 'crash_before_reserve' });
    return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: null, replayed: true };
  };

  async function run(plan: OperationPlan): Promise<RunnerResult> {
    if (busy) throw new Error('executor is serial: concurrent run refused');
    if (lost) throw new BatchLockedError('LOCK_LOST', lockPath, 'another executor took over this batchDir');
    busy = true;
    try {
      const id = operationIdOf(plan);
      // R15-M1: a known operation must be the SAME plan: compare the PLANNED line with the current promptSha256 / cache arm / request body before any replay decision
      const plannedLine = journal.of(id).find((l) => l.kind === 'PLANNED');
      if (plannedLine) {
        const pb = plannedLine.body as { promptSha256: string; plannedCacheArm: string; requestBodySha256: string };
        const ad = cfg.adapters[plan.api];
        let currentBody: string | 'UNAVAILABLE' = 'UNAVAILABLE';
        if (ad && ad.provider === plan.provider) { try { currentBody = sha256Canon(ad.buildRequest(plan, await cfg.contentStore.get(plan.promptSha256)).body); } catch { currentBody = 'UNAVAILABLE'; } }
        if (pb.promptSha256 !== plan.promptSha256 || pb.plannedCacheArm !== plan.plannedCacheArm || currentBody !== pb.requestBodySha256) {
          journal.append('REPLAY_PLAN_MISMATCH', id, { plannedPromptSha256: pb.promptSha256, promptSha256: plan.promptSha256, plannedCacheArm: pb.plannedCacheArm, cacheArm: plan.plannedCacheArm, plannedRequestBodySha256: pb.requestBodySha256, requestBodySha256: currentBody });
          return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_REPLAY_PLAN_MISMATCH', replayed: true };
        }
      }
      const replay = replayDecision(id); if (replay) return replay;
      // C158 §3 (G7): LATCH. A previous G7 stop in THIS batch journal blocks every NEW operation, also after a restart (replay of the stopped operation returns stop:null, so without
      // the latch the restarted loop would go on to the next operation). It is cleared only by a human decision: a new batch directory / plan (never by retrying here).
      // BOT-01 M19: the same hole existed for STOP_CAP_VIOLATION and STOP_STOP_REASON_MISSING (blocking stops journaled AFTER the settlement/isolation: the replay of that operation returns
      // stop:null), so the latch covers all three. Stops that isolate an arm/condition (STOP_THINKING_DISABLED_REJECTED, price unknown, batch size...) are NOT latched here.
      // cycle 2: derived (journal facts), so also an uncertain operation or a settled-but-unflagged G7 breach blocks every new operation, restart included
      const latched = blockingStop(journal.lines(), { stopReasonRequired: cfg.integrity?.stopReasonRequired });
      if (latched) { journal.append('ABORTED_BEFORE_SEND', id, { reason: latched.stop, latchedBy: latched.by, latchKind: latched.kind }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: latched.stop, replayed: false }; }
      const adm = cfg.admit?.(plan) ?? null;
      if (adm?.kind === 'SKIP') { journal.append('SKIPPED_GATE', id, { reason: adm.reason, condition: plan.condition ?? null }); return { operationId: id, state: 'SKIPPED_GATE', stop: null, replayed: false }; }
      if (adm?.kind === 'STOP') { journal.append(adm.stop.startsWith('PAUSE_') ? 'PAUSE_REVIEW' : 'STOP_GLOBAL', id, { reason: adm.stop, ...(adm.detail ?? {}) }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: adm.stop, replayed: false }; }
      const s = stop.check(); if (s) { journal.append('STOP_GLOBAL', id, { reason: s }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: s, replayed: false }; }
      const adapter = cfg.adapters[plan.api]; if (!adapter || adapter.provider !== plan.provider) { journal.append('NOT_SUPPORTED', id, { reason: 'adapter_missing', api: plan.api }); return { operationId: id, state: 'NOT_SUPPORTED', stop: null, replayed: false }; }
      // R2 item 11: locked branch (Google) is NOT_RUN unless REAL mode with its own GO (the GO is validated per provider in preflight)
      // E3G (C160 BRACO-GO): the arm models (gemini-3.1-flash-lite, gpt-6-luna) are not under the DEFAULT lock (they have their own fail-closed gates below); an EXPLICIT lockedProviders list still locks them
      if (locked.has(plan.provider) && egress.mode !== 'REAL' && !(cfg.lockedProviders === undefined && isArmModel(plan.modelRequested))) { journal.append('NOT_RUN_BRANCH_LOCKED', id, { provider: plan.provider, reason: 'branch_locked_until_own_go' }); return { operationId: id, state: 'NOT_RUN_BRANCH_LOCKED', stop: null, replayed: false }; }
      if (cfg.consecutiveFailureStop && (failures[plan.modelRequested] ?? 0) >= cfg.consecutiveFailureStop) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_CONSECUTIVE_FAILURES', model: plan.modelRequested }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_CONSECUTIVE_FAILURES', replayed: false }; }
      // R2 item 12: 80% of the provider sub-ledger ⇒ pause for human review unless explicitly acknowledged
      if (cfg.attemptsBudget && cfg.attemptsBudget.used() >= cfg.attemptsBudget.max) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_MAX_ATTEMPTS', used: cfg.attemptsBudget.used(), max: cfg.attemptsBudget.max }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_MAX_ATTEMPTS', replayed: false }; }
      if (ledger.pauseThresholdReached(plan.provider, 80)) {
        // R15-M4: only a SIGNED acknowledgement counts (human:<name>); in REAL mode it must come from the GO; it is journaled once per provider
        const signed = (a: PauseAck) => a.provider === plan.provider && /^human:\S/.test(a.acknowledgedBy) && (egress.mode === 'REAL' ? a.source === 'go' : true);
        const ack = (cfg.pauseAck ?? []).find(signed);
        const pre = (cfg.preAuthorizedTo100 ?? []).find(signed);
        if (ack) { if (!journal.lines().some((l) => l.kind === 'PAUSE_ACK' && (l.body as { provider?: string }).provider === plan.provider)) journal.append('PAUSE_ACK', id, { provider: plan.provider, acknowledgedBy: ack.acknowledgedBy, source: ack.source, reference: ack.reference }); }
        else if (pre && cfg.remainingScopeCapPico) {
          // C144 D144-06: continue past 80 % ONLY if committed + every future worst-case reservation of the remaining scope fits the sub-ledger
          const st = ledger.state().providers[plan.provider]; const committed = BigInt(st.spentUsd) + BigInt(st.possiblyChargedUsd) + BigInt(st.reservedUsd); const future = cfg.remainingScopeCapPico(plan.provider); const cap = BigInt(st.capUsd);
          if (committed + future > cap) { journal.append('PAUSE_REVIEW', id, { reason: 'PAUSE_REVIEW_AT_80PCT', provider: plan.provider, preauthorized: true, detail: 'future_reservations_exceed_subledger', committed: committed.toString(), futureWorstCase: future.toString(), cap: cap.toString() }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'PAUSE_REVIEW_AT_80PCT', replayed: false }; }
          if (!journal.lines().some((l) => l.kind === 'PAUSE_PREAUTHORIZED' && (l.body as { provider?: string }).provider === plan.provider)) journal.append('PAUSE_PREAUTHORIZED', id, { provider: plan.provider, acknowledgedBy: pre.acknowledgedBy, source: pre.source, reference: pre.reference, committed: committed.toString(), futureWorstCase: future.toString(), cap: cap.toString() });
        }
        else { journal.append('PAUSE_REVIEW', id, { reason: 'PAUSE_REVIEW_AT_80PCT', provider: plan.provider, preauthorized: Boolean(pre), detail: pre ? 'no_remaining_scope_information' : 'no_signed_acknowledgement' }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'PAUSE_REVIEW_AT_80PCT', replayed: false }; }
      }
      // R2 item 12: batch ≤ 60 calls and one model per batch (checked against the journal, so it survives restarts)
      const bs = batchStats(plan.batchId);
      if (!cfg.econ && bs.models.size && !bs.models.has(plan.modelRequested)) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_BATCH_MODEL_MIX', batchId: plan.batchId }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_BATCH_MODEL_MIX', replayed: false }; }

      // E3G A1/A2 (arm only, PRE-SEND, nothing reserved): attested price table covering the model; one ledger per provider with the named arm profile (US$ 1,00)
      if (isArmModel(plan.modelRequested)) {
        if (!armPriceAttested(cfg.prices, plan.modelRequested)) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_ARM_PRICE_NOT_ATTESTED', model: plan.modelRequested, priceTable: cfg.prices.id }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_ARM_PRICE_NOT_ATTESTED', replayed: false }; }
        const lv = cfg.econ ? null : armLedgerViolation(plan.modelRequested, cfg.ledger, cfg.ledgerPath);
        if (lv) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_ARM_LEDGER', model: plan.modelRequested, detail: lv }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_ARM_LEDGER', replayed: false }; }
      }
      // ---- build (pure) + preflight (no side effects yet)
      const content = await cfg.contentStore.get(plan.promptSha256);
      const req = adapter.buildRequest(plan, content);
      // E3G (DR-208): the OpenAI arm request must carry service_tier "default" (Standard) in its body, every time (the adapter already refuses otherwise; checked again on the built body)
      if (plan.provider === 'openai' && isArmModel(plan.modelRequested) && (req.body as { service_tier?: unknown } | null)?.service_tier !== E3G_TIER_RULE.openai.requested) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_ARM_TIER_NOT_FIXED', model: plan.modelRequested }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_ARM_TIER_NOT_FIXED', replayed: false }; }
      const requestBodySha256 = sha256Canon(req.body);
      let goMaxCalls: number | null = null; let sendToken = '';
      try { const pf = egress.preflight({ provider: plan.provider, phase: plan.phase, modelRequested: plan.modelRequested, batchId: plan.batchId, executorVersion: EXECUTOR_VERSION, executorCodeSha: cfg.executorCodeSha, ledgerCaps: { campaignUsd: cfg.ledger.campaignUsd, providerUsd: cfg.ledger.providersUsd[plan.provider] }, batchCapUsd: cfg.ledger.batchesUsd?.[plan.batchId] }, req, adapter.officialHosts); goMaxCalls = pf.goMaxCalls; sendToken = pf.token; }
      catch (e) {
        // EXEC-ECON delta 4 (R-D1): a refusal of the ECON GO in the egress (expired, not yet valid, out of scope...) is a NON-terminal pause of this
        // attempt (PAUSE_REVIEW, filtered by the replay): nothing reserved or sent, and the same attempt runs first under a new valid GO (prefix kept).
        if (cfg.econ && e instanceof EgressGoEconRefused) { journal.append('PAUSE_REVIEW', id, { reason: 'PAUSE_ECON_GO', gate: 'EGRESS', code: e.code }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'PAUSE_ECON_GO', replayed: false }; }
        // EXEC-ECON delta 5 (R-D4): in the study, EVERY other pre-send refusal of the egress (credential file missing, forbidden env present, ambiguous
        // source, host not allowed, real flag, ...) is also a NON-terminal pause: nothing reserved or sent; the same attempt runs first after the fix.
        if (cfg.econ) { const code = e instanceof EgressRefused ? e.code : 'EGRESS_ERROR'; journal.append('PAUSE_REVIEW', id, { reason: 'PAUSE_ECON_EGRESS', gate: 'EGRESS', code }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'PAUSE_ECON_EGRESS', replayed: false }; }
        const code = e instanceof EgressRefused ? e.code : 'EGRESS_ERROR'; journal.append('ABORTED_BEFORE_SEND', id, { reason: code }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: null, replayed: false };
      }
      const maxCalls = Math.min(cfg.maxBatchCalls ?? DEFAULT_MAX_BATCH_CALLS, DEFAULT_MAX_BATCH_CALLS, goMaxCalls ?? DEFAULT_MAX_BATCH_CALLS);
      if (bs.calls >= maxCalls) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_BATCH_SIZE', batchId: plan.batchId, calls: bs.calls, max: maxCalls }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_BATCH_SIZE', replayed: false }; }

      // ---- local count (H1 counter, imported; incomplete => UNSUPPORTED_FOR_ESTIMATION; never a guessed L0)
      const support = adapter.modelSupport(plan.modelRequested);
      const counter = createLocalCounter(support, { maxTextBytes: cfg.maxTextBytes ?? 4_000_000 });
      counter.observeInput({ api: plan.api, body: req.body });
      if (req.nonTextParts.length) counter.markOutputUncovered('non_text_input');
      const lc = counter.finish();
      const inputCount = lc.counts.find((c) => c.category === 'input');
      // pre-call the output category is always uncovered (status 'incomplete' is the normal pre-call state); L0 is valid only when
      // the input category was counted, nothing about the input is uncovered/failed and every part is text.
      const inputCovered = (lc.status === 'ok' || lc.status === 'incomplete') && lc.covered.includes('input') && !lc.uncovered.includes('input');
      const L0: Count = inputCovered && inputCount && req.nonTextParts.length === 0 ? Number(inputCount.count) : 'UNKNOWN';
      const estimateStatus = L0 === 'UNKNOWN' ? 'UNSUPPORTED_FOR_ESTIMATION' : 'ESTIMATED';

      // ---- cap by the price table (price unknown => STOP before any reservation)
      const nowUtc = clock();
      const reservedInputUpperBound = cfg.capPolicy.inputUpperBoundTokens(plan, L0); // C158 §3: the SAME number the reservation was priced with (kept to compare with the measured input)
      // BOT-01 A02 (PRE-SEND gate): a reservation whose input upper bound is BELOW the local count of the very input about to be sent is insufficient by construction: nothing is reserved or sent.
      if (typeof L0 === 'number' && L0 > reservedInputUpperBound) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_INPUT_ABOVE_RESERVATION', phase: 'PRE_SEND', localCount: L0, reservedInputUpperBoundTokens: reservedInputUpperBound }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_INPUT_ABOVE_RESERVATION', replayed: false }; }
      // C158 §3.2 (ECON-02): conservative input reserve policy as a pre-send gate (only when configured). The planned bound below the policy bound, an unknown local count, tools, or a length outside the measured range => nothing reserved, nothing sent.
      const reserveGate = evaluateInputReserve(cfg.inputReservePolicy === 'none' ? undefined : cfg.inputReservePolicy, { provider: plan.provider, model: plan.modelRequested, L0, plannedBound: reservedInputUpperBound, hasTools: Array.isArray((req.body as { tools?: unknown } | null)?.tools) && ((req.body as { tools: unknown[] }).tools.length > 0), probeCovers: cfg.modelProbe !== undefined });
      if (reserveGate.stop) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_INPUT_RESERVE_POLICY', phase: 'PRE_SEND', gate: reserveGate.reason, policy: (cfg.inputReservePolicy as { id: string }).id, localCount: L0, plannedInputUpperBoundTokens: reservedInputUpperBound, policyBoundTokens: reserveGate.policyBoundTokens ?? null, detail: reserveGate.detail }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_INPUT_RESERVE_POLICY', replayed: false }; }
      // C158 model probe: the FIRST operation of a probe region (new anthropic model / L0 outside the measured range) is the probe; the rest of the region runs only after a journaled PASSED verdict.
      let probeKey: string | null = null; let licensedMax: number | null = null;
      if (cfg.modelProbe) {
        const region = probeRegionOf(plan.provider, plan.modelRequested, L0);
        if (region !== null) {
          const hasToolsNow = Array.isArray((req.body as { tools?: unknown } | null)?.tools) && ((req.body as { tools: unknown[] }).tools.length > 0);
          if (region === 'L0_UNKNOWN' || hasToolsNow) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_MODEL_PROBE_FAILED', phase: 'PRE_SEND', gate: region === 'L0_UNKNOWN' ? 'L0_UNKNOWN' : 'TOOLS_PRESENT', detail: 'the probe cannot be judged (local count unknown / tools present): nothing reserved or sent' }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_MODEL_PROBE_FAILED', replayed: false }; }
          const key = probeKeyOf(plan.provider, plan.modelRequested, region); const st = probeStateOf(journal.lines(), key);
          if (region.startsWith('ABOVE_RANGE_B')) licensedMax = aboveRangeBand(measuredRangeOf(plan.modelRequested)!.max, L0 as number).licensedMaxLocalCount;
          if (st === 'NONE') probeKey = key; // this operation is the probe
          else if (st === 'UNRESOLVED') { journal.append('ABORTED_BEFORE_SEND', id, { reason: 'STOP_MODEL_PROBE_FAILED', probe: key, detail: 'probe started without a PASSED verdict' }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_MODEL_PROBE_FAILED', replayed: false }; }
        }
      }
      const cap = computeCostCap(cfg.prices, { provider: plan.provider, model: plan.modelRequested, api: plan.api, inputUpperBoundTokens: reservedInputUpperBound, maxOutputTokens: plan.params.maxTokens, reasoningAllowanceTokens: cfg.capPolicy.reasoningAllowanceTokens(plan), atUtc: nowUtc,
        // EXEC-ECON items 5 and 9: only under the H_PARITY body (no cache_control is sent) and only when the caller declares the G-7b result
        ...(plan.params.bodyProfile === 'H_PARITY' && plan.params.cacheDirectives === 'NONE' ? { noCacheWrite: true } : {}), ...(cfg.capPolicy.thoughtsBoundedByMaxOutput?.(plan) === true ? { thoughtsBoundedByMaxOutput: true } : {}) });
      if ('error' in cap) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_PRICE_UNKNOWN', missing: cap.missing }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_PRICE_UNKNOWN', replayed: false }; }

      // ---- PLANNED → snapshot (fsync) → RESERVED (fsync) → SENT (fsync) → egress
      journal.append('PLANNED', id, { batchId: plan.batchId, phase: plan.phase, cellId: plan.cellId, groupId: plan.groupId, promptId: plan.promptId, rep: plan.rep, variant: plan.variant, split: plan.split, provider: plan.provider, api: plan.api, modelRequested: plan.modelRequested, task: plan.task, sizeBucket: plan.sizeBucket, structure: plan.structure, modality: plan.modality, promptSha256: plan.promptSha256, prefixSha256: plan.prefixSha256, requestBodySha256, plannedCacheArm: plan.plannedCacheArm, condition: plan.condition ?? null, probe: plan.probe ?? null, ...(plan.econSeq !== undefined ? { econSeq: plan.econSeq } : {}) });
      crash('after_planned');
      const before = ledger.state().providers[plan.provider];
      const snap: PrecallSnapshot = sealSnapshot({
        schema: H2EVAL_SCHEMA.snapshot, snapshotId: `snap_${id.slice(0, 16)}`, operationId: id, tsUtc: nowUtc, executorVersion: EXECUTOR_VERSION, executorCodeSha: cfg.executorCodeSha,
        modelRequested: plan.modelRequested, provider: plan.provider, api: plan.api, requestBodySha256, promptSha256: plan.promptSha256, prefixSha256: plan.prefixSha256, params: plan.params,
        counter: { version: lc.counterVersion, L0, status: lc.status, reasons: [...counter.reasons], exploratoryFormulaEstimate: plan.modality === 'image' ? (cfg.exploratoryFormula?.(plan, req, content) ?? null) : null }, estimateStatus,
        covariates: { task: plan.task, sizeBucket: plan.sizeBucket, structure: plan.structure, hasSystem: content.messages.some((m) => m.role === 'system'), nTurns: content.messages.filter((m) => m.role === 'user').length, family: 'UNKNOWN', L0 },
        ...(cfg.predictor ? cfg.predictor(plan, L0, cfg.prices.micro(plan.provider, plan.modelRequested, 'input', nowUtc, typeof L0 === 'number' ? L0 : undefined), cfg.prices.micro(plan.provider, plan.modelRequested, 'output', nowUtc, typeof L0 === 'number' ? L0 : undefined)) : { profile: null, expectedCostUsd: 'UNKNOWN' as const }),
        priceSnapshot: { id: cfg.prices.id, sha256: cfg.prices.sha256, capturedUtc: cfg.prices.capturedUtc },
        costCap: cap, budgetBefore: { provider: plan.provider, spentUsd: before.spentUsd, reservedUsd: before.reservedUsd, capUsd: before.capUsd },
        cachePlan: { arm: plan.plannedCacheArm, directives: plan.params.cacheDirectives, minPrefixTokens: 'UNKNOWN', expectedBehavior: plan.plannedCacheArm === 'S1' ? 'single_message' : plan.plannedCacheArm === 'S2_NOHIT' ? 'nonce_per_call_no_hit' : 'stable_prefix_hit_attempt', ...cacheEstimates(plan, content) },
        maxTokens: plan.params.maxTokens, condition: plan.condition ?? null, gateUsed: cfg.gateUsed ?? null,
        forecast: buildForecast(plan, L0, cfg.prices.micro(plan.provider, plan.modelRequested, 'input', nowUtc, typeof L0 === 'number' ? L0 : undefined), cfg.prices.micro(plan.provider, plan.modelRequested, 'output', nowUtc, typeof L0 === 'number' ? L0 : undefined), cfg.forecastTable ?? null),
      });
      try { writeSnapshot(cfg.batchDir, snap); } catch (e) { const code = e instanceof SnapshotError ? e.code : 'PERSISTENCE'; journal.append('STOP_GLOBAL', id, { reason: 'STOP_PERSISTENCE', detail: code }); return { operationId: id, state: 'ABORTED_BEFORE_SEND', stop: 'STOP_PERSISTENCE', replayed: false }; }
      journal.append('PRECALL_SNAPSHOT_COMMITTED', id, { snapshotSha256: snap.snapshotSha256, costCapUsd: cap.usd, L0, estimateStatus });
      crash('after_snapshot');
      try { ledger.reserve(id, plan.provider, plan.batchId, BigInt(cap.usd)); }
      catch (e) { if (e instanceof BudgetStop) { journal.append('STOP_BUDGET', id, { reason: e.reason, ...e.detail }); return { operationId: id, state: 'STOP_BUDGET', stop: e.reason, replayed: false }; } throw e; }
      if (probeKey) journal.append('MODEL_PROBE_STARTED', id, { key: probeKey, ...(licensedMax !== null ? { licensedMaxLocalCount: licensedMax } : {}), provider: plan.provider, model: plan.modelRequested, localCount: L0, reservedInputUpperBoundTokens: reservedInputUpperBound, maxMeasuredToEstimatedRatio: cfg.modelProbe!.maxMeasuredToEstimatedRatio });
      journal.append('RESERVED', id, { provider: plan.provider, batchId: plan.batchId, usd: cap.usd, reservedInputUpperBoundTokens: reservedInputUpperBound, ...(cfg.inputReservePolicy === undefined ? {} : cfg.inputReservePolicy === 'none' ? { reservePolicy: 'none' } : reserveGate.stop === false && reserveGate.applicable ? { reservePolicy: cfg.inputReservePolicy.id, policyBoundTokens: reserveGate.policyBoundTokens, extrapolated: reserveGate.extrapolated === true } : { reservePolicy: 'NOT_APPLICABLE' }) });
      crash('after_reserved');
      const tsSent = clock(); const sentAtMs = Date.now();
      // E1‴ R-INST: sha256 of the exact body bytes handed to the transport (wireBody, the string egress.send passes on); never throws (NOT_AVAILABLE + reason)
      journal.append('SENT', id, { requestBodySha256, mode: egress.mode, ...wireFields(wireBodySha256Of(req)) });
      cfg.attemptsBudget?.onSend();
      crash('after_sent');

      let httpStatus: number | 'UNKNOWN' = 'UNKNOWN'; let body: unknown = null; let uncertain = false; let sendCode = 'NONE'; let failure: SendFailureClass | null = null;
      let sendRes: unknown = null;
      try { const r = await egress.send(plan.provider, req, sendToken); httpStatus = r.httpStatus; body = r.body; sendRes = r; }
      catch (e) { uncertain = true; sendCode = e instanceof EgressRefused ? e.code : e instanceof EgressTimeout ? 'TIMEOUT' : 'SEND_FAILED'; failure = classifySendFailure(e); }
      // E1‴ R-INST: provider request id, outside the send try (it never throws and cannot turn a response into an uncertain operation); no response ⇒ NOT_AVAILABLE/NO_RESPONSE
      const requestId: InstrumentedValue = uncertain ? { value: NOT_AVAILABLE, reason: 'NO_RESPONSE' } : providerRequestIdFromResponse(plan.provider, sendRes);
      crash('after_response');
      if (uncertain) {
        ledger.markUncertain(id, plan.provider, plan.batchId);
        // CYCLE2-A: the cause code (non-secret identifier), the derived phase hint and the elapsed time are journaled for forensics; the state stays UNCERTAIN
        journal.append('TIMEOUT_UNCERTAIN', id, { possiblyCharged: true, code: sendCode, causeCode: failure?.causeCode ?? 'UNKNOWN', phaseHint: failure?.phaseHint ?? 'unknown', elapsedMs: Math.max(0, Date.now() - sentAtMs), ...requestIdFields(requestId) });
        journal.append('UNCERTAIN_ISOLATED', id, { reason: 'send_failed_or_timeout' });
        writeRecord({ operationId: id, outcome: 'TIMEOUT_UNCERTAIN', modelDeprecation: 'UNKNOWN', exclusion: 'NONE', httpStatus, refusal: null, usage: null, responseSha256: 'UNKNOWN', cost: computeCost(cfg.prices, { provider: plan.provider, model: plan.modelRequested, api: plan.api, usage: null, atUtc: nowUtc, capUsd: cap.usd, prefixTokens: 'UNKNOWN', possiblyCharged: true }), tsSentUtc: tsSent, tsReceivedUtc: 'UNKNOWN', latencyMs: 'UNKNOWN', finalState: 'UNCERTAIN', stopReason: 'UNKNOWN', completion: 'UNKNOWN' });
        failures[plan.modelRequested] = (failures[plan.modelRequested] ?? 0) + 1;
        return { operationId: id, state: 'UNCERTAIN', stop: 'STOP_UNCERTAIN', replayed: false };
      }
      const tsRecv = clock();
      // EXEC-ECON item 3: the response is persisted by content (wx + fsync) before anything is parsed, settled or journaled as received.
      // A failure isolates the operation as uncertain (possibly charged, never resent): the money is not settled without the text on disk.
      let econResponseSha256: string | null = null;
      if (cfg.econ && body !== null && body !== undefined) {
        try { econResponseSha256 = persistResponse(cfg.batchDir, body); }
        catch (e) {
          ledger.markUncertain(id, plan.provider, plan.batchId);
          // no STOP_GLOBAL line on purpose: a non-latching STOP_GLOBAL would mark the operation as "isolated" and release the batch; the bare
          // UNCERTAIN_ISOLATED keeps blocking every new operation (also after a restart) until a human acknowledgement (blockingStop)
          journal.append('UNCERTAIN_ISOLATED', id, { reason: 'response_persistence_failed', possiblyCharged: true, stop: 'STOP_PERSISTENCE', detail: String((e as NodeJS.ErrnoException).code ?? 'PERSISTENCE') });
          return { operationId: id, state: 'UNCERTAIN', stop: 'STOP_PERSISTENCE', replayed: false };
        }
      }
      const refusal = adapter.parseRefusal(httpStatus as number, body);
      let usage: ReturnType<typeof validateUsage> | null = null;
      try { usage = validateUsage(adapter.parseUsage(body, { thinkingRequested: plan.params.thinking.mode !== 'none', ...(isArmModel(plan.modelRequested) ? { textOnly: true } : {}) })); } catch (e) { if (!(e instanceof UsageInvalid)) throw e; usage = null; }
      const usagePresent = usage !== null && usage.usageCompleteness !== 'MISSING';
      const outcome = refusal.refused ? (usagePresent ? 'REFUSED_WITH_USAGE' : 'ERROR_NO_USAGE') : usagePresent ? 'OK' : 'ERROR_NO_USAGE';
      // VNEXT-1 (C151): the provider's stop reason and the derived completion are journaled with the response (no inference from counts)
      journal.append(outcome === 'OK' ? 'RESPONSE_RECEIVED' : usagePresent ? 'ERROR_WITH_USAGE' : 'ERROR_NO_USAGE', id, { httpStatus, refusalCode: refusal.code, modelServed: usage?.modelServed ?? 'UNKNOWN', stopReason: usage?.stopReason ?? 'UNKNOWN', completion: usage?.completion ?? 'UNKNOWN', ...requestIdFields(requestId), ...(econResponseSha256 ? { responseSha256: econResponseSha256 } : {}) });
      if (usage) journal.append('USAGE_PARSED', id, { U: usage.U, inputUncached: usage.inputUncached, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h, outputVisible: usage.outputVisible, reasoning: usage.reasoning, outputTotal: usage.outputTotal, cacheObserved: usage.cacheObserved, completeness: usage.usageCompleteness });
      // E3G A3 (arm only): served tier must be Standard; otherwise the cost is NOT computed at the Standard price (UNKNOWN, possibly charged) and a latching STOP follows. Non-arm models: verdict ok, nothing changes.
      const tierV = usagePresent && usage ? servedTierVerdict(plan.modelRequested, usage.serviceTierServed) : null;
      const tierBad = tierV !== null && !tierV.ok;
      // E3G2: Gemini do braco sem cachedContentTokenCount (chave ausente) => liquida pelo LIMITE SUPERIOR (toda a entrada ao preco cheio); so esse caso exato, nunca 0
      const bounded = usagePresent && usage && !tierBad ? googleCacheUpperBound(plan.modelRequested, usage, body) : null;
      const cacheReadEvidence = bounded ? CACHE_READ_EVIDENCE_UPPER_BOUND : null;
      // EXEC-ECON delta 6 (ECON only): gpt-6-luna sem cache_write_tokens => liquida pelo LIMITE SUPERIOR (prompt inteiro ao preço da escrita + saída); custo declarado UPPER_BOUND
      const boundedW = cfg.econ && usagePresent && usage && !tierBad && !bounded ? openaiCacheWriteUpperBound(plan.modelRequested, usage, body) : null;
      const cacheWriteEvidence = boundedW ? CACHE_WRITE_EVIDENCE_UPPER_BOUND : null;
      const usageRec = usage && bounded ? googleUpperBoundRecordUsage(usage, bounded) : usage && boundedW ? { ...usage, U: boundedW.U } : usage; // E3G4 (B4): registro/dataset com U = promptTokenCount; fora do caso exato, a mesma usage
      const cost0 = computeCost(cfg.prices, { provider: plan.provider, model: plan.modelRequested, api: plan.api, usage: usagePresent && !tierBad ? (bounded ?? boundedW ?? usage) : null, atUtc: nowUtc, capUsd: cap.usd, prefixTokens: 'UNKNOWN', possiblyCharged: !usagePresent || tierBad });
      const cost = boundedW && cost0.state === 'CALCULATED' ? { ...cost0, state: 'UPPER_BOUND' as const } : cost0;
      // limite inferior declarado (só no limite superior): prompt ao menor preço de entrada (entrada, leitura ou escrita) + saída
      const costLowerUsd = boundedW && cost.state === 'UPPER_BOUND' ? (() => { const ps = (['input', 'input_cache_read', 'input_cache_write'] as const).map((k) => cfg.prices.micro(plan.provider, plan.modelRequested, k, nowUtc)).filter((x): x is bigint => x !== null); const pOut = cfg.prices.micro(plan.provider, plan.modelRequested, 'output', nowUtc); return ps.length && pOut !== null ? (BigInt(boundedW.U as number) * ps.reduce((a, b) => (b < a ? b : a)) + BigInt(boundedW.outputVisible as number) * pOut).toString() : null; })() : null;
      journal.append('COST_COMPUTED', id, { usd: cost.usd, state: cost.state, capCovered: cost.capCovered, capUsd: cap.usd, ...(isArmModel(plan.modelRequested) ? { tierServed: tierV?.served ?? 'UNKNOWN', tierBasis: tierV?.basis ?? 'NO_USAGE', priceTable: cfg.prices.id } : {}), ...(cacheReadEvidence ? { cacheReadEvidence, boundInputTokens: bounded!.U, recordedU: usageRec!.U, recordedUsageCompleteness: usageRec!.usageCompleteness } : {}), ...(cacheWriteEvidence ? { cacheWriteEvidence, costClass: 'UPPER_BOUND', boundInputTokens: boundedW!.U, boundOutputTokens: boundedW!.outputVisible, costLowerUsd } : {}) });
      const settleable = cost.state === 'CALCULATED' || cost.state === 'UPPER_BOUND';
      let finalState: OperationState = 'COST_COMPUTED'; let stopReason: StopReason | null = null;
      if (settleable && cost.capCovered === false) {
        ledger.markUncertain(id, plan.provider, plan.batchId);
        journal.append('STOP_GLOBAL', id, { reason: 'STOP_CAP_VIOLATION', usd: cost.usd, capUsd: cap.usd });
        finalState = 'STOP_BUDGET'; stopReason = 'STOP_CAP_VIOLATION';
      } else if (settleable) { ledger.settle(id, plan.provider, plan.batchId, BigInt(cost.usd as string)); journal.append('SETTLED', id, { usd: cost.usd, ...(cacheReadEvidence ? { cacheReadEvidence } : {}), ...(cacheWriteEvidence ? { cacheWriteEvidence, costClass: 'UPPER_BOUND' } : {}) }); }
      else { ledger.markUncertain(id, plan.provider, plan.batchId); journal.append('UNCERTAIN_ISOLATED', id, { reason: 'cost_unknown', possiblyCharged: true }); finalState = 'UNCERTAIN'; stopReason = 'STOP_UNCERTAIN'; }
      crash('after_settled'); // C158 cycle 2 (BOT-01 R01): hook for the window between the settlement and the STOP line
      if (tierBad) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_TIER_NOT_STANDARD', tierServed: tierV!.served, detail: tierV!.reason, moneyState: finalState }); stopReason = 'STOP_TIER_NOT_STANDARD'; }
      // C158 §3 (G7, BLOCKING): measured input above the input upper bound of the reservation. The total-cost check above does not see it (the cap also carries the unused output and the
      // reasoning allowance, so the cost can stay under the cap while the input is already beyond what was reserved for it). Evaluated AFTER the money was settled/isolated (the charge is real).
      const uG7 = bounded ?? usage; // E3G2: com o limite superior, a entrada medida e o promptTokenCount
      if (stopReason === null && usagePresent && uG7 && typeof uG7.U === 'number' && uG7.U > reservedInputUpperBound) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_INPUT_ABOVE_RESERVATION', measuredInputTokens: uG7.U, reservedInputUpperBoundTokens: reservedInputUpperBound, localCount: L0, moneyState: finalState }); stopReason = 'STOP_INPUT_ABOVE_RESERVATION'; }
      const accepted = cfg.acceptedModelsServed?.[plan.modelRequested];
      const exclusion: PostcallRecord['exclusion'] = usage && accepted && !accepted.includes(usage.modelServed) ? 'EXCL_MODEL_MISMATCH' : 'NONE';
      if (exclusion !== 'NONE') journal.append('COST_COMPUTED', id, { exclusion, modelServed: usage!.modelServed });
      // E1' (C158, 2026-11-12): uma RECUSA com usage completo (stop_reason=refusal, REFUSED_WITH_USAGE, exclusion NONE) e uma RESPOSTA valida do provedor: continua no journal, no dataset e no registro (outcome/refusal),
      // mas NAO conta como falha consecutiva (nao incrementa) e tambem nao zera uma sequencia de falhas REAIS em curso. Falhas reais (erro HTTP/usage incompleto = ERROR_NO_USAGE, timeout, modelServed fora dos aceitos) contam como antes.
      if (outcome === 'REFUSED_WITH_USAGE' && exclusion === 'NONE') { /* nem conta nem zera */ } else if (outcome !== 'OK' || exclusion !== 'NONE') failures[plan.modelRequested] = (failures[plan.modelRequested] ?? 0) + 1; else failures[plan.modelRequested] = 0;
      // VNEXT-8 integrity stops (R4): evaluated AFTER the money was settled/isolated (the charge is real either way)
      // a 400 to a thinking-disabled request: the money stays as the cost branch left it (no usage => possiblyCharged, conservative), but the STOP is the
      // R4 contingency one (ISOLATE_ARM: the OFF arms are NOT_RUN; switching to the ON policy is a human decision), not the generic STOP_UNCERTAIN (HALT_ALL)
      if (cfg.integrity?.thinkingDisabledRejectedStops && httpStatus === 400 && (req.body as { thinking?: { type?: string } }).thinking?.type === 'disabled') { journal.append('STOP_GLOBAL', id, { reason: 'STOP_THINKING_DISABLED_REJECTED', httpStatus, errorCode: refusal.code, moneyState: finalState }); stopReason = 'STOP_THINKING_DISABLED_REJECTED'; }
      else if (stopReason === null && cfg.integrity?.stopReasonRequired && usagePresent && usage!.stopReason === 'UNKNOWN') { journal.append('STOP_GLOBAL', id, { reason: 'STOP_STOP_REASON_MISSING', httpStatus }); stopReason = 'STOP_STOP_REASON_MISSING'; }
      if (probeKey) { // C158: judge the probe (measured vs estimated vs reservation); FAILED => blocking, no retry. Written after the settlement/integrity lines (the charge is real either way).
        const mu = usagePresent && usage ? { U: usage.U, outputVisible: usage.outputVisible, reasoning: usage.reasoning, outputTotal: usage.outputTotal, completion: usage.completion, tierServed: usage.serviceTierServed } : null;
        // E1HR (C160): the response facts that admit a REFUSAL_WITH_USAGE / max_tokens-truncated probe (HAIKU-R protocol §5.1); everything else keeps failing
        const response = { httpStatus, outcome, stopReason: usage?.stopReason ?? 'UNKNOWN', usageCompleteness: usage?.usageCompleteness ?? 'MISSING', modelServed: usage?.modelServed ?? 'UNKNOWN', modelRequested: plan.modelRequested, ...(accepted ? { acceptedModels: accepted } : {}), costState: cost.state, exclusion };
        const jd = judgeProbe({ limit: cfg.modelProbe!.maxMeasuredToEstimatedRatio, L0: L0 as number, reservedBound: reservedInputUpperBound, usage: mu, tierRequested: String(plan.params.serviceTier), reasoningAllowance: cfg.capPolicy.reasoningAllowanceTokens(plan), response });
        journal.append('MODEL_PROBE_RESULT', id, { key: probeKey, ...(licensedMax !== null ? { licensedMaxLocalCount: licensedMax } : {}), verdict: jd.verdict, reasons: jd.reasons, ratio: jd.ratio, limit: cfg.modelProbe!.maxMeasuredToEstimatedRatio, localCount: L0, reservedInputUpperBoundTokens: reservedInputUpperBound, measured: mu ?? 'UNKNOWN' });
        if (jd.verdict === 'FAILED' && stopReason === null) { journal.append('STOP_GLOBAL', id, { reason: 'STOP_MODEL_PROBE_FAILED', probe: probeKey, reasons: jd.reasons }); stopReason = 'STOP_MODEL_PROBE_FAILED'; }
      }
      const modelDeprecation = usage && usage.modelServed !== 'UNKNOWN' ? (adapter.modelDeprecation?.(usage.modelServed) ?? 'UNKNOWN') : 'UNKNOWN';
      const responseSha256 = body === null || body === undefined ? 'UNKNOWN' : sha256Hex(JSON.stringify(body));
      writeRecord({ operationId: id, outcome, modelDeprecation, exclusion, httpStatus, refusal, usage: usageRec, responseSha256, cost, tsSentUtc: tsSent, tsReceivedUtc: tsRecv, latencyMs: Math.max(0, Date.parse(tsRecv) - Date.parse(tsSent)), finalState, stopReason: usage?.stopReason ?? 'UNKNOWN', completion: usage?.completion ?? 'UNKNOWN', ...(cacheReadEvidence ? { cacheReadEvidence } : {}), ...(cacheWriteEvidence ? { cacheWriteEvidence, costLowerUsd } : {}) } as PostcallRecord);
      return { operationId: id, state: finalState, stop: stopReason, replayed: false };
    } catch (e) {
      if (e instanceof JournalPersistenceError) throw e; // persistence failure: caller must STOP; nothing further is attempted
      throw e;
    } finally { busy = false; }
  }
  return { run, journal, ledger, mode: egress.mode, close };
}

