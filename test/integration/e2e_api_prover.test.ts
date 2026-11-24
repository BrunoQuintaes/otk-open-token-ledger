/**
 * GAP-D-004 — E2E: API server + ProverDaemon stub
 *
 * Tests the full HTTP flow in isolation:
 *   POST /receipts → fire-and-forget dispatch → stub ProverDaemon
 *   → job created → GET /receipts/:id → GET /status/:jobId (stub)
 *   → POST /admin/flush-batch → GET /admin/chain-head
 *
 * Architecture rationale:
 *   PROVER_URL is captured at module load time in receiptStore.ts. Running the
 *   API in the same process as the test would ignore our stub port (the const
 *   is already resolved). Child process isolation ensures the spawned API server
 *   sees PROVER_URL=http://127.0.0.1:<stubPort>.
 *
 * Components:
 *   - Stub ProverDaemon: real in-process HTTP server (POST /prove, GET /status/:id, GET /health)
 *   - API server: child process spawned via tsx with injected env vars
 *
 * @since u12.remaining.g (GAP-D-004 closure)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find an available TCP port by briefly binding to 0 (OS assigns ephemeral port). */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('getFreePort: could not get address'));
      });
    });
    srv.on('error', reject);
  });
}

/**
 * Poll URL until it returns HTTP 2xx. Fechamento pós-S5: the child is transpiled by tsx at start (~6–8 s
 * idle on the reference machine) and, inside the parallel `npm test`, exceeded the former fixed 15 s
 * (S4: 8 cancellations in 2/2 runs; fps5: 1/3). The wait now lasts while the child is alive, up to 60 s,
 * and fails at once, with the child's stderr, if it exits — a crash is never mistaken for slowness.
 */
