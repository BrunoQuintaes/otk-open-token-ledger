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

/**
 * One audit event as hashed into the chain.
 */
export type AuditRecord = {
  ts: string;           // ISO
  tenantId: string;
  actor: string;        // userId/service
  action: string;       // e.g., "metered", "policy_denied"
  meta?: Record<string, unknown>;
};

/**
 * Serializes an audit record deterministically: fixed top-level order, `meta` keys sorted at every depth.
 *
 * @param r - Record to serialize (not modified).
 * @returns JSON text; `meta` is omitted when absent.
 */
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

/**
 * SHA-256 of a string (UTF-8).
 *
 * @param s - Text to hash.
 * @returns Lowercase hex digest (64 characters).
 */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Next hash of the chain: SHA-256 of the previous hash, `|`, and the canonical record.
 *
 * @param prevHashHex - Previous chain hash (hex).
 * @param record - Record to append.
 * @returns The new chain hash (hex).
 */
export function chainHash(prevHashHex: string, record: AuditRecord): string {
  return sha256Hex(prevHashHex + '|' + canonicalize(record));
}
