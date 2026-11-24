/**
 * D1–D8 / C — process-level helpers for real-service tests: API processes started through the
 * documented entrypoint (`tsx src/api/server.ts`), killed abruptly like a crash, and loopback
 * TCP relays that cut PostgreSQL/Redis on command (controlled outages without touching the
 * containers). Ports: 0 (OS-assigned) for every listener of this harness.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWin = process.platform === 'win32';
const TSX = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('port')))); });
  });
}

export interface Proc { proc: ChildProcess; port: number; log: string[]; extraPorts: Record<string, number> }

/** Upper bound for "the API never became ready" (see startApi); OTK_TEST_READINESS_MS overrides. */
export const READINESS_MS = Number(process.env['OTK_TEST_READINESS_MS'] ?? 120_000);

/** Startup durations inside the suite (OTK_TEST_STARTUP_LOG), so the distribution stays observable. */
export function recordStartup(label: string, ms: number, ok: boolean): void {
  const file = process.env['OTK_TEST_STARTUP_LOG'];
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ label, ms, ok, at: new Date().toISOString(), pid: process.pid }) + '\n'); } catch { /* diagnostics only */ }
}

/** Start the API entrypoint with `env` (OTK_* inherited from the test are removed first). */
export async function startApi(env: Record<string, string>, opts: { extraPorts?: string[]; waitPath?: string; timeoutMs?: number } = {}): Promise<Proc> {
  const port = await freePort();
  const extraPorts: Record<string, number> = {};
  for (const k of opts.extraPorts ?? []) extraPorts[k] = await freePort();
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('OTK_') || k === 'PROVER_URL') delete base[k];
  const [cmd, args] = isWin ? ['cmd.exe', ['/c', TSX, 'src/api/server.ts']] : [TSX, ['src/api/server.ts']];
  const proc = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...base, NODE_ENV: 'test', OTK_ADMIN_KEY: 'otkd1d8c-admin-fixture', PROVER_URL: 'disabled', ...env, ...Object.fromEntries(Object.entries(extraPorts).map(([k, v]) => [k, String(v)])), API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(isWin ? {} : { detached: true }),
  });
  const log: string[] = [];
  proc.stdout?.on('data', (d) => log.push(String(d)));
  proc.stderr?.on('data', (d) => log.push(String(d)));
  // OVERNIGHT 20261005 / Phase 1: readiness bound, not a latency claim. Cold starts measured on the candidate host:
  // 3.7–14.8 s alone, up to 32.7 s with 7 simultaneous starts, and > 60 s WITHOUT any output on a host with
  // < 0.5 GiB free (baseline services run 1: two "api did not start" with an empty log). A crash still fails at once.
  const t0 = Date.now();
  const deadline = t0 + (opts.timeoutMs ?? READINESS_MS);
  const probe = opts.waitPath ?? '/health';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`api exited ${proc.exitCode}: ${log.join('').slice(-3000)}`);
    try { const r = await fetch(`http://127.0.0.1:${port}${probe}`, { signal: AbortSignal.timeout(800) }); if (r.ok) { recordStartup('services api', Date.now() - t0, true); return { proc, port, log, extraPorts }; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  recordStartup('services api', Date.now() - t0, false);
  await killProc({ proc, port, log, extraPorts });
  throw new Error(`api did not start: ${log.join('').slice(-3000)}`);
}

const dumped = new WeakSet<ChildProcess>();

/** Abrupt stop (no graceful shutdown): what a crash or OOM kill looks like. */
export async function killProc(a: Proc): Promise<void> {
  // OVERNIGHT 20261005 / Phase 1 diagnostics: keep the child's own log (structured events, no secrets) when asked
  const dir = process.env['OTK_TEST_CHILD_LOG_DIR'];
  if (dir && !dumped.has(a.proc)) { dumped.add(a.proc); try { appendFileSync(path.join(dir, `api-${a.port}-${a.proc.pid}.log`), a.log.join('')); } catch { /* diagnostics only */ } }
  if (!a.proc.pid || a.proc.exitCode !== null) return;
  const exited = new Promise<void>((r) => a.proc.on('exit', () => r()));
  if (isWin) spawnSync('taskkill', ['/F', '/T', '/PID', String(a.proc.pid)], { stdio: 'ignore' });
  else { try { process.kill(-a.proc.pid, 'SIGKILL'); } catch { a.proc.kill('SIGKILL'); } }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/**
 * Loopback TCP relay to a real service. `cut()` destroys every open connection and refuses new
 * ones (the service looks down to the client); `restore()` accepts again. The service itself and
 * its data are untouched.
 */
export class TcpRelay {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private up = true;
  port = 0;
  constructor(private readonly targetHost: string, private readonly targetPort: number) {}

  async start(): Promise<number> {
    this.server = net.createServer((client) => {
      if (!this.up) { client.destroy(); return; }
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.sockets.add(client); this.sockets.add(upstream);
      const done = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on('error', done); upstream.on('error', done); client.on('close', done); upstream.on('close', done);
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }
  cut(): void {
    this.up = false;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
  restore(): void { this.up = true; }
  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  /** URL of a service URL rewritten to go through this relay. */
  via(url: string): string {
    const u = new URL(url);
    u.hostname = '127.0.0.1';
    u.port = String(this.port);
    return String(u);
  }
}

export async function postJson(port: number, pathname: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, headers: r.headers };
}

export async function getJson(port: number, pathname: string, token: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

/** Poll `fn` until it returns true (bounded); used only to observe asynchronous convergence. */
export async function eventually(fn: () => Promise<boolean>, timeoutMs = 15_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}
