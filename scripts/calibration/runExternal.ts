/**
 * D8-G03 — external calibration runner (front B prepares; ONLY S4 executes against a real
 * provider, under the single budget ledger; 01_DECISOES_APROVADAS.md "Credenciais e orçamento").
 *
 * The runner never reads environment variables, files with keys or the ledger directly: S4
 * injects (a) a count client whose key getter it controls and (b) a ledger port that reserves
 * before each call and settles after it. A denial stops the run (no retry that could reset a
 * ceiling). Output rows carry ids, counts and statuses only — never document text, headers or keys.
 *
 * Target semantics are recorded per row: 'provider_count_endpoint' (e.g. Anthropic
 * /v1/messages/count_tokens, documented by the provider as an estimate, not billed usage) is not
 * the final usage of a generation and is not an invoice (D8 §5).
 *
 *   npx tsx scripts/calibration/runExternal.ts --simulate [--out <file.json>]
 * runs the whole pipeline against the local simulator (127.0.0.1, port 0). Nothing else is
 * runnable from this CLI on purpose.
 *
 * In short: for each corpus document (round-robin by family) it reserves budget, asks an injected count client for
 * the provider's input-token count, settles the reservation, and records one row; then `analyzeExternal` fits and
 * evaluates the calibration models of `./models.ts` with the same method as `runOffline.ts`. Exit code 2 when run
 * without `--simulate`. Amounts are in micro-USD (1 USD = 1,000,000), as bigint.
 *
 * @module scripts/calibration/runExternal
 */
import { writeFileSync } from 'node:fs';
import { splitOf, type CorpusDoc } from './corpus.js';
import { evaluateScenario, loadCorpus } from './runOffline.js';
import type { Row } from './models.js';
import { countWith, loadEncoding, type LocalEncoding } from '../../src/tokenization/tokenizerIdentity.js';
import { startSimulatedAnthropic } from './simulatedProvider.js';

/** Version tag of the runner; prefixes every ledger call id. */
export const EXTERNAL_RUNNER_VERSION = 'otk.calibration_external.b4@1';

/** What the target count is: a provider's token-count endpoint (an estimate) or the final usage of a generation. */
export type TargetKind = 'provider_count_endpoint' | 'final_usage';

/** A source of provider token counts for one document at a time (real or simulated). */
export interface ExternalCountClient {
  /** Provider, API, model and endpoint called; `simulated` is `true` for the local simulator. */
  readonly description: { provider: string; api: string; model: string; endpoint: string; targetKind: TargetKind; simulated: boolean };
  /**
   * Asks for the input-token count of one document. May make a network request (and spend money).
   * Rejects with an error whose `code` names the failure (for example `http_429`).
   */
  count(doc: { id: string; text: string }): Promise<{ inputTokens: number; providerRequestId: string | null }>;
}

/** Budget port implemented by S4 over its ledger (scripts/pilot). Amounts in micro-USD. */
export interface BudgetLedgerPort {
  /** Reserves up to `maxUsdMicros` for one call before it is made; `'denied'` stops the run. */
  reserve(req: { callId: string; maxUsdMicros: bigint; purpose: string }): Promise<'approved' | 'denied'>;
  /** Settles a reserved call; `actualUsdMicros = null` means the cost is unknown (left for reconciliation). */
  settle(callId: string, result: { actualUsdMicros: bigint | null; outcome: 'ok' | 'error' | 'uncertain' }): Promise<void>;
}

/** One document of an external run. Holds ids, counts and statuses only, never document text. */
export interface ExternalRow {
  docId: string;
  group: string;
  split: 'train' | 'validation' | 'test';
  family: string;
  sizeBucket: string;
  /** OTK's local text count (tokens) with the chosen local encoding. */
  local: number;
  /** Provider count (tokens); `null` unless `status` is `'ok'`. */
  target: number | null;
  status: 'ok' | 'skipped_empty' | 'denied_budget' | 'error';
  /** Failure code when `status` is `'error'` (for example `http_529`, `schema`, `invalid_count`); otherwise `null`. */
  errorCode: string | null;
  /** Provider's request id header, when it sent one. */
  providerRequestId: string | null;
  /** ISO 8601 time the row was recorded. */
  at: string;
}

/** Rows of a run and why it stopped. */
export interface ExternalRunResult {
  runner: string;
  client: ExternalCountClient['description'];
  localTokenizer: ReturnType<typeof loadEncoding>['identity'];
  rows: ExternalRow[];
  stoppedReason: 'completed' | 'budget_denied' | 'max_calls' | 'too_many_errors' | 'ledger_error';
}

/** Minimum rows per split before an external evaluation is reported (below that: null). */
export const MIN_ROWS = { train: 20, validation: 10, test: 10 } as const;

/**
 * Round-robin by family, so a stop (budget/max calls) leaves every family partially measured.
 *
 * @param docs - Documents (not mutated).
 * @returns The same documents, reordered: first of each family, then second of each family, and so on.
 */
