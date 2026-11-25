/**
 * D8-G01 (local part) — CPU, latency and memory of the stream accumulator with and without the
 * auxiliary counter, same process, same synthetic streams (front B). The integrated measurement
 * through ProxyGateway is S4's (INT-09). Counting after the response (e.g. in setImmediate) still
 * spends this CPU in the process: these numbers are the cost, not a promise of zero latency.
 *
 *   bash control/bin/heavy_lock.sh B bench -- npx tsx scripts/calibration/benchCounter.ts --out <file>
 *
 * Plain form: `npx tsx scripts/calibration/benchCounter.ts [--reps <n>] [--out <file>]` (the lock wrapper above only
 * keeps heavy jobs from running at the same time on the measuring machine). Builds synthetic OpenAI-style SSE streams
 * of 1 KiB, 16 KiB and 128 KiB of prose, warms up 5 times, then runs `--reps` (default 40) alternating rounds with and
 * without the local counter attached to the stream accumulator. Reports p50/p95/max/mean wall time (ms) and CPU time
 * (microseconds) per size, heap growth and peak RSS (bytes) as JSON to `--out` or stdout. No network, no environment
 * variables; run with `node --expose-gc` for the heap numbers to start from a collected heap.
 *
 * @module scripts/calibration/benchCounter
 */
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { createStreamUsageAccumulator } from '../../src/providers/usage/streamUsageAccumulator.js';
import { createLocalCounter } from '../../src/tokenization/localCounter.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { generateCorpus, mulberry32 } from './corpus.js';

const NOW = '2026-09-30T12:00:00.000Z';

function buildStream(text: string, deltaChars: number): Uint8Array[] {
  const events: string[] = [];
  for (let i = 0; i < text.length; i += deltaChars) {
    events.push(`data: ${JSON.stringify({ id: 'b', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: text.slice(i, i + deltaChars) } }], usage: null })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({ id: 'b', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\ndata: [DONE]\n\n`);
  const bytes = new TextEncoder().encode(events.join(''));
  const r = mulberry32(7);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length;) { const n = 64 + Math.floor(r() * 1400); chunks.push(bytes.slice(i, i + n)); i += n; }
  return chunks;
}

function runOnce(chunks: Uint8Array[], withCounter: boolean): { wallMs: number; cpuMicros: number } {
  const support = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini');
  const counter = withCounter ? createLocalCounter(support, { maxTextBytes: 4 << 20 }) : null;
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 1 << 16 },
    counter ? { onTextDelta: (t) => counter.observeOutputText(t), onNonTextOutput: (r) => counter.markOutputUncovered(r) } : {});
  if (counter) counter.observeInput({ api: 'openai.chat_completions', body: { messages: [{ role: 'user', content: 'Resuma o relatório de consumo do trimestre em cinco tópicos.' }] } });
  for (const c of chunks) acc.push(c);
  acc.finish();
  if (counter) counter.finish();
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const d = process.cpuUsage(cpu0);
  return { wallMs, cpuMicros: d.user + d.system };
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, mean: s.reduce((a, b) => a + b, 0) / s.length };
}

function main() {
  const prose = generateCorpus().filter((d) => d.family === 'pt_prose' || d.family === 'en_prose').map((d) => d.text).join('\n\n');
  const sizes = [1024, 16 * 1024, 128 * 1024];
  const reps = Number(process.argv[process.argv.indexOf('--reps') + 1]) || 40;
  const results: Record<string, unknown> = {};
  for (const size of sizes) {
    let text = prose;
    while (text.length < size) text += '\n\n' + prose;
    const chunks = buildStream(text.slice(0, size), 24);
    for (let w = 0; w < 5; w++) { runOnce(chunks, false); runOnce(chunks, true); }
    const rows: Record<'without' | 'with', { wallMs: number[]; cpuMicros: number[] }> = { without: { wallMs: [], cpuMicros: [] }, with: { wallMs: [], cpuMicros: [] } };
    global.gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < reps; i++) {
      // Alternate order to avoid systematic warm-up bias.
      for (const mode of (i % 2 ? ['with', 'without'] : ['without', 'with']) as Array<'with' | 'without'>) {
        const r = runOnce(chunks, mode === 'with');
        rows[mode].wallMs.push(r.wallMs);
        rows[mode].cpuMicros.push(r.cpuMicros);
      }
    }
    results[`${size}_chars`] = {
      streamBytes: chunks.reduce((s, c) => s + c.byteLength, 0),
      without: { wallMs: stats(rows.without.wallMs), cpuMicros: stats(rows.without.cpuMicros) },
      with: { wallMs: stats(rows.with.wallMs), cpuMicros: stats(rows.with.cpuMicros) },
      heapUsedDeltaBytesAfterRuns: process.memoryUsage().heapUsed - heap0,
    };
  }
  const report = {
    bench: 'otk.bench.counter.b4@1',
    environment: { node: process.version, platform: process.platform, cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, totalMemGb: +(totalmem() / 2 ** 30).toFixed(1) },
    note: 'Same process, synthetic SSE (OpenAI chat shape, 24-char deltas, 64–1464 byte chunks). Single machine, single run; not a universal latency claim. Integrated proxy measurement: S4.',
    reps,
    peakRssBytes: process.memoryUsage().rss,
    results,
    generatedAt: new Date().toISOString(),
  };
  const out = process.argv.indexOf('--out');
  const json = JSON.stringify(report, null, 2) + '\n';
  if (out >= 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, json, 'utf8');
  else process.stdout.write(json);
}

main();
