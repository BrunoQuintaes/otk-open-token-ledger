/**
 * D1–D8 / S4 — INT-09 / D8-G01 (integrated): cost of the auxiliary conference (local recount) in
 * the durable proxy, same process, same PostgreSQL, same synthetic provider, with and without the
 * counter. Measures end-to-end latency per request (client side, until the body ends), process CPU
 * time and heap delta over the run. Order alternates (ABAB…) to spread drift. Synthetic text only.
 *
 *   . scripts/ops/s4_env.sh && npx tsx tools/bench/s4_int09_overhead.ts --n 40 --out <json>
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'bench/OPERATOR:tokbench';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8s4-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '../../test/services/d1d8_c_env.js';
import { ControllableProvider } from '../../test/services/d1d8_c_provider.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const N = Number(arg('--n', '40'));
const OUT = arg('--out', '');
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!; return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1]!.toFixed(2), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) }; };

async function main(): Promise<void> {
  const db = await createTestDb('s4bench');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  const provider = new ControllableProvider(); await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  const gw = await import('../../src/proxy/ProxyGateway.js');
  const base = d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['test/fixtures/d1d8/b/price_table_illustrative_v1.json']) });
  const variants = {
    with_conference: base,
    without_conference: { ...base, createLocalCounter: null, buildConferenceReport: null, streamTextHooks: null, extractOutputText: null, label: `${base.label}-no-counter` },
  };
  const gws: Record<string, { rt: OperationsRuntime; url: string; server: import('node:http').Server }> = {};
  for (const [name, measurement] of Object.entries(variants)) {
    const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: `bench-${name}`, recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement, policy: { extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
    const server = gw.startProxyGateway({ port: 0, operations: rt });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    gws[name] = { rt, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const prompt = 'Explain, in plain words, why a reservation of money is not the same as money spent. '.repeat(20);
  const call = async (url: string, i: number, stream: boolean) => {
    const t0 = performance.now();
    const r = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokbench', 'x-otk-operation-id': `b-${i}-${stream}-${Math.random().toString(36).slice(2)}`, 'x-test-script': stream ? 'stream' : 'ok', 'x-test-tokens': '400,20', 'x-test-model': 'gpt-4o-mini-2024-07-18' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 64, stream }) });
    await r.text();
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return performance.now() - t0;
  };
  const out: Record<string, unknown> = {};
  for (const stream of [false, true]) {
    const lat: Record<string, number[]> = { with_conference: [], without_conference: [] };
    for (let w = 0; w < 5; w++) for (const name of Object.keys(gws)) await call(gws[name]!.url, -1 - w, stream); // warm-up
    const cpu0 = process.cpuUsage(); const heap0 = process.memoryUsage().heapUsed;
    const cpuBy: Record<string, number> = { with_conference: 0, without_conference: 0 };
    for (let i = 0; i < N; i++) {
      for (const name of i % 2 ? ['without_conference', 'with_conference'] : ['with_conference', 'without_conference']) {
        const c0 = process.cpuUsage();
        lat[name]!.push(await call(gws[name]!.url, i, stream));
        const d = process.cpuUsage(c0); cpuBy[name]! += d.user + d.system;
      }
    }
    const cpu = process.cpuUsage(cpu0);
    out[stream ? 'stream' : 'non_stream'] = {
      latency_ms: { with_conference: stats(lat['with_conference']!), without_conference: stats(lat['without_conference']!) },
      process_cpu_ms_per_request: { with_conference: +(cpuBy['with_conference']! / 1000 / N).toFixed(2), without_conference: +(cpuBy['without_conference']! / 1000 / N).toFixed(2) },
      total_cpu_ms: +((cpu.user + cpu.system) / 1000).toFixed(1), heap_delta_bytes: process.memoryUsage().heapUsed - heap0,
    };
  }
  const conf = await db.pool.query<{ state: string; n: string }>('SELECT state, count(*)::text AS n FROM otk_conferences GROUP BY state');
  const result = {
    schema: 'otk.s4_int09_overhead.v1', ranAt: new Date().toISOString(), n: N, prompt_bytes: Buffer.byteLength(prompt),
    note: 'single process hosts client, gateway and provider: CPU per request includes the synthetic provider and the client for both variants; the difference is the counter + report. Receipts/conferences are written asynchronously by the outbox worker (not in the latency).',
    results: out, conferences_written_by_state: conf.rows,
  };
  const json = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, json + '\n');
  process.stdout.write(json + '\n');
  for (const g of Object.values(gws)) { g.server.closeAllConnections(); await new Promise<void>((r) => g.server.close(() => r())); await g.rt.stop(); }
  await provider.stop(); await db.drop();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
