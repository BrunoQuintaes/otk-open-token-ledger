/**
 * Reads the call records already stored in this repository for the two collection days (7 Oct 2026 and
 * 23 Nov 2026) and turns them into small, content-free summaries that the live page replays call by call.
 *
 * Where it fits: `reproduzir_ao_vivo.mjs` calls {@link summarizeBothDays} once at start-up and the local
 * server (`servidor.mjs`) hands the result to the page as JSON. Nothing here touches the network.
 *
 * Sources (all read-only, relative to the repository root):
 * - 7 Oct: every `*_calls.jsonl` under the bank package campaign folder, except folders whose path
 *   contains `synthetic` (those were dry runs that never reached a provider).
 * - 23 Nov: `reproducao/cmp8/dados/{openai,anthropic,google,google_v1_3}/journal_sanitizado.jsonl`, the
 *   hash-chained journal written by the separate collection program (`scripts/h2eval/`), plus
 *   `TENTATIVAS_CMP8.jsonl` in the same folders for the provider's raw usage (the declared input, as in part C).
 *
 * What it deliberately does NOT copy into the summaries: prompt or response text (the records only hold
 * hashes of them anyway), provider request/response identifiers, error messages returned by the
 * provider, and the free-text "acknowledged by" fields of the journal. Every number shown on the page is
 * computed here from the files at run time; there are no hard-coded totals.
 *
 * Environment variables: none.
 *
 * @module reproducao/ao_vivo/dados_dias
 */
import fs from 'node:fs';
import path from 'node:path';

/** Campaign folder of the 7 Oct collection inside the bank package, relative to the repository root. */
export const OCT07_CAMPAIGN_DIR = path.join(
  'reproducao', 'otk-banca-pack-20261111', 'H1', 'inputs', 'h1_subset', 'docs', '_ops', 'OVERNIGHT2_20261006', 'campaign',
);

/** Folder with the 23 Nov journals, relative to the repository root. */
export const NOV23_DATA_DIR = path.join('reproducao', 'cmp8', 'dados');

/** Journal sub-folders of the 23 Nov collection, in the order the reproduction reads them. */
export const NOV23_PROVIDER_DIRS = ['openai', 'anthropic', 'google', 'google_v1_3'];

/** Display names of the provider folders (7 Oct folder names and 23 Nov journal `provider` values). */
const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', gemini35: 'Google', google: 'Google' };

/** One pico-USD is 10^-12 USD; the 23 Nov journal stores costs as integer strings in pico-USD. */
const PICO_PER_USD = 1e12;

/**
 * Lists files under a folder, recursively, sorted by relative path so the result is stable across machines.
 *
 * @param dir - Absolute folder to walk.
 * @returns Absolute paths of every regular file below `dir`.
 */
function listFilesRecursive(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFilesRecursive(full));
    else if (entry.isFile()) found.push(full);
  }
  return found.sort();
}

/**
 * Parses a JSON Lines file, skipping blank lines.
 *
 * @param file - Absolute path of the `.jsonl` file.
 * @param repoRoot - Absolute repository root, used only to name the file in error messages.
 * @returns One parsed object per non-empty line.
 * @throws {Error} When a line is not valid JSON; the message names the file (relative) and the line number.
 */
function readJsonLines(file, repoRoot) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const records = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    try { records.push(JSON.parse(line)); } catch (err) {
      throw new Error(`PAROU: linha ${index + 1} de ${toRepoRelative(file, repoRoot)} não é JSON (${err.message})`);
    }
  });
  return records;
}

/**
 * Turns an absolute path into a forward-slash path relative to the repository root, so no machine path
 * ever reaches the page or the terminal.
 *
 * @param file - Absolute path inside the repository.
 * @param repoRoot - Absolute repository root.
 * @returns The relative path with `/` separators.
 */
export function toRepoRelative(file, repoRoot) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * Converts a provider/local count stored as a decimal string (7 Oct records) into a number.
 *
 * @param value - The stored value, e.g. `"16"`.
 * @returns The integer, or `null` when the value is missing or not a whole number (never zero by default).
 */