export function interleaveByFamily(docs: CorpusDoc[]): CorpusDoc[] {
  const byFamily = new Map<string, CorpusDoc[]>();
  for (const d of docs) byFamily.set(d.family, [...(byFamily.get(d.family) ?? []), d]);
  const queues = [...byFamily.values()];
  const out: CorpusDoc[] = [];
  for (let i = 0; out.length < docs.length; i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}

/**
 * Runs the external calibration: one budget reservation, one count request and one settlement per document.
 *
 * Empty documents are skipped without a call. Stops at the first budget denial, at `maxCalls`, at a ledger error,
 * or after `maxConsecutiveErrors` (default 3) failed calls in a row. A failed call is settled as `'uncertain'`
 * with unknown cost, never as free. Side effects: whatever the injected client and ledger do (network, spending).
 *
 * @param opts - Documents, client, ledger and limits (see the field comments).
 * @returns All rows recorded so far and the stop reason; never rejects for a failed call.
 */
export async function runExternalCalibration(opts: {
  docs: CorpusDoc[];
  client: ExternalCountClient;
  ledger: BudgetLedgerPort;
  /** Unique id of this run (ledger idempotency must not merge two runs). */
  runId: string;
  /** Upper bound of provider calls in this run (never derived from remaining budget). */
  maxCalls: number;
  /** Worst-case cost reserved per call; the count endpoint may be free, but the reservation still runs. */
  reservePerCallUsdMicros: bigint;
  /**
   * Cost settled for a successful call. null (default) = unknown, left for reconciliation with
   * the provider's statement; S4 may pass 0n only with a dated source saying the call is free.
   */
  settledCostUsdMicros?: bigint | null;
  /** Tokenizer used for the local count. */
  localEncoding: LocalEncoding;
  /** Clock for the row timestamps (ISO 8601); default the system clock. */
  now?: () => string;
  /** Failed calls in a row that stop the run; default 3. */
  maxConsecutiveErrors?: number;
}): Promise<ExternalRunResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const enc = loadEncoding(opts.localEncoding);
  const rows: ExternalRow[] = [];
  let calls = 0;
  let consecutiveErrors = 0;
  let stoppedReason: ExternalRunResult['stoppedReason'] = 'completed';
  for (const d of interleaveByFamily(opts.docs)) {
    const base = { docId: d.id, group: d.group, split: splitOf(d.group), family: d.family, sizeBucket: d.sizeBucket, local: countWith(enc.encoder, d.text) };
    if (d.text.trim().length === 0) {
      rows.push({ ...base, target: null, status: 'skipped_empty', errorCode: null, providerRequestId: null, at: now() });
      continue;
    }
    if (calls >= opts.maxCalls) { stoppedReason = 'max_calls'; break; }
    const callId = `${EXTERNAL_RUNNER_VERSION}:${opts.runId}:${opts.client.description.model}:${d.id}`;
    let decision: 'approved' | 'denied';
    try {
      decision = await opts.ledger.reserve({ callId, maxUsdMicros: opts.reservePerCallUsdMicros, purpose: 'D8-G03 calibration count' });
    } catch {
      stoppedReason = 'ledger_error';
      break;
    }
    if (decision !== 'approved') {
      rows.push({ ...base, target: null, status: 'denied_budget', errorCode: null, providerRequestId: null, at: now() });
      stoppedReason = 'budget_denied';
      break;
    }
    calls++;
    let outcome: { ok: true; inputTokens: number; providerRequestId: string | null } | { ok: false; code: string };
    try {
      const r = await opts.client.count({ id: d.id, text: d.text });
      if (!Number.isSafeInteger(r.inputTokens) || r.inputTokens < 0) throw Object.assign(new Error('invalid count'), { code: 'invalid_count' });
      outcome = { ok: true, inputTokens: r.inputTokens, providerRequestId: r.providerRequestId };
    } catch (e) {
      outcome = { ok: false, code: (e as { code?: string }).code ?? 'request_failed' };
    }
    if (outcome.ok) {
      rows.push({ ...base, target: outcome.inputTokens, status: 'ok', errorCode: null, providerRequestId: outcome.providerRequestId, at: now() });
      consecutiveErrors = 0;
    } else {
      rows.push({ ...base, target: null, status: 'error', errorCode: outcome.code, providerRequestId: null, at: now() });
    }
    try {
      // A failed call may or may not have been processed: settled as uncertain, never as free.
      await opts.ledger.settle(callId, outcome.ok
        ? { actualUsdMicros: opts.settledCostUsdMicros ?? null, outcome: 'ok' }
        : { actualUsdMicros: null, outcome: 'uncertain' });
    } catch {
      stoppedReason = 'ledger_error';
      break;
    }
    if (!outcome.ok && ++consecutiveErrors >= (opts.maxConsecutiveErrors ?? 3)) { stoppedReason = 'too_many_errors'; break; }
  }
  return { runner: EXTERNAL_RUNNER_VERSION, client: opts.client.description, localTokenizer: enc.identity, rows, stoppedReason };
}

/**
 * Out-of-sample analysis of collected rows (same method as the offline experiment).
 *
 * @param result - A run result.
 * @returns Row counts per split, per-family coverage, the stop reason, the evaluation (`null` when a split has fewer
 *   rows than {@link MIN_ROWS}, with the reason) and a one-line statement of what the result does and does not mean.
 */
