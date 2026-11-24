/** Stop file (presence suffices) checked before every operation; watchdog by wall-clock as an EXTRA guard (never the money guard). */
import { existsSync } from 'node:fs';
import type { StopReason } from '../types.js';

export interface StopChecker { check(): StopReason | null; }

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