function toCountOrNull(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Extracts, from one 7 Oct call record, only the fields the page shows.
 *
 * @param record - One line of a `*_calls.jsonl` file.
 * @param providerDir - Provider folder name (`openai`, `anthropic` or `gemini35`).
 * @param stage - Campaign sub-folder (e.g. `campaign`, `cacheprobe`, `besu`), shown as the run stage.
 * @returns A content-free call summary. `signatureVerified` is `true`/`false` from the
 *   `checks.receipt_signature_verifies` check, or `null` when the record has no such check
 *   (the provider refused the call, so no receipt was produced).
 */
function summarizeOct07Call(record, providerDir, stage) {
  const comparisons = record.conference?.comparisons ?? [];
  const byCategory = Object.fromEntries(comparisons.map((c) => [c.category, c]));
  const otkInput = toCountOrNull(byCategory.input?.local);
  const declaredInput = toCountOrNull(byCategory.input?.provider);
  const signatureCheck = record.checks?.receipt_signature_verifies;
  let signatureVerified = null;
  if (signatureCheck) signatureVerified = signatureCheck.ok === true && signatureCheck.observed === true;
  const cost = record.ledgerReservation?.costUsd;
  return {
    provider: PROVIDER_LABELS[providerDir] ?? providerDir,
    model: typeof record.returnedModel === 'string' ? record.returnedModel : null,
    stage,
    httpStatus: typeof record.httpStatus === 'number' ? record.httpStatus : null,
    otkInput,
    otkOutput: toCountOrNull(byCategory.output?.local),
    declaredInput,
    declaredOutput: toCountOrNull(byCategory.output?.provider),
    inputDifference: otkInput !== null && declaredInput !== null ? declaredInput - otkInput : null,
    verdict: record.conference === undefined || record.conference === null ? 'refused' : (record.conference.verdict ?? 'not_produced'),
    costUsd: typeof cost === 'number' ? cost : null,
    signatureVerified,
  };
}

/**
 * Builds the per-group and total counters the page must show, from call summaries.
 *
 * @param calls - Call summaries in replay order.
 * @param groupKeyOf - Returns the group label of a call (e.g. "OpenAI · gpt-4o-mini-2024-07-18").
 * @param countersOf - Returns the counter increments of one call, as `{ name: 0|1 }`.
 * @returns `{ groups: [{ group, ...counters }], total: { ...counters } }`, groups sorted by label.
 */
function tallyCounters(calls, groupKeyOf, countersOf) {
  const groups = new Map();
  const total = {};
  for (const call of calls) {
    const key = groupKeyOf(call);
    if (!groups.has(key)) groups.set(key, {});
    const bucket = groups.get(key);
    for (const [name, increment] of Object.entries(countersOf(call))) {
      bucket[name] = (bucket[name] ?? 0) + increment;
      total[name] = (total[name] ?? 0) + increment;
    }
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { groups: sorted.map(([group, counters]) => ({ group, ...counters })), total };
}

/**
 * Counter increments of one 7 Oct call: calls, signature verified yes/no, and calls without the check.
 *
 * @param call - A summary from `summarizeOct07Call`.
 * @returns Increments for `calls`, `signatureYes`, `signatureNo`, `withoutCheck`.
 */
export function countOct07Call(call) {
  return {
    calls: 1,
    signatureYes: call.signatureVerified === true ? 1 : 0,
    signatureNo: call.signatureVerified === false ? 1 : 0,
    withoutCheck: call.signatureVerified === null ? 1 : 0,
  };
}

/**
 * Group label of a 7 Oct call; refused calls have no returned model and are grouped apart, without guessing it.
 *
 * @param call - A summary from `summarizeOct07Call`.
 * @returns E.g. `"OpenAI · gpt-4o-mini-2024-07-18"` or `"OpenAI · sem modelo devolvido"`.
 */
export function groupOct07Call(call) {
  return `${call.provider} · ${call.model ?? 'sem modelo devolvido'}`;
}

/**
 * Summarizes the real calls of the 7 Oct collection (H1).
 *
 * Order: files are sorted by the timestamp embedded in their name (`...-2026-10-07tHH-MM-SS-mmm_calls.jsonl`),
 * and calls keep their line order inside each file, which is the order they were made.
 *
 * @param repoRoot - Absolute repository root.
 * @returns `{ sources, calls, counters, refusedHttpStatuses }`, where `sources` are the relative paths read.
 * @throws {Error} When the campaign folder is missing or a line is not JSON.
 */
export function summarizeOct07(repoRoot) {
  const campaignDir = path.join(repoRoot, OCT07_CAMPAIGN_DIR);
  if (!fs.existsSync(campaignDir)) throw new Error(`PAROU: não achei a pasta da coleta de 7/10 (${toRepoRelative(campaignDir, repoRoot)})`);
  const stampOf = (file) => (/(\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3})_calls\.jsonl$/.exec(file) ?? [])[1] ?? '';
  const files = listFilesRecursive(campaignDir)
    .filter((f) => f.endsWith('_calls.jsonl'))
    .filter((f) => !/synthetic/i.test(toRepoRelative(f, repoRoot)))
    .sort((a, b) => stampOf(a).localeCompare(stampOf(b)) || a.localeCompare(b));
  const calls = [];
  for (const file of files) {
    const [providerDir, stage] = path.relative(campaignDir, file).split(path.sep);
    for (const record of readJsonLines(file, repoRoot)) calls.push(summarizeOct07Call(record, providerDir, stage));
  }
  const refusedHttpStatuses = {};
  for (const call of calls) {
    if (call.signatureVerified === null) refusedHttpStatuses[call.httpStatus] = (refusedHttpStatuses[call.httpStatus] ?? 0) + 1;
  }
  return {
    sources: files.map((f) => toRepoRelative(f, repoRoot)),
    calls,
    counters: tallyCounters(calls, groupOct07Call, countOct07Call),
    refusedHttpStatuses,
  };
}

/**
 * Converts a pico-USD integer string into a USD number for display.
 *
 * @param pico - E.g. `"81600000"`.
 * @returns USD as a number, or `null` when the value is not an integer string.
 */
function picoToUsdOrNull(pico) {
  if (typeof pico !== 'string' || !/^\d+$/.test(pico)) return null;
  return Number(BigInt(pico)) / PICO_PER_USD;
}

/**
 * Declared input tokens from the provider's raw usage, by the rule of part C of the reproduction
 * (`reproducao/cmp8/scripts/estimado_cmp8.mts`, `doBruto`): OpenAI `prompt_tokens`; Google `promptTokenCount`;
 * Anthropic `input_tokens` plus cache read and cache creation tokens.
 *
 * @param provider - `openai`, `anthropic` or `google`.
 * @param rawUsage - `usoBrutoProvedor` of a `TENTATIVAS_CMP8.jsonl` line.
 * @returns The token count, or `null` when the provider did not report it (never zero by default).
 */
export function declaredFromRawUsage(provider, rawUsage) {
  if (!rawUsage) return null;
  const read = (key) => (Number.isSafeInteger(rawUsage[key]) && rawUsage[key] >= 0 ? rawUsage[key] : null);
  if (provider === 'openai') return read('prompt_tokens');
  if (provider === 'google') return read('promptTokenCount');
  const input = read('input_tokens');
  if (input === null) return null;
  return input + (read('cache_read_input_tokens') ?? 0) + (read('cache_creation_input_tokens') ?? 0);
}

/**
 * Applies part C's inclusion rule to one attempt: the declared value counts only when the call answered with
 * usage (`OK` or `REFUSED_WITH_USAGE`), the returned model is the requested one, and the value is above zero.
 *
 * @param attempt - A `TENTATIVAS_CMP8.jsonl` line, or `undefined`.
 * @param provider - Provider of the operation.
 * @returns The declared input tokens, or `null`.
 */
function declaredFromAttempt(attempt, provider) {
  if (!attempt) return null;
  const value = declaredFromRawUsage(provider, attempt.usoBrutoProvedor ?? null);
  const isIncluded = (attempt.outcome === 'OK' || attempt.outcome === 'REFUSED_WITH_USAGE') && attempt.modeloDevolvido === attempt.model && typeof value === 'number' && value > 0;
  return isIncluded ? value : null;
}

/**
 * Folds the journal lines of one operation into the stages shown on the page.
 *
 * Only the first occurrence of each kind is used, except the closing state, which prefers `SETTLED`
 * over an isolated uncertain operation. `REPLAY_SKIPPED` lines (a restarted batch skipping work already
 * done) and acknowledgement lines carry no stage and are ignored.
 *
 * The declared input is NOT taken from the journal's `USAGE_PARSED.U` (for Google it is `UNKNOWN`): it is
 * the provider's raw usage from `TENTATIVAS_CMP8.jsonl`, by the same rule as part C of the reproduction
 * (see {@link declaredFromRawUsage}).
 *
 * @param lines - All journal lines of one `operationId`, in journal order.
 * @param attempt - The `TENTATIVAS_CMP8.jsonl` line with the same `opId`, or `undefined`.
 * @returns The operation summary, or `null` when the operation was planned but never sent.
 */
function summarizeNov23Operation(lines, attempt) {
  const first = (kind) => lines.find((l) => l.kind === kind);
  const planned = first('PLANNED');
  const snapshot = first('PRECALL_SNAPSHOT_COMMITTED');
  const sent = first('SENT');
  if (!sent) return null;
  const response = first('RESPONSE_RECEIVED') ?? first('ERROR_WITH_USAGE') ?? first('ERROR_NO_USAGE');
  const cost = first('COST_COMPUTED');
  const settled = first('SETTLED');
  const isolated = first('UNCERTAIN_ISOLATED');
  const otkCount = typeof snapshot?.body?.L0 === 'number' ? snapshot.body.L0 : null;
  const declaredInput = declaredFromAttempt(attempt, planned?.body?.provider);
  let closing = 'aberto';
  if (settled) closing = 'fechado';
  else if (isolated) closing = 'isolado (custo incerto)';
  return {
    provider: PROVIDER_LABELS[planned?.body?.provider] ?? planned?.body?.provider ?? null,
    model: planned?.body?.modelRequested ?? null,
    sentUtc: sent.tsUtc,
    recordedBeforeSend: Boolean(snapshot && snapshot.seq < sent.seq && snapshot.tsUtc <= sent.tsUtc),
    estimateStatus: snapshot?.body?.estimateStatus ?? null,
    otkCount,
    responseKind: response?.kind ?? null,
    httpStatus: typeof response?.body?.httpStatus === 'number' ? response.body.httpStatus : null,
    declaredInput,
    inputDifference: otkCount !== null && declaredInput !== null ? declaredInput - otkCount : null,
    costUsd: picoToUsdOrNull(cost?.body?.usd),
    closing,
  };
}

/**
 * Counter increments of one 23 Nov operation.
 *
 * @param op - A summary from `summarizeNov23Operation`.
 * @returns Increments for `sent`, `recordedBefore`, `withOtkCount` (status `ESTIMATED`),
 *   `withoutOtkCount` (status `UNSUPPORTED_FOR_ESTIMATION` or any other non-estimated status) and
 *   `withDeclared` (declared input available by part C's rule).
 */
export function countNov23Operation(op) {
  const recordedBefore = op.recordedBeforeSend ? 1 : 0;
  return {
    sent: 1,
    recordedBefore,
    withOtkCount: recordedBefore && op.estimateStatus === 'ESTIMATED' ? 1 : 0,
    withoutOtkCount: recordedBefore && op.estimateStatus !== 'ESTIMATED' ? 1 : 0,
    withDeclared: op.declaredInput !== null ? 1 : 0,
  };
}

/**
 * Checks that each journal line points to the previous one (`prevHash` equals the previous `hash`).
 *
 * This only checks the links; recomputing each line's hash is part C of the reproduction itself.
 *
 * @param lines - Parsed journal lines in file order.
 * @returns `true` when every link holds and `seq` counts 1, 2, 3...
 */
function isChainLinked(lines) {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].prevHash !== lines[i - 1].hash || lines[i].seq !== i + 1) return false;
  }
  return lines.length === 0 || lines[0].seq === 1;
}

