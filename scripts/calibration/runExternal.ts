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
 */
import { writeFileSync } from 'node:fs';
import { splitOf, type CorpusDoc } from './corpus.js';
import { evaluateScenario, loadCorpus } from './runOffline.js';
import type { Row } from './models.js';
import { countWith, loadEncoding, type LocalEncoding } from '../../src/tokenization/tokenizerIdentity.js';
import { startSimulatedAnthropic } from './simulatedProvider.js';

export const EXTERNAL_RUNNER_VERSION = 'otk.calibration_external.b4@1';

export type TargetKind = 'provider_count_endpoint' | 'final_usage';

export interface ExternalCountClient {
  readonly description: { provider: string; api: string; model: string; endpoint: string; targetKind: TargetKind; simulated: boolean };
  count(doc: { id: string; text: string }): Promise<{ inputTokens: number; providerRequestId: string | null }>;
}

/** Budget port implemented by S4 over its ledger (scripts/pilot). Amounts in micro-USD. */
export interface BudgetLedgerPort {
  reserve(req: { callId: string; maxUsdMicros: bigint; purpose: string }): Promise<'approved' | 'denied'>;
  settle(callId: string, result: { actualUsdMicros: bigint | null; outcome: 'ok' | 'error' | 'uncertain' }): Promise<void>;
}

export interface ExternalRow {
  docId: string;
  group: string;
  split: 'train' | 'validation' | 'test';
  family: string;
  sizeBucket: string;
  local: number;
  target: number | null;
  status: 'ok' | 'skipped_empty' | 'denied_budget' | 'error';
  errorCode: string | null;
  providerRequestId: string | null;
  at: string;
}

export interface ExternalRunResult {
  runner: string;
  client: ExternalCountClient['description'];
  localTokenizer: ReturnType<typeof loadEncoding>['identity'];
  rows: ExternalRow[];
  stoppedReason: 'completed' | 'budget_denied' | 'max_calls' | 'too_many_errors' | 'ledger_error';
}

/** Minimum rows per split before an external evaluation is reported (below that: null). */
export const MIN_ROWS = { train: 20, validation: 10, test: 10 } as const;

/** Round-robin by family, so a stop (budget/max calls) leaves every family partially measured. */
export function interleaveByFamily(docs: CorpusDoc[]): CorpusDoc[] {
  const byFamily = new Map<string, CorpusDoc[]>();
  for (const d of docs) byFamily.set(d.family, [...(byFamily.get(d.family) ?? []), d]);
  const queues = [...byFamily.values()];
  const out: CorpusDoc[] = [];
  for (let i = 0; out.length < docs.length; i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}

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
  localEncoding: LocalEncoding;
  now?: () => string;
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

/** Out-of-sample analysis of collected rows (same method as the offline experiment). */
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

/** In-memory ledger for simulation/tests only (never a substitute for S4's ledger). */
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
