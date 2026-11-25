/**
 * ProverDaemon — ZK Proof Generation Microservice
 *
 * Standalone HTTP service that:
 *   1. Accepts proof requests via REST API
 *   2. Queues and generates Groth16 ZK proofs (metering_v1 / metering_v2)
 *   3. Optionally submits verified proofs to blockchain (ReceiptRegistry)
 *
 * Architecture:
 *   - Single worker loop (CPU-bound: 1 proof at a time)
 *   - Durable queue (DurableProofQueue) — JSONL checkpoint + retry/DLQ (PA-01)
 *   - HTTP API: POST /prove, GET /status/:id, GET /health, GET /metrics
 *
 * Usage:
 *   PROVER_PORT=3001 \
 *   PROVER_WASM_V1=zk/build/metering_v1_js/metering_v1.wasm \
 *   PROVER_ZKEY_V1=zk/keys/metering_v1_final.zkey \
 *   PROVER_WASM_V2=zk/build/metering_v2_js/metering_v2.wasm \
 *   PROVER_ZKEY_V2=zk/keys/metering_v2_final.zkey \
 *   npx tsx src/prover/ProverDaemon.ts
 *
 * API:
 *   POST /prove            — enqueue a proof request, returns { jobId }
 *   GET  /status/:jobId   — poll job status + result
 *   GET  /health          — liveness check
 *   GET  /metrics         — queue stats
 *
 * Runs as its own process (started by running this file). Other environment variables read: OTK_REDIS_URL
 * (BullMQ queue instead of the local durable queue), OTK_PROOF_QUEUE_LOG, PROVER_MAX_ATTEMPTS,
 * OTK_ZK_KEY_PATH, and the chain settings listed at the on-chain submission helper below (the signer key is a
 * secret and is never logged). The metrics route is guarded by `src/observability/metricsAccess.ts`.
 * This file is scanned as text by the route inventory script under `scripts/ops/`.
 *
 * @module src/prover/ProverDaemon
 * @since U13 (2026-02-22)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';
import { type ProofInput, type ProofResult } from './ProofQueue.js';
import { DurableProofQueue } from './DurableProofQueue.js';
import { proverMetrics } from './proverMetrics.js';
import { metricsAccessAllowed } from '../observability/metricsAccess.js';
import { submitProofOnChain as submitVersioned, normalizeVersion } from './onChainSubmission.js';
import { BullMQProofQueue } from './BullMQProofQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env['PROVER_PORT'] ?? '3001', 10);

const CIRCUIT_PATHS = {
  v1: {
    wasm: process.env['PROVER_WASM_V1'] ??
      path.join(REPO_ROOT, 'zk/build/metering_v1_js/metering_v1.wasm'),
    zkey: process.env['PROVER_ZKEY_V1'] ??
      path.join(REPO_ROOT, 'zk/keys/metering_v1_final.zkey'),
  },
  v2: {
    wasm: process.env['PROVER_WASM_V2'] ??
      path.join(REPO_ROOT, 'zk/build/metering_v2_js/metering_v2.wasm'),
    // GAP-B-006: default to MPC key (5 contributors + Hermez Phase 1), NOT the dev single-party key
    zkey: process.env['PROVER_ZKEY_V2'] ??
      path.join(REPO_ROOT, 'zk/keys/metering_v2_final_mpc.zkey'),
  },
};

// Worker poll interval (ms)
const WORKER_POLL_MS = 50;

// ---------------------------------------------------------------------------
// Helper: JSON response
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'X-Service': 'OTK-ProverDaemon/1.0',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Proof worker
// ---------------------------------------------------------------------------

async function generateProof(input: ProofInput): Promise<ProofResult> {
  const rawVer = input.circuitVersion ?? 'v1';
  const version = rawVer.startsWith('v') ? rawVer : `v${rawVer}`;

  // S5.2: OTK_ZK_KEY_PATH overrides v2 zkey at proof time (key rotation without restart).
  // Read at call time, not at module load — this enables hot key rotation via env var update.
  const circuitEntry = CIRCUIT_PATHS[version as 'v1' | 'v2'];
  const wasm = circuitEntry.wasm;
  const zkey = version === 'v2' && process.env['OTK_ZK_KEY_PATH']
    ? process.env['OTK_ZK_KEY_PATH']
    : circuitEntry.zkey;

  if (!existsSync(wasm)) throw new Error(`WASM not found: ${wasm}`);
  if (!existsSync(zkey)) throw new Error(`zkey not found: ${zkey}`);

  // Normalize input for each circuit version
  const circuitInput: Record<string, string> = {
    userId: input.userId,
    usage: input.usage,
    nonce: input.nonce,
    epoch: input.epoch,
  };

  if (version === 'v2') {
    if (!input.minUsageBucket || !input.maxUsageBucket) {
      throw new Error('v2 requires minUsageBucket + maxUsageBucket');
    }
    circuitInput['minUsageBucket'] = input.minUsageBucket;
    circuitInput['maxUsageBucket'] = input.maxUsageBucket;
  } else {
    // v1: maxUsage
    const maxUsage = input.maxUsage ?? input.maxUsageBucket ?? '1000000';
    circuitInput['maxUsage'] = maxUsage;
  }

  const t0 = Date.now();
  const { proof, publicSignals } = await groth16.fullProve(circuitInput, wasm, zkey);
  const proveMs = Date.now() - t0;

  // S5.2: include key + circuit metadata in result for traceability
  const keyVersion = path.basename(zkey, '.zkey');

  return {
    proof: proof as ProofResult['proof'],
    publicSignals,
    proveMs,
    keyVersion,
    circuitVersion: version,
  };
}

// ---------------------------------------------------------------------------
// On-chain submission (PA-03)
// ---------------------------------------------------------------------------

/**
 * Submit a generated ZK proof on-chain to the registry of its circuit version (R19).
 * ABI, registry address and public-signal count come from onChainSubmission.ts.
 *
 * Returns the confirmed tx hash on success; null when chain configuration is absent
 * (dev mode). Throws when the proof's version has no registry configured or on
 * submission failure, so the job fails and is retried / dead-lettered visibly.
 *
 * Env vars:
 *   OTK_RPC_URL              — JSON-RPC endpoint (e.g. http://localhost:8545)
 *   OTK_REGISTRY_ADDRESS     — ReceiptRegistry (v1) address
 *   OTK_REGISTRY_V2_ADDRESS  — ReceiptRegistryV2 address (required for v2 proofs)
 *   OTK_SIGNER_KEY           — private key of trustedSigner
 *
 * @param input - The job's proof inputs (its circuit version is the fallback).
 * @param result - The generated proof.
 * @returns The transaction hash, or `null` when the chain is not configured.
 * @throws {Error} When the version has no registry configured or the submission fails.
 * @since PA-03 | R19 (version-aware submission)
 */
