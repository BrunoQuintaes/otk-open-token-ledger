/**
 * RB-059 — Audit Log (append-only hash chain)
 *
 * Pure hash chaining for tamper-evident logs.
 * hash_i = H(hash_{i-1} || canonical(record_i))
 *
 * @module security/AuditLogChain
 * @since RB-059
 */

import { createHash } from 'node:crypto';

export type AuditRecord = {
  ts: string;           // ISO
  tenantId: string;
  actor: string;        // userId/service
  action: string;       // e.g., "metered", "policy_denied"
  meta?: Record<string, unknown>;
};

export function canonicalize(r: AuditRecord): string {
  // stable JSON (keys sorted) for deterministic hashing
  const meta = r.meta ? sortObj(r.meta) : undefined;
  return JSON.stringify({ ts: r.ts, tenantId: r.tenantId, actor: r.actor, action: r.action, ...(meta ? { meta } : {}) });
}

function sortObj(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortObj);
  if (x && typeof x === 'object') {
    return Object.keys(x as object).sort().reduce((o: Record<string, unknown>, k) => {
      o[k] = sortObj((x as Record<string, unknown>)[k]);
      return o;
    }, {});
  }
  return x;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function chainHash(prevHashHex: string, record: AuditRecord): string {
  return sha256Hex(prevHashHex + '|' + canonicalize(record));
}
