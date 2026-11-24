/**
 * ProverDaemonManager — Supervised lifecycle for ProverDaemon process (E5.2)
 *
 * Spawns ProverDaemon as a child process and auto-restarts on non-zero exit.
 * Exposes status for GET /admin/prover/status.
 *
 * Restart policy:
 *   - On exit code ≠ 0: wait PROVER_RESTART_DELAY_MS (default 2000), then restart
 *   - Max restarts: PROVER_MAX_RESTARTS (default 5) before giving up (FATAL)
 *   - Exit code 0: clean shutdown, no restart
 *
 * Env vars:
 *   OTK_PROVER_SCRIPT  — path to daemon script (default: src/prover/ProverDaemon.ts)
 *   PROVER_RESTART_DELAY_MS — ms to wait between restarts (default 2000)
 *   PROVER_MAX_RESTARTS — max automatic restarts (default 5)
 *
 * @module prover/ProverDaemonManager
 * @since Wave 4 (4B-PACK-4B02 / E5.2)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface ProverDaemonStatus {
  /** Child process PID, or null if not running */
  pid: number | null;
  /** Total restarts since start() */
  restartCount: number;
  /** Timestamp (ms) of last completed proof job, or null */
  lastProofAt: number | null;
  /** True if daemon is currently running */
  healthy: boolean;
  /** Whether max restarts has been reached (daemon gave up) */
  exhausted: boolean;
}

/**
 * OPS-01 — ProverMetrics
 * Prometheus-compatible in-memory metrics for the prover subsystem.
 */
export interface ProverMetrics {
  activeProvers: number;
  queueDepth: number;
  exhaustionEvents: number;
  lastExhaustionAt: string | null;
}

// ──────────────────────────────────────────────────────────
// ProverDaemonManager
// ──────────────────────────────────────────────────────────

// OPS-01: Module-level exhaustion counter (survives manager recreation in tests)
let _exhaustionEvents = 0;
let _lastExhaustionAt: string | null = null;

export class ProverDaemonManager {
  private _proc: ChildProcess | null = null;
  private _restartCount = 0;
  private _lastProofAt: number | null = null;
  private _exhausted = false;
  private _stopping = false;

  private readonly _scriptPath: string;
  private readonly _restartDelayMs: number;
  private readonly _maxRestarts: number;

  constructor(opts?: {
    scriptPath?: string;
    restartDelayMs?: number;
    maxRestarts?: number;
  }) {
    this._scriptPath = opts?.scriptPath
      ?? process.env['OTK_PROVER_SCRIPT']
      ?? path.join(ROOT, 'src/prover/ProverDaemon.ts');
    this._restartDelayMs = opts?.restartDelayMs
      ?? Number(process.env['PROVER_RESTART_DELAY_MS'] ?? 2000);
    this._maxRestarts = opts?.maxRestarts
      ?? Number(process.env['PROVER_MAX_RESTARTS'] ?? 5);
  }

  /** Start the daemon process. Idempotent — no-op if already running. */
  start(): void {
    if (this._proc || this._exhausted) return;
    this._spawn();
  }

  /** Stop the daemon (SIGTERM). Sets _stopping to prevent auto-restart. */
  stop(): void {
    this._stopping = true;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch { /* already exited */ }
      this._proc = null;
    }
  }

  /** Stop then start the daemon. Resets _stopping flag. */
  restart(): void {
    this._stopping = false;
    this._exhausted = false;
    this.stop();
    this._stopping = false;
    this._spawn();
  }

  /** Record a completed proof (called externally or via IPC). */
  recordProof(): void {
    this._lastProofAt = Date.now();
  }

  get status(): ProverDaemonStatus {
    return {
      pid: this._proc?.pid ?? null,
      restartCount: this._restartCount,
      lastProofAt: this._lastProofAt,
      healthy: this._proc !== null && !this._exhausted,
      exhausted: this._exhausted,
    };
  }

  /**
   * OPS-01 — Prometheus-compatible metrics for the prover subsystem.
   * queueDepth is always 0 in the daemon manager (queue managed separately by ProductionQueue).
   */
  getProverMetrics(): ProverMetrics {
    return {
      activeProvers: this._proc !== null && !this._exhausted ? 1 : 0,
      queueDepth: 0, // queue depth tracked by ProductionQueue (BullMQ)
      exhaustionEvents: _exhaustionEvents,
      lastExhaustionAt: _lastExhaustionAt,
    };
  }

  // ──────────────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────────────

  private _spawn(): void {
    const args = this._scriptPath.endsWith('.ts')
      ? ['tsx', this._scriptPath]
      : ['node', this._scriptPath];

    const cmd = args[0];
    const rest = args.slice(1);

    // SEC-09: Filter spawn env — only pass OTK_* config, PATH, NODE_ENV, HOME
    // Prevents leaking parent-process secrets (API keys, tokens, credentials) to child prover.
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && (k.startsWith('OTK_') || k === 'PATH' || k === 'NODE_ENV' || k === 'HOME' || k === 'PROVER_PORT')) {
        spawnEnv[k] = v;
      }
    }
    const proc = spawn(cmd, rest, {
      stdio: 'inherit',
      env: spawnEnv,
    });

    this._proc = proc;

    proc.on('error', (err) => {
      console.error(`[ProverDaemonManager] spawn error: ${err.message}`);
      this._proc = null;
      this._scheduleRestart();
    });

    proc.on('exit', (code) => {
      this._proc = null;
      if (this._stopping) return; // clean shutdown
      if (code === 0) return;     // intentional exit
      this._scheduleRestart();
    });
  }

  private _scheduleRestart(): void {
    if (this._stopping) return;
    if (this._restartCount >= this._maxRestarts) {
      this._exhausted = true;
      _exhaustionEvents++;
      _lastExhaustionAt = new Date().toISOString();
      console.error(
        `[ProverDaemonManager] FATAL: max restarts (${this._maxRestarts}) reached — daemon will not restart`,
      );
      return;
    }
    this._restartCount++;
    console.warn(
      `[ProverDaemonManager] restarting daemon (attempt ${this._restartCount}/${this._maxRestarts}) in ${this._restartDelayMs}ms`,
    );
    setTimeout(() => {
      if (!this._stopping) this._spawn();
    }, this._restartDelayMs);
  }
}

// ──────────────────────────────────────────────────────────
// Singleton (module-level)
// ──────────────────────────────────────────────────────────

let _manager: ProverDaemonManager | null = null;

export function getProverDaemonManager(): ProverDaemonManager {
  if (!_manager) _manager = new ProverDaemonManager();
  return _manager;
}