async function submitProofOnChain(input: ProofInput, result: ProofResult): Promise<string | null> {
  return submitVersioned(result.circuitVersion ?? input.circuitVersion, input, result, {
    rpcUrl: process.env['OTK_RPC_URL'],
    signerKey: process.env['OTK_SIGNER_KEY'],
    registry: {
      v1: process.env['OTK_REGISTRY_ADDRESS'],
      v2: process.env['OTK_REGISTRY_V2_ADDRESS'],
    },
  });
}

// ---------------------------------------------------------------------------
// Queue adapter — unified interface for Phase 1 (DurableProofQueue) and
// Phase 2 (BullMQ/Redis). Used by the HTTP handlers.
// ---------------------------------------------------------------------------

interface QueueJobInfo {
  jobId: string;
  status: string;
  attempts: number;
  result?: ProofResult;
  txHash?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  nextRetryAt?: number;
}

interface IProofQueueAdapter {
  enqueue(input: ProofInput): Promise<string>;
  getJob(id: string): Promise<QueueJobInfo | null>;
  size(): Promise<number>;
  stats(): Promise<{ pending: number; done: number; dead_letter: number; failed: number }>;
}

/**
 * Wraps DurableProofQueue (sync) as an async IProofQueueAdapter.
 *
 * @param q - The local durable queue.
 * @returns The adapter.
 */
function makeDurableAdapter(q: DurableProofQueue): IProofQueueAdapter {
  return {
    enqueue: (input) => Promise.resolve(q.enqueue(input)),
    getJob: (id) => {
      const job = q.get(id);
      if (!job) return Promise.resolve(null);
      return Promise.resolve({
        jobId: job.id,
        status: job.status,
        attempts: job.attempts,
        result: job.result,
        txHash: job.txHash,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        nextRetryAt: job.nextRetryAt,
      });
    },
    size: () => Promise.resolve(q.size()),
    stats: () => Promise.resolve(q.stats()),
  };
}

/**
 * Wraps BullMQProofQueue (async) as an IProofQueueAdapter.
 *
 * @param q - The BullMQ queue.
 * @returns The adapter.
 */
