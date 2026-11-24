/**
 * cwRuntime — CW JSON Operational Loader Singleton (ADR-0203 Phase 1)
 *
 * Loads CW JSON at startup from OTK_CW_JSON_FILE or OTK_CW_JSON_URL (in that order).
 * Validates structure + temporal validity. Verifies EIP-191 signature against
 * OTK_TRUSTED_SIGNERS whitelist. Falls back to null (static weights) on any failure.
 *
 * Usage:
 *   import { getCWJson } from '../economics/cwRuntime.js';
 *   const cw = getCWJson(); // null if not loaded or invalid
 *
 * Env vars:
 *   OTK_CW_JSON_FILE  — path to local CW JSON file (takes priority over URL)
 *   OTK_CW_JSON_URL   — URL to fetch CW JSON from (http/https)
 *   OTK_TRUSTED_SIGNERS — comma-separated trusted Ethereum addresses
 *
 * @module economics/cwRuntime
 * @since u12.closure.c (GAP-C-003)
 */

import { readFileSync } from 'node:fs';
import { loadCWJson, verifyCWSignature, type CWJson } from './CUWeightsLoader.js';
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

let _cw: CWJson | null = null;
let _loaded = false;

/** Load CW JSON from file. Returns parsed object or null on failure. */
function _loadFromFile(filePath: string): unknown | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[cwRuntime] Failed to load CW JSON from file ${filePath}: ${e}\n`);
    return null;
  }
}

/** Load CW JSON from URL synchronously using fetch + top-level await workaround.
 *  Returns parsed object or null on failure. */
async function _loadFromUrl(url: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    process.stderr.write(`[cwRuntime] Failed to fetch CW JSON from ${url}: ${e}\n`);
    return null;
  }
}

/**
 * Initialize the CW JSON runtime. Called once at startup.
 * Exported for testing and explicit initialization.
 */
export async function initCWRuntime(): Promise<void> {
  if (_loaded) return;
  _loaded = true;

  const filePath = process.env['OTK_CW_JSON_FILE'] ?? '';
  const url = process.env['OTK_CW_JSON_URL'] ?? '';

  let raw: unknown | null = null;

  if (filePath) {
    raw = _loadFromFile(filePath);
  } else if (url) {
    raw = await _loadFromUrl(url);
  }

  if (!raw) return; // no source configured or load failed

  const cw = loadCWJson(raw);
  if (!cw) {
    process.stderr.write('[cwRuntime] CW JSON validation failed — using static weights\n');
    return;
  }

  // Verify signature (async)
  const valid = await verifyCWSignature(cw);
  if (!valid) {
    process.stderr.write('[cwRuntime] CW JSON signature verification failed — using static weights\n');
    return;
  }

  _cw = cw;
  process.stderr.write(`[cwRuntime] CW JSON loaded successfully (version=${cw.version})\n`);
}

/**
 * Get the currently loaded CW JSON, or null if not loaded / invalid.
 * CUEngine callers should use this as the override source for weights.
 */
export function getCWJson(): CWJson | null {
  return _cw;
}

/** Reset the runtime (for testing). */
export function resetCWRuntime(): void {
  if (isDeployedEnv()) {
    throw new Error('[cwRuntime] resetCWRuntime() not permitted in production');
  }
  _cw = null;
  _loaded = false;
}