/**
 * Summarizes the 23 Nov collection (8 models) from the hash-chained journals.
 *
 * Order: operations are replayed by the time they were sent (`SENT.tsUtc`), across all journals.
 *
 * @param repoRoot - Absolute repository root.
 * @returns `{ sources, operations, counters, chainLinked }`; `chainLinked` maps journal folder to the link check.
 * @throws {Error} When a journal file is missing or a line is not JSON.
 */
export function summarizeNov23(repoRoot) {
  const sources = [];
  const operations = [];
  const chainLinked = {};
  for (const dir of NOV23_PROVIDER_DIRS) {
    const file = path.join(repoRoot, NOV23_DATA_DIR, dir, 'journal_sanitizado.jsonl');
    if (!fs.existsSync(file)) throw new Error(`PAROU: não achei o registro de 23/11 ${toRepoRelative(file, repoRoot)}`);
    sources.push(toRepoRelative(file, repoRoot));
    const lines = readJsonLines(file, repoRoot);
    chainLinked[dir] = isChainLinked(lines);
    const attemptsFile = path.join(repoRoot, NOV23_DATA_DIR, dir, 'TENTATIVAS_CMP8.jsonl');
    if (!fs.existsSync(attemptsFile)) throw new Error(`PAROU: não achei ${toRepoRelative(attemptsFile, repoRoot)}`);
    sources.push(toRepoRelative(attemptsFile, repoRoot));
    const attempts = new Map(readJsonLines(attemptsFile, repoRoot).map((t) => [t.opId, t]));
    const byOperation = new Map();
    for (const line of lines) {
      if (!byOperation.has(line.operationId)) byOperation.set(line.operationId, []);
      byOperation.get(line.operationId).push(line);
    }
    for (const opLines of byOperation.values()) {
      const op = summarizeNov23Operation(opLines, attempts.get(opLines[0].operationId));
      if (op) operations.push(op);
    }
  }
  operations.sort((a, b) => a.sentUtc.localeCompare(b.sentUtc));
  return {
    sources,
    operations,
    counters: tallyCounters(operations, (op) => op.model ?? 'modelo desconhecido', countNov23Operation),
    chainLinked,
  };
}

/**
 * Summarizes both collection days for the live page.
 *
 * @param repoRoot - Absolute repository root.
 * @returns `{ oct07, nov23 }` as returned by {@link summarizeOct07} and {@link summarizeNov23}.
 * @throws {Error} When any source file is missing or malformed (see the two functions).
 * @example
 * const days = summarizeBothDays(path.resolve('.'));
 * console.log(days.oct07.counters.total.calls); // 662 in the published data
 */
export function summarizeBothDays(repoRoot) {
  return { oct07: summarizeOct07(repoRoot), nov23: summarizeNov23(repoRoot) };
}
