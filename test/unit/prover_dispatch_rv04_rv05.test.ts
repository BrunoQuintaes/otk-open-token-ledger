/**
 * R14 / RV04 + RV05 — proof dispatch: one attempt per receipt at a time, and recovery
 * that does not depend on new client traffic.
 *
 * RV04: while B's first POST /prove was in flight, the drain triggered by A's success
 *       re-sent B (nonces [1, 2, 2]).
 * RV05: after the prover came back, pending receipts stayed pending until a new receipt
 *       arrived or retryPendingProofs() was called by hand; nothing scheduled it.
 *
 * The daemon is a fetch stub; responses are released by the test in any order.
 *
 * Module under test: `src/api/receiptStore.ts` (proof dispatch, circuit breaker and the recovery loop).
 *
 * Strategy / partitions: concurrent sends answered in any order (each nonce sent once); a manual retry while
 * a send is in flight; refused, connection refused and timeout outcomes (only the timeout is uncertain);
 * recovery after the prover returns with no new receipt; cooldown respected; stop, idempotent start, reset
 * and the disabled prover.
 *
 * Needs: no network; the global `fetch` is replaced by a stub and restored after each test. Sets
 * `OTK_RECEIPT_LOG` and `OTK_DB_URL` to empty and `PROVER_CB_THRESHOLD` / `PROVER_CB_COOLDOWN_MS` to small values
 * before importing the store; uses short real timers (tens of ms).
 *
 * Run just this file: `npx tsx --test test/unit/prover_dispatch_rv04_rv05.test.ts`
 *
 * @module test/unit/prover_dispatch_rv04_rv05.test
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RawReceipt } from '../../src/types/receipt.js';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_CB_THRESHOLD'] = '2';
process.env['PROVER_CB_COOLDOWN_MS'] = '40';

let store: typeof import('../../src/api/receiptStore.js');
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

before(async () => { store = await import('../../src/api/receiptStore.js'); });

let seq = 0;
const receipt = (): RawReceipt => {
  seq++;
  return { requestId: `rv04-${seq}`, provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1,
    costUnits: 2, latencyMs: 1, timestamp: 1700000000, userId: 7n, nonce: BigInt(seq) };
};

/** Daemon stub whose answers are released by the test. */
function heldDaemon() {
  const sent: string[] = [];
  const pending: Array<{ nonce: string; accept: () => void; reject: (e: unknown) => void }> = [];
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
    sent.push(nonce);
    pending.push({ nonce, accept: () => resolve(new Response(JSON.stringify({ jobId: `job-${nonce}` }), { status: 202 })), reject });
  })) as typeof fetch;
  const release = (nonce: string) => pending.find(p => p.nonce === nonce)!.accept();
  return { sent, pending, release };
}

/** Daemon stub answering immediately according to `mode`. */
function liveDaemon() {
  const state = { mode: 'down' as 'down' | 'up', sent: [] as string[] };
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
    state.sent.push(nonce);
    if (state.mode === 'down') return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ jobId: `job-${nonce}` }), { status: 202 });
  }) as typeof fetch;
  return state;
}

const count = (xs: string[], x: string) => xs.filter(v => v === x).length;

beforeEach(() => {
  store.stopProofRecovery?.(); // optional: lets the pre-fix run show the defect itself
  store.resetProverStateForTest();
  process.env['PROVER_URL'] = 'http://prover.test';
});
afterEach(() => {
  store.stopProofRecovery?.(); // optional: lets the pre-fix run show the defect itself
  globalThis.fetch = realFetch;
  process.env['PROVER_URL'] = 'disabled';
});

describe('RV04 — one attempt per receipt while a send is in flight', () => {
  it('B in flight when A succeeds: B is not re-sent by the drain (was [1,2,2])', async () => {
    const d = heldDaemon();
    const a = receipt(), b = receipt();
    store.storeReceipt(a, 't'); store.storeReceipt(b, 't');
    await sleep(5);
    d.release(String(a.nonce));
    await sleep(30);
    assert.deepEqual(d.sent, [String(a.nonce), String(b.nonce)], 'no second attempt for B');
    d.release(String(b.nonce));
    await sleep(30);
    assert.equal(store.circuitBreakerStatus().pendingProofs, 0);
    assert.equal(store.circuitBreakerStatus().inFlight, 0);
  });

  it('five concurrent receipts answered in reverse order: each nonce sent exactly once', async () => {
    const d = heldDaemon();
    const rs = Array.from({ length: 5 }, receipt);
    for (const r of rs) store.storeReceipt(r, 't');
    await sleep(5);
    for (const r of [...rs].reverse()) { d.release(String(r.nonce)); await sleep(10); }
    await sleep(30);
    for (const r of rs) assert.equal(count(d.sent, String(r.nonce)), 1, `nonce ${r.nonce}`);
    assert.equal(store.circuitBreakerStatus().pendingProofs, 0);
  });

  it('retryPendingProofs() while the first send is in flight does not duplicate it', async () => {
    const d = heldDaemon();
    const r = receipt();
    store.storeReceipt(r, 't');
    await sleep(5);
    assert.equal(await store.retryPendingProofs(), 1, 'still pending: owned by the attempt in flight');
    assert.equal(count(d.sent, String(r.nonce)), 1, 'retry did not open a second attempt');
    d.release(String(r.nonce));
    await sleep(10);
    assert.equal(store.circuitBreakerStatus().pendingProofs, 0);
    assert.equal(count(d.sent, String(r.nonce)), 1);
  });
});

