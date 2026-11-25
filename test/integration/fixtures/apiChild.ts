/**
 * Shared child-process harness for integration tests that start the API entrypoint (`tsx src/api/server.ts`).
 *
 * OVERNIGHT 20261005 / Phase 1: these tests failed in the full `npm test` with "timeout waiting for API health"
 * (audit 2786/2793, baseline 2789/2793), each time in a different case of the same files. Measured on the
 * candidate host (docs/_ops/OVERNIGHT_20261005_MASTER/probes/p1_startup): the cold start is spent loading the
 * module graph before the first output line; 3.7–14.8 s one at a time, 9–22 s with 4 simultaneous starts,
 * 12.8–32.7 s with 7 (the suite runs ~7 files in parallel), and > 60 s with no output at all on a host with
 * < 0.5 GiB free. The fixed 30 s deadline sat inside that distribution, so a case failed whenever its start
 * landed in the tail; the cases after it then failed by cascade.
 *
 * What changes (the assertions of the tests do NOT): the readiness wait detects an exited child at once and
 * reports its output; the deadline is READINESS_MS, a bound on "never became ready", not a latency claim; each
 * start is recorded (OTK_TEST_STARTUP_LOG) so the distribution inside the suite stays observable.
 *
 * Used by `core_flow_restart.test.ts`, `cw_runtime_wiring.test.ts` and `prover_recovery_restart_rv05.test.ts`.
 * Reads the environment variables `OTK_TEST_READINESS_MS` (readiness deadline in ms, default 120 000) and
 * `OTK_TEST_STARTUP_LOG` (optional JSONL file that receives one line per start). The child gets the environment
 * the caller passes plus `API_PORT`; this module does not add or remove any other variable. On Windows,
 * stopping a child may also kill whichever process still listens on its port.
 *
 * @module test/integration/fixtures/apiChild
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root; the API child runs with this as its working directory. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWin = process.platform === 'win32';
const TSX = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

/** Upper bound for "the API never became ready" (see the measurements above); a crash fails at once. */
export const READINESS_MS = Number(process.env['OTK_TEST_READINESS_MS'] ?? 120_000);

/**
 * A running API child: the process, its port, every stdout/stderr chunk received so far (in order), and the start
 * time in ms since the Unix epoch.
 */
export interface ApiChild { proc: ChildProcess; port: number; output: string[]; startedAt: number }

/**
 * Finds a free TCP port by binding port 0 on 127.0.0.1 and closing it again.
 *
 * @returns The port number. Another process may take it before the caller binds it.
 * @throws {Error} When the server address cannot be read, or the probe server fails to listen.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
    srv.on('error', reject);
  });
}

/**
 * Spawn the entrypoint exactly as before (cmd.exe → tsx on Windows); output is kept for diagnostics.
 *
 * @param port - Port the API must listen on (passed as `API_PORT`).
 * @param env - Full environment for the child (not merged with `process.env` here).
 * @returns The child handle; the process is started but not yet ready (see {@link waitReady}).
 */
export function spawnApi(port: number, env: NodeJS.ProcessEnv): ApiChild {
  const [cmd, args] = isWin ? ['cmd.exe', ['/c', TSX, 'src/api/server.ts']] : [TSX, ['src/api/server.ts']];
  const proc = spawn(cmd, args, { cwd: ROOT, env: { ...env, API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], ...(isWin ? {} : { detached: true }) });
  const output: string[] = [];
  proc.stdout?.on('data', (d) => { output.push(String(d)); });
  proc.stderr?.on('data', (d) => { output.push(String(d)); });
  return { proc, port, output, startedAt: Date.now() };
}

/**
 * Wait until GET /health answers ok; fail at once if the child exits; report its output on failure.
 *
 * @param child - Child returned by {@link spawnApi}.
 * @param label - Name used in error messages and in the optional startup log.
 * @returns Time from spawn to readiness, in ms.
 * @throws {Error} When the child exits before it is ready, or it is not ready within {@link READINESS_MS} of its
 *   start; the message carries the last 1500 characters of its output.
 */
export async function waitReady(child: ApiChild, label: string): Promise<number> {
  const deadline = child.startedAt + READINESS_MS;
  while (Date.now() < deadline) {
    if (child.proc.exitCode !== null) throw new Error(`${label}: API exited (code ${child.proc.exitCode}) before ready: ${tail(child)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${child.port}/health`, { signal: AbortSignal.timeout(1000) })).ok) {
        const ms = Date.now() - child.startedAt;
        record(label, ms, true);
        return ms;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  record(label, Date.now() - child.startedAt, false);
  throw new Error(`${label}: API not ready within ${READINESS_MS} ms: ${tail(child)}`);
}

const tail = (c: ApiChild) => JSON.stringify(c.output.join('').slice(-1500));

function record(label: string, ms: number, ok: boolean): void {
  const file = process.env['OTK_TEST_STARTUP_LOG'];
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ label, ms, ok, at: new Date().toISOString(), pid: process.pid }) + '\n'); } catch { /* diagnostics only */ }
}

/**
 * Windows: the server is a grandchild (cmd.exe → tsx → node); `taskkill /T` can leave it orphaned when the tree
 * is already breaking up, holding the port and this test file's pipes (fechamento pós-S5, 2026-10-02). So kill
 * whoever still listens on the port, then close the pipes and unref the child.
 *
 * @param port - TCP port whose listening process (found with `netstat`) is force-killed; no-op off Windows.
 */
function killPortHolder(port: number): void {
  if (!isWin) return;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
  for (const line of out.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`).exec(line);
    if (m && Number(m[1]) > 0) spawnSync('taskkill', ['/F', '/T', '/PID', m[1]!], { stdio: 'ignore' });
  }
}

/**
 * Kills the API child and its process tree, waits up to 5 s for it to exit, then releases its pipes.
 *
 * @param child - Child to stop; `undefined` or a child without a pid is a no-op.
 * @returns Resolves when the child exited or the 5 s wait ended; never rejects on a kill failure.
 */
export async function stopApi(child: ApiChild | undefined): Promise<void> {
  if (!child?.proc.pid) return;
  const p = child.proc;
  if (p.exitCode === null) {
    const exited = new Promise<void>((r) => p.on('exit', () => r()));
    if (isWin) spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' });
    else { try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  killPortHolder(child.port);
  p.stdout?.destroy(); p.stderr?.destroy(); p.unref();
}
