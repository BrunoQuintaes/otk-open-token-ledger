/**
 * Stop file (presence suffices) checked before every operation; watchdog by wall-clock as an EXTRA guard (never the money guard).
 *
 * @module scripts/h2eval/core/stop
 */
import { existsSync } from 'node:fs';
import type { StopReason } from '../types.js';

/** Returns `STOP_FILE`, `STOP_WATCHDOG` or `null` (keep going) each time it is checked. */
export interface StopChecker { check(): StopReason | null; }

/**
 * Creates a stop checker; the watchdog clock starts at creation.
 *
 * @param opts - Path of the stop file, optional watchdog limit in milliseconds (absent = no watchdog) and clock in
 *   milliseconds since the epoch.
 * @returns The checker; each check tests whether the file exists, then the elapsed time.
 */
export function createStopChecker(opts: { stopFile: string; watchdogMs?: number; now?: () => number }): StopChecker {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  return {
    check() {
      if (existsSync(opts.stopFile)) return 'STOP_FILE';
      if (opts.watchdogMs !== undefined && now() - started > opts.watchdogMs) return 'STOP_WATCHDOG';
      return null;
    },
  };
}
