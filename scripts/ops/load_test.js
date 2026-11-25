#!/usr/bin/env node
/**
 * GA Load Test — OTK zk-Metering
 *
 * Sends N concurrent POST /receipts requests and measures latency percentiles.
 * Reports pass/fail against the GA target: p99 < 200 ms.
 *
 * Usage:
 *   node scripts/ops/load_test.js [baseUrl] [concurrency] [iterations]
 *
 * Defaults:
 *   baseUrl     = http://localhost:8080
 *   concurrency = 10
 *   iterations  = 100
 *
 * Requirements: Node.js 18+ (native fetch).
 *
 * Exit codes:
 *   0 — p99 target met (PASS)
 *   1 — p99 target exceeded (FAIL)
 *
 * Environment: OTK_LOAD_TEST_TOKEN (optional API token, sent only when set; its value is never printed).
 * Side effects: it writes real receipts to the target server, so point it at a test stack only. Payloads
 * are synthetic (random token counts, fake user ids).
 *
 * @module scripts/ops/load_test
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL    = process.argv[2] ?? 'http://localhost:8080';
const CONCURRENCY = parseInt(process.argv[3] ?? '10',  10);
const ITERATIONS  = parseInt(process.argv[4] ?? '100', 10);

const TARGET_P99_MS = 200;
const ENDPOINT      = '/receipts';

// Optional Bearer token — set OTK_LOAD_TEST_TOKEN env var when stack has OTK_TENANTS configured
const BEARER_TOKEN  = process.env['OTK_LOAD_TEST_TOKEN'] ?? '';

// Minimal synthetic receipt payload — matches ReceiptSubmissionSchema
const buildPayload = (i) => JSON.stringify({
  requestId:    `ga-load-test-req-${Date.now()}-${i}`,
  provider:     'openai',
  model:        'gpt-4o-mini',
  inputTokens:  Math.floor(Math.random() * 500) + 1,
  outputTokens: Math.floor(Math.random() * 200) + 1,
  userId:       `${i % 20}`,
  nonce:        `${Math.floor(Math.random() * 1_000_000)}`,
});

// ─── Core runner ─────────────────────────────────────────────────────────────

/**
 * Send one request and return latency in milliseconds.
 * Returns null on network error (counted as error, not latency sample).
 * (As written it never returns null: a network error gives `status: 0` and an `error` message.)
 *
 * @param index - Sequence number of the request, used in the request id and the synthetic user id.
 * @returns `{ latencyMs, status }`, plus `error` when the request failed before a response.
 */
async function sendRequest(index) {
  const url    = `${BASE_URL}${ENDPOINT}`;
  const body   = buildPayload(index);
  const start  = performance.now();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`;
    const res = await fetch(url, {
      method:  'POST',
      headers,
      body,
    });
    const elapsed = performance.now() - start;
    return { latencyMs: elapsed, status: res.status };
  } catch (err) {
    const elapsed = performance.now() - start;
    return { latencyMs: elapsed, status: 0, error: err.message };
  }
}

/**
 * Run a batch of CONCURRENCY requests concurrently.
 *
 * @param batchIndex - Zero-based batch number; request indexes are batchIndex * CONCURRENCY + i.
 * @returns The results of {@link sendRequest} for the batch, in request order.
 */
async function runBatch(batchIndex) {
  const promises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(sendRequest(batchIndex * CONCURRENCY + i));
  }
  return Promise.all(promises);
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function formatMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const batches   = Math.ceil(ITERATIONS / CONCURRENCY);
  const totalReqs = batches * CONCURRENCY;

  console.log('');
  console.log('OTK GA Load Test');
  console.log('────────────────');
  console.log(`  Base URL    : ${BASE_URL}`);
  console.log(`  Endpoint    : ${ENDPOINT}`);
  console.log(`  Concurrency : ${CONCURRENCY} parallel requests per batch`);
  console.log(`  Iterations  : ${ITERATIONS} (${batches} batches → ${totalReqs} total requests)`);
  console.log(`  P99 target  : < ${TARGET_P99_MS} ms`);
  console.log('');

  const latencies = [];
  const errors    = [];
  const statuses  = {};
  const start     = performance.now();

  process.stdout.write('  Progress: ');

  for (let b = 0; b < batches; b++) {
    const results = await runBatch(b);
    for (const r of results) {
      latencies.push(r.latencyMs);
      const s = String(r.status);
      statuses[s] = (statuses[s] ?? 0) + 1;
      if (r.error || r.status === 0) {
        errors.push({ index: b * CONCURRENCY + latencies.length, error: r.error ?? `HTTP ${r.status}` });
      }
    }
    process.stdout.write(b % 10 === 9 ? `${b + 1}` : '.');
  }

  const wallMs = performance.now() - start;
  process.stdout.write('\n\n');

  // Sort for percentile calculations
  latencies.sort((a, b) => a - b);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const min = latencies[0] ?? 0;
  const max = latencies[latencies.length - 1] ?? 0;
  const avg = latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1);

  const errorCount  = errors.length;
  const errorRate   = ((errorCount / totalReqs) * 100).toFixed(2);
  const throughput  = (totalReqs / (wallMs / 1000)).toFixed(1);
  const passed      = p99 < TARGET_P99_MS;

  console.log('Results');
  console.log('───────');
  console.log(`  Total requests : ${totalReqs}`);
  console.log(`  Wall time      : ${formatMs(wallMs)}`);
  console.log(`  Throughput     : ${throughput} req/s`);
  console.log(`  Errors         : ${errorCount} (${errorRate}%)`);
  console.log('');
  console.log('Latency Percentiles');
  console.log('───────────────────');
  console.log(`  min : ${formatMs(min)}`);
  console.log(`  avg : ${formatMs(avg)}`);
  console.log(`  p50 : ${formatMs(p50)}`);
  console.log(`  p95 : ${formatMs(p95)}`);
  console.log(`  p99 : ${formatMs(p99)}  ${passed ? '✓ PASS' : '✗ FAIL'} (target < ${TARGET_P99_MS} ms)`);
  console.log(`  max : ${formatMs(max)}`);
  console.log('');
  console.log('HTTP Status Breakdown');
  console.log('─────────────────────');
  for (const [code, count] of Object.entries(statuses).sort()) {
    console.log(`  HTTP ${code} : ${count}`);
  }

  if (errorCount > 0) {
    console.log('');
    console.log(`Errors (first 5 of ${errorCount})`);
    console.log('────────────────────────────────');
    for (const e of errors.slice(0, 5)) {
      console.log(`  req #${e.index}: ${e.error}`);
    }
  }

  console.log('');
  console.log(`GA Load Test: ${passed ? 'PASS' : 'FAIL'}`);
  console.log(`  p99 = ${formatMs(p99)} vs target ${TARGET_P99_MS} ms`);
  console.log('');

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Load test fatal error:', err.message);
  process.exit(1);
});