export function analyzeExternal(result: ExternalRunResult) {
  const rows: Record<'train' | 'validation' | 'test', Row[]> = { train: [], validation: [], test: [] };
  for (const r of result.rows) if (r.status === 'ok' && r.target !== null) rows[r.split].push({ id: r.docId, x: r.local, y: r.target });
  const counts = { train: rows.train.length, validation: rows.validation.length, test: rows.test.length };
  const enough = counts.train >= MIN_ROWS.train && counts.validation >= MIN_ROWS.validation && counts.test >= MIN_ROWS.test;
  const families = [...new Set(result.rows.map((r) => r.family))].sort();
  const familyCoverage = Object.fromEntries(families.map((f) => [f, {
    ok: result.rows.filter((r) => r.family === f && r.status === 'ok').length,
    total: result.rows.filter((r) => r.family === f).length,
  }]));
  return {
    client: result.client,
    counts,
    familyCoverage,
    stoppedReason: result.stoppedReason,
    evaluation: enough ? evaluateScenario(rows) : null,
    evaluationOmittedReason: enough ? null : `fewer rows than the minimum ${JSON.stringify(MIN_ROWS)}`,
    statement: result.client.simulated
      ? 'SIMULATED provider: validates the runner only; no claim about any real provider.'
      : `Calibration of the local text count against ${result.client.targetKind} of ${result.client.provider}/${result.client.model} via ${result.client.api}; describes this synthetic corpus, model id and date only (see familyCoverage and stoppedReason); not final usage, not an invoice.`,
  };
}

/**
 * Anthropic count_tokens client. The key getter is supplied by S4; it is called per request and
 * its value is only placed in the request header. Errors carry the HTTP status, never bodies.
 *
 * Each `count` makes one HTTPS request (15 s timeout) to the provider (or to `baseUrl`).
 *
 * @param opts - Model, key getter, optional base URL (default the public provider host), API version header value
 *   (default `2023-06-01`), fetch implementation (for tests) and the `simulated` flag for the description.
 * @returns A count client; its `count` rejects with `code` `http_<status>` on a non-2xx answer or `schema` when the
 *   answer has no numeric `input_tokens`.
 */
export function createAnthropicCountTokensClient(opts: {
  model: string;
  getApiKey: () => string;
  baseUrl?: string;
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
  simulated?: boolean;
}): ExternalCountClient {
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  const f = opts.fetchImpl ?? fetch;
  return {
    description: { provider: 'anthropic', api: 'anthropic.messages.count_tokens', model: opts.model, endpoint: `${baseUrl}/v1/messages/count_tokens`, targetKind: 'provider_count_endpoint', simulated: opts.simulated ?? false },
    async count(doc) {
      const res = await f(`${baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.getApiKey(), 'anthropic-version': opts.anthropicVersion ?? '2023-06-01' },
        body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: doc.text }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `http_${res.status}` });
      const body = (await res.json()) as { input_tokens?: unknown };
      if (typeof body.input_tokens !== 'number') throw Object.assign(new Error('no input_tokens'), { code: 'schema' });
      return { inputTokens: body.input_tokens, providerRequestId: res.headers.get('request-id') };
    },
  };
}

/**
 * In-memory ledger for simulation/tests only (never a substitute for S4's ledger).
 *
 * @param maxCalls - Reservations approved before every further one is denied.
 * @returns A ledger port that also exposes the number of reservations and the settled `<callId>:<outcome>` list.
 */
export function createSimulationLedger(maxCalls: number): BudgetLedgerPort & { reserved: number; settled: string[] } {
  const state = { reserved: 0, settled: [] as string[] };
  return {
    get reserved() { return state.reserved; },
    get settled() { return state.settled; },
    async reserve() { if (state.reserved >= maxCalls) return 'denied'; state.reserved++; return 'approved'; },
    async settle(callId, r) { state.settled.push(`${callId}:${r.outcome}`); },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--simulate')) {
    process.stderr.write('runExternal: only --simulate is runnable here; real runs are wired by S4 with its ledger and key getter.\n');
    process.exit(2);
  }
  const sim = await startSimulatedAnthropic();
  try {
    const { docs } = loadCorpus();
    const client = createAnthropicCountTokensClient({ model: 'claude-haiku-4-5', getApiKey: () => sim.acceptedKey, baseUrl: sim.baseUrl, simulated: true });
    const result = await runExternalCalibration({ docs, client, ledger: createSimulationLedger(10_000), runId: `simulate-${Date.now()}`, maxCalls: 10_000, reservePerCallUsdMicros: 0n, settledCostUsdMicros: 0n, localEncoding: 'cl100k_base' });
    const report = { ...analyzeExternal(result), rows: result.rows.length, simulatorRequests: sim.requests() };
    const json = JSON.stringify(report, null, 2) + '\n';
    const outIdx = args.indexOf('--out');
    if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, json, 'utf8');
    else process.stdout.write(json);
  } finally {
    await sim.close();
  }
}

if (process.argv[1] && /runExternal\.ts$/.test(process.argv[1])) void main();