async function waitForHealth(url: string, child: ChildProcess, stderrTail: () => string, maxMs = 60000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API server exited before becoming healthy (code ${child.exitCode}, signal ${child.signalCode}): ${stderrTail()}`);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(600) });
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not become healthy within ${maxMs}ms: ${url}; stderr: ${stderrTail()}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('E2E: API server + ProverDaemon stub (GAP-D-004)', () => {
  let stubPort: number;
  let apiPort: number;
  let stubServer: Server;
  let apiProc: ChildProcess;

  /** Jobs dispatched to stub by the API's fire-and-forget. */
  const stubJobs = new Map<string, { jobId: string; status: string }>();

  // -------------------------------------------------------------------------
  // Setup: start stub ProverDaemon + spawn API server child process
  // -------------------------------------------------------------------------

  before(async () => {
    [stubPort, apiPort] = await Promise.all([getFreePort(), getFreePort()]);

    // — Stub ProverDaemon (real HTTP server, in-process) —
    stubServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${stubPort}`);

      if (req.method === 'GET' && u.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          circuits: { v1: 'ready', v2: 'ready' },
          queueSize: 0,
        }));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/prove') {
        let body = '';
        req.on('data', (chunk: Buffer | string) => { body += String(chunk); });
        req.on('end', () => {
          const jobId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          stubJobs.set(jobId, { jobId, status: 'done' });
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId, status: 'pending' }));
        });
        return;
      }

      const statusMatch = u.pathname.match(/^\/status\/(.+)$/);
      if (req.method === 'GET' && statusMatch) {
        const jobId = decodeURIComponent(statusMatch[1]);
        const job = stubJobs.get(jobId);
        if (!job) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jobId,
          status: job.status,
          result: {
            proof: { pi_a: [], pi_b: [], pi_c: [], protocol: 'groth16' },
            publicSignals: ['0', '20139', '1000000'],
            proveMs: 1,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      stubServer.listen(stubPort, '127.0.0.1', resolve);
      stubServer.on('error', reject);
    });

    // — Spawn API server child process with stub env —
    const isWin = process.platform === 'win32';
    // On Windows, invoke cmd.exe /c tsx.cmd to avoid DEP0190 (shell+args deprecation)
    const tsxBin = path.join(
      ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx',
    );

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Open mode: remove multi-tenant auth so /receipts needs no Bearer token
    delete childEnv['OTK_TENANTS'];
    // PA-07B: disable Postgres write-behind in child (uses in-memory only for this E2E test)
    delete childEnv['OTK_DB_URL'];
    childEnv['API_PORT'] = String(apiPort);
    childEnv['PROVER_URL'] = `http://127.0.0.1:${stubPort}`;
    childEnv['OTK_ADMIN_KEY'] = 'e2e-admin-key';
    childEnv['OTK_RECEIPT_LOG'] = ''; // no disk I/O
    childEnv['NODE_ENV'] = 'test';

    const [spawnCmd, spawnArgs] = isWin
      ? ['cmd.exe', ['/c', tsxBin, 'src/api/server.ts']]
      : [tsxBin, ['src/api/server.ts']];

    apiProc = spawn(spawnCmd, spawnArgs, {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Linux: create a new process group so process.kill(-pid, 'SIGKILL')
      // terminates the entire tree (tsx → node). No-op on Windows (handled via taskkill).
      ...(isWin ? {} : { detached: true }),
    });

    let stderrBuf = '';
    apiProc.stdout?.on('data', () => {}); // drain stdout
    apiProc.stderr?.on('data', (d: Buffer) => { stderrBuf = (stderrBuf + d.toString('utf8')).slice(-4000); }); // drain, keep the tail

    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, apiProc, () => stderrBuf);
  });

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  after(async () => {
    if (apiProc?.pid) {
      if (process.platform === 'win32') {
        // On Windows, use taskkill /T to kill the full process tree
        // (cmd.exe → tsx.cmd → node.exe won't terminate with just SIGTERM)
        spawn('taskkill', ['/F', '/T', '/PID', String(apiProc.pid)], { stdio: 'ignore' });
      } else {
        // Kill the entire process group (PGID = apiProc.pid when detached=true).
        // This ensures tsx and any child node processes are terminated immediately.
        try { process.kill(-apiProc.pid!, 'SIGKILL'); } catch { apiProc.kill('SIGKILL'); }
      }
    }
    // Wait for process exit or timeout (max 3s)
    await new Promise<void>(resolve => {
      if (!apiProc || apiProc.exitCode !== null) { resolve(); return; }
      apiProc.on('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    await new Promise<void>(resolve => stubServer.close(() => resolve()));
  });

  // -------------------------------------------------------------------------
  // Convenience URL builders
  // -------------------------------------------------------------------------

  const api = (p: string) => `http://127.0.0.1:${apiPort}${p}`;
  const stub = (p: string) => `http://127.0.0.1:${stubPort}${p}`;

  // -------------------------------------------------------------------------
  // T1: GET /health — API server is alive
  // -------------------------------------------------------------------------

  it('T1: GET /health → ok=true + uptime', async () => {
    const r = await fetch(api('/health'));
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['ok'], true);
    assert.ok(typeof b['uptime'] === 'string', 'uptime must be string');
    assert.ok(typeof b['ts'] === 'string', 'ts must be ISO string');
  });

  // -------------------------------------------------------------------------
  // T2: Stub ProverDaemon /health — stub is alive
  // -------------------------------------------------------------------------

  it('T2: stub ProverDaemon GET /health → status ok', async () => {
    const r = await fetch(stub('/health'));
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['status'], 'ok');
    const circuits = b['circuits'] as Record<string, string>;
    assert.equal(circuits['v1'], 'ready');
  });

  // -------------------------------------------------------------------------
  // T3: POST /receipts → 201 accepted
  // -------------------------------------------------------------------------

  it('T3: POST /receipts → 201 with requestId + costUnits', async () => {
    const r = await fetch(api('/receipts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'e2e-d004-req-001',
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 50,
        costUnits: 150,
        userId: '99',
        nonce: '7',
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
    assert.equal(r.status, 201);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['ok'], true);
    assert.equal(b['requestId'], 'e2e-d004-req-001');
    // D5-G04: the server computes CU = (100 + 50) × 0.4 (gpt-4o-mini) × 1.0 (openai) = 60;
    // the client's declared 150 used to be echoed and debited, now it is only reported
    assert.equal(b['costUnits'], 60);
    assert.equal(b['clientDeclaredCostUnits'], 150);
  });

  // -------------------------------------------------------------------------
  // T4: ProverDaemon dispatch — fire-and-forget reached stub
  // -------------------------------------------------------------------------

  it('T4: fire-and-forget dispatch → stub received prove job', async () => {
    // Dispatch is async in the API server; give it time to complete
    await new Promise(r => setTimeout(r, 1000));
    assert.ok(
      stubJobs.size >= 1,
      `Expected ≥1 job dispatched to stub, got ${stubJobs.size}`,
    );
  });

  // -------------------------------------------------------------------------
  // T5: GET /receipts/:id — receipt is retrievable
  // -------------------------------------------------------------------------

  it('T5: GET /receipts/e2e-d004-req-001 → stored + correct fields', async () => {
    const r = await fetch(api('/receipts/e2e-d004-req-001'));
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['ok'], true);
    const rec = b['receipt'] as Record<string, unknown>;
    assert.equal(rec['requestId'], 'e2e-d004-req-001');
    assert.equal(rec['provider'], 'openai');
    assert.equal(rec['model'], 'gpt-4o-mini');
  });

  // -------------------------------------------------------------------------
  // T6: GET stub /status/:jobId — job queryable on stub
  // -------------------------------------------------------------------------

  it('T6: GET stub /status/:jobId → status=done', async () => {
    const jobId = [...stubJobs.keys()][0];
    assert.ok(jobId, 'Precondition: T4 must have received a job');
    const r = await fetch(stub(`/status/${jobId}`));
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['jobId'], jobId);
    assert.equal(b['status'], 'done');
    assert.ok(b['result'] !== undefined, 'result must be present for done job');
  });

  // -------------------------------------------------------------------------
  // T7: POST /admin/flush-batch — aggregates into Merkle batch
  // -------------------------------------------------------------------------

  it('T7: POST /admin/flush-batch → flushed ≥ 1 with non-null batch', async () => {
    const r = await fetch(api('/admin/flush-batch'), {
      method: 'POST',
      headers: { 'x-admin-key': 'e2e-admin-key' },
    });
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['ok'], true);
    assert.ok(
      typeof b['flushed'] === 'number' && (b['flushed'] as number) >= 1,
      `Expected flushed ≥ 1, got ${String(b['flushed'])}`,
    );
    assert.ok(b['batch'] !== null, 'Expected non-null batch after flush');
    const batch = b['batch'] as Record<string, unknown>;
    assert.ok(typeof batch['root'] === 'string', 'batch.root must be string');
  });

  // -------------------------------------------------------------------------
  // T8: GET /admin/chain-head — audit chain advanced past genesis
  // -------------------------------------------------------------------------

  it('T8: GET /admin/chain-head → non-genesis 64-char hex + auditEntryCount ≥ 1', async () => {
    const r = await fetch(api('/admin/chain-head'), {
      headers: { 'x-admin-key': 'e2e-admin-key' },
    });
    assert.equal(r.status, 200);
    const b = await r.json() as Record<string, unknown>;
    assert.equal(b['ok'], true);
    const head = b['chainHead'] as string;
    assert.match(head, /^[0-9a-f]{64}$/, 'chainHead must be 64-char lowercase hex');
    assert.notEqual(
      head,
      '0000000000000000000000000000000000000000000000000000000000000000',
      'chainHead must have advanced past genesis zero',
    );
    assert.ok(
      typeof b['auditEntryCount'] === 'number' && (b['auditEntryCount'] as number) >= 1,
      `Expected auditEntryCount ≥ 1, got ${String(b['auditEntryCount'])}`,
    );
  });
});
