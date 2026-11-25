/**
 * operationId = sha256(protocolHash:cellId:promptId:rep:modelRequested) — contract §0.4. Deterministic, idempotent.
 *
 * The same plan fields always give the same id, so a restarted run recognizes operations it already journaled.
 *
 * @module scripts/h2eval/core/ids
 */
import { sha256Hex } from './canon.js';
import type { OperationId, OperationPlan } from '../types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Derives the operation id of a plan, or returns the plan's own `opId` when present.
 *
 * @param p - The identity fields of an operation plan, optionally with a precomputed `opId`.
 * @returns 64 lowercase hex characters.
 * @throws {TypeError} When `opId` or `protocolHash` is not 64 lowercase hex, an id field is empty or contains `:`,
 *   or `rep` is not a non-negative integer.
 */
export function operationIdOf(p: Pick<OperationPlan, 'protocolHash' | 'cellId' | 'promptId' | 'rep' | 'modelRequested'> & { opId?: OperationId }): OperationId {
  // EXEC-ECON C160 (delta v3.1 item 4): the study plan's opId is the operationId (validated hex64; never derived when present)
  if (p.opId !== undefined) { if (!HEX64.test(p.opId)) throw new TypeError('operationIdOf: opId must be hex64'); return p.opId; }
  if (!HEX64.test(p.protocolHash)) throw new TypeError('operationIdOf: protocolHash must be hex64');
  for (const [k, v] of [['cellId', p.cellId], ['promptId', p.promptId], ['modelRequested', p.modelRequested]] as const) {
    if (typeof v !== 'string' || v === '' || v.includes(':')) throw new TypeError(`operationIdOf: ${k} must be a non-empty string without ':'`);
  }
  if (!Number.isInteger(p.rep) || p.rep < 0) throw new TypeError('operationIdOf: rep must be a non-negative integer');
  return sha256Hex(`${p.protocolHash}:${p.cellId}:${p.promptId}:${p.rep}:${p.modelRequested}`);
}

/**
 * Tells whether a value is a 64-character lowercase hex string.
 *
 * @param s - Any value.
 * @returns `true` for a lowercase hex64 string.
 */
export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