describe('RV04 — local idempotency vs uncertain remote acceptance', () => {
  it('daemon refused (HTTP 503) → certain failure, not counted as uncertain', async () => {
    liveDaemon();
    store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
    assert.equal(store.circuitBreakerStatus().uncertainDispatches, 0);
    assert.equal(store.circuitBreakerStatus().pendingProofs, 1);
  });

  it('connection refused → certain non-delivery, not uncertain', async () => {
    globalThis.fetch = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
    store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
    assert.equal(store.circuitBreakerStatus().uncertainDispatches, 0);
  });

  it('timeout without answer → uncertain; a later acceptance is reported as a possible duplicate job', async () => {
    let first = true;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      if (first) { first = false; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
      const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
      return new Response(JSON.stringify({ jobId: `job-${nonce}` }), { status: 202 });
    }) as typeof fetch;
    const r = receipt();
    store.storeReceipt(r, 't'); await store.awaitLastDispatch();
    assert.equal(store.circuitBreakerStatus().uncertainDispatches, 1, 'outcome unknown: the daemon may have enqueued it');
    assert.equal(store.circuitBreakerStatus().pendingProofs, 1, 'still pending locally');
    assert.equal(await store.retryPendingProofs(), 0);
    assert.equal(store.circuitBreakerStatus().possibleDuplicateJobs, 1,
      'the re-send after an uncertain attempt may have created a second job (daemon does not deduplicate)');
  });
});

describe('RV05 — recovery without new client traffic', () => {
  it('prover returns, no new receipt: the recovery loop sends every pending receipt', async () => {
    const d = liveDaemon();
    const rs = [receipt(), receipt(), receipt()];
    for (const r of rs) { store.storeReceipt(r, 't'); await store.awaitLastDispatch(); }
    assert.equal(store.circuitBreakerStatus().open, true);
    assert.equal(store.circuitBreakerStatus().pendingProofs, 3);
    const attemptsWhileDown = d.sent.length;

    store.startProofRecovery({ intervalMs: 20 });
    d.mode = 'up';
    const deadline = Date.now() + 2000;
    while (store.circuitBreakerStatus().pendingProofs > 0 && Date.now() < deadline) await sleep(20);

    const s = store.circuitBreakerStatus();
    assert.equal(s.pendingProofs, 0, 'all pending sent without new traffic');
    assert.equal(s.open, false);
    const accepted = d.sent.slice(attemptsWhileDown);
    for (const r of rs) assert.ok(accepted.includes(String(r.nonce)), `nonce ${r.nonce} accepted`);
    for (const r of rs) assert.ok(count(d.sent, String(r.nonce)) <= 2, 'no repeated re-sends');
  });

  it('while open and inside the cooldown the loop does not hammer the prover', async () => {
    process.env['PROVER_CB_COOLDOWN_MS'] = '10000';
    try {
      const d = liveDaemon();
      store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
      store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
      const before = d.sent.length;
      store.startProofRecovery({ intervalMs: 10 });
      await sleep(150);
      assert.equal(d.sent.length, before, 'no call during cooldown');
    } finally { process.env['PROVER_CB_COOLDOWN_MS'] = '40'; }
  });

  it('stopProofRecovery() stops the loop; start is idempotent', async () => {
    const d = liveDaemon();
    store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
    store.storeReceipt(receipt(), 't'); await store.awaitLastDispatch();
    store.startProofRecovery({ intervalMs: 20 });
    store.startProofRecovery({ intervalMs: 20 });
    assert.equal(store.proofRecoveryRunning(), true);
    store.stopProofRecovery();
    assert.equal(store.proofRecoveryRunning(), false);
    d.mode = 'up';
    const before = d.sent.length;
    await sleep(150);
    assert.equal(d.sent.length, before, 'nothing sent after stop');
    assert.equal(store.circuitBreakerStatus().pendingProofs, 2);
  });

  it('resetProverStateForTest() also stops the loop (test isolation)', () => {
    store.startProofRecovery({ intervalMs: 20 });
    assert.equal(store.proofRecoveryRunning(), true);
    store.resetProverStateForTest();
    assert.equal(store.proofRecoveryRunning(), false);
  });

  it('with PROVER_URL=disabled the loop does not start', () => {
    process.env['PROVER_URL'] = 'disabled';
    store.startProofRecovery({ intervalMs: 20 });
    assert.equal(store.proofRecoveryRunning(), false);
  });
});