function makeBullMQAdapter(q: BullMQProofQueue): IProofQueueAdapter {
  return {
    enqueue: (input) => q.enqueue(input),
    getJob: async (id) => {
      const s = await q.getJobStatus(id);
      if (!s) return null;
      return { jobId: s.jobId, status: s.status, attempts: s.attempts,
        result: s.result, txHash: s.txHash, error: s.error,
        createdAt: s.createdAt, updatedAt: s.updatedAt };
    },
    size: () => q.size(),
    stats: () => q.stats(),
  };
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: IProofQueueAdapter,
): Promise<void> {
  const base = `http://localhost:${PORT}`;
  const url = new URL(req.url ?? '/', base);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  try {
    // GET /health
    if (method === 'GET' && pathname === '/health') {
      const v1Ok = existsSync(CIRCUIT_PATHS.v1.wasm) && existsSync(CIRCUIT_PATHS.v1.zkey);
      const v2Ok = existsSync(CIRCUIT_PATHS.v2.wasm) && existsSync(CIRCUIT_PATHS.v2.zkey);
      return sendJson(res, 200, {
        status: 'ok',
        circuits: { v1: v1Ok ? 'ready' : 'missing', v2: v2Ok ? 'ready' : 'missing' },
        queueSize: await adapter.size(),
        uptime: process.uptime(),
      });
    }

    // GET /metrics — Prometheus text format (PA-06)
    if (method === 'GET' && pathname === '/metrics') {
      // STOPGATE-01 P1.2: same rule as the API (OTK_METRICS_TOKEN or platform credential in deployed environments)
      if (!metricsAccessAllowed(req.headers as Record<string, string | string[] | undefined>)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="otk-metrics"');
        return sendJson(res, 401, { error: 'metrics_unauthorized' });
      }
      const stats = await adapter.stats();
      proverMetrics.queueDepthGauge.labels('pending').set(stats.pending);
      proverMetrics.queueDepthGauge.labels('done').set(stats.done);
      proverMetrics.queueDepthGauge.labels('dead_letter').set(stats.dead_letter);
      const text = await proverMetrics.registry.metrics();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'X-Service': 'OTK-ProverDaemon/1.0',
      });
      res.end(text);
      return;
    }

    // POST /prove
    if (method === 'POST' && pathname === '/prove') {
      const body = await readBody(req);
      let input: ProofInput;
      try {
        input = JSON.parse(body) as ProofInput;
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }

      if (!input.userId || !input.usage || !input.nonce || !input.epoch) {
        return sendJson(res, 400, { error: 'Missing required fields: userId, usage, nonce, epoch' });
      }

      // N15: bind the job to the registry configured now for its circuit version
      let version: 'v1' | 'v2';
      try { version = normalizeVersion(input.circuitVersion); } catch {
        return sendJson(res, 400, { error: `unsupported circuit version: ${String(input.circuitVersion)}` });
      }
      const target = process.env[version === 'v2' ? 'OTK_REGISTRY_V2_ADDRESS' : 'OTK_REGISTRY_ADDRESS'];
      if (target) input.targetRegistry = target;
      const jobId = await adapter.enqueue(input);
      return sendJson(res, 202, { jobId, status: 'pending' });
    }

    // GET /status/:jobId
    const statusMatch = pathname.match(/^\/status\/([a-zA-Z0-9\-_]+)$/);
    if (method === 'GET' && statusMatch) {
      const jobId = statusMatch[1];
      const job = await adapter.getJob(jobId);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });

      return sendJson(res, 200, {
        jobId: job.jobId,
        status: job.status,
        attempts: job.attempts,
        ...(job.nextRetryAt ? { nextRetryAt: job.nextRetryAt } : {}),
        ...(job.txHash ? { txHash: job.txHash } : {}),
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    }

    return sendJson(res, 404, { error: 'Not found' });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: msg });
  }
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

function log(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}

