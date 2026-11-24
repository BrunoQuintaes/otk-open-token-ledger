/** operationId = sha256(protocolHash:cellId:promptId:rep:modelRequested) — contract §0.4. Deterministic, idempotent. */
import { sha256Hex } from './canon.js';
import type { OperationId, OperationPlan } from '../types.js';

const HEX64 = /^[0-9a-f]{64}$/;

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

export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