async function workerLoop(queue: DurableProofQueue): Promise<never> {
  log({ event: 'worker_start' });
  for (;;) {
    const job = queue.dequeue();
    if (!job) {
      await new Promise((r) => setTimeout(r, WORKER_POLL_MS));
      continue;
    }

    log({ event: 'job_start', jobId: job.id, circuitVersion: job.input.circuitVersion ?? 'v1' });
    try {
      const result = await generateProof(job.input);
      // PA-03: attempt on-chain submission; null if OTK_RPC_URL/REGISTRY/SIGNER not configured (dev mode).
      // Throws on submission failure → triggers retry via queue.fail().
      const txHash = await submitProofOnChain(job.input, result);
      // PA-04: persist txHash before complete() to close the nonce-gap crash window.
      // If daemon crashes here, _restore() detects processing+txHash and marks done.
      if (txHash) queue.markSubmitted(job.id, txHash);
      queue.complete(job.id, result, txHash ?? undefined);
      // PA-06: record proof outcome in Prometheus counter
      proverMetrics.recordProof('done', result.proveMs);
      log({ event: 'job_done', jobId: job.id, proveMs: result.proveMs, ...(txHash ? { txHash } : {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      queue.fail(job.id, msg);
      const finalStatus = queue.get(job.id)?.status === 'dead_letter' ? 'dead_letter' : 'failed';
      proverMetrics.recordProof(finalStatus);
      log({ event: 'job_failed', jobId: job.id, error: msg, finalStatus });
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const REDIS_URL = process.env['OTK_REDIS_URL'];
const MAX_ATTEMPTS = Number(process.env['PROVER_MAX_ATTEMPTS'] ?? 3);

let adapter: IProofQueueAdapter;

if (REDIS_URL) {
  // PA-07: BullMQ/Redis mode — durable queue with Redis backend
  log({ event: 'queue_mode', mode: 'bullmq', redisUrl: REDIS_URL.replace(/:[^@]*@/, ':***@') });
  const bullmqQueue = new BullMQProofQueue(REDIS_URL);
  adapter = makeBullMQAdapter(bullmqQueue);

  // BullMQ Worker: event-driven processing (replaces polling workerLoop)
  import('bullmq').then(({ Worker }) => {
    const worker = new Worker(
      BullMQProofQueue.QUEUE_NAME,
      async (bullJob) => {
        const input = bullJob.data as import('./BullMQProofQueue.js').BullMQJobData;
        log({ event: 'job_start', jobId: bullJob.id, circuitVersion: input.circuitVersion ?? 'v1', mode: 'bullmq' });

        // PA-04 equivalence: if job already has txHash in data → proof already on-chain, skip resubmit
        if (input._txHash) {
          log({ event: 'job_resumed', jobId: bullJob.id, txHash: input._txHash });
          const fakeResult = { proof: { pi_a: [], pi_b: [], pi_c: [], protocol: 'groth16', curve: 'bn128' }, publicSignals: [], proveMs: 0 };
          return { result: fakeResult as import('./ProofQueue.js').ProofResult, txHash: input._txHash };
        }

        const result = await generateProof(input);
        const txHash = await submitProofOnChain(input, result);

        // PA-04 equivalence: persist txHash before job completion
        if (txHash) await bullJob.updateData({ ...input, _txHash: txHash });

        proverMetrics.recordProof('done', result.proveMs);
        log({ event: 'job_done', jobId: bullJob.id, proveMs: result.proveMs, ...(txHash ? { txHash } : {}), mode: 'bullmq' });
        return { result, txHash: txHash ?? undefined };
      },
      {
        connection: { url: REDIS_URL, maxRetriesPerRequest: null },
        concurrency: 1,
        stalledInterval: 30_000,
        maxStalledCount: MAX_ATTEMPTS,
      },
    );

    worker.on('failed', (bullJob, err) => {
      proverMetrics.recordProof('dead_letter');
      log({ event: 'job_failed', jobId: bullJob?.id ?? 'unknown', error: String(err), mode: 'bullmq' });
    });

    log({ event: 'worker_start', mode: 'bullmq' });
  }).catch((err) => {
    log({ event: 'worker_error', error: String(err) });
    process.exit(1);
  });

} else {
  // Phase 1: DurableProofQueue with JSONL checkpoint and polling workerLoop
  const durableQueue = new DurableProofQueue(
    process.env['OTK_PROOF_QUEUE_LOG'] ?? null,
    { maxAttempts: MAX_ATTEMPTS },
  );
  adapter = makeDurableAdapter(durableQueue);
  log({ event: 'queue_mode', mode: 'durable', queueLog: process.env['OTK_PROOF_QUEUE_LOG'] ?? '(in-memory)' });
  // Worker runs concurrently (polling)
  workerLoop(durableQueue);
}

const server = createServer((req, res) => {
  handleRequest(req, res, adapter).catch((err) => {
    process.stderr.write(`[ProverDaemon] Unhandled: ${err}\n`);
    sendJson(res, 500, { error: 'Internal server error' });
  });
});

server.listen(PORT, () => {
  log({ event: 'server_start', port: PORT });
});
