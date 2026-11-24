/**
 * D1–D8 / C — PostgreSQL OpeningStore (contract `OpeningStore`; D2 §5, D2-G06).
 *
 * The opening of a public commitment is private and recoverable: written durably BEFORE the
 * dependent public effect is enqueued, read only with the owning tenant's key, never logged,
 * never placed in a queue payload. put() is idempotent for identical content and refuses a
 * different opening for the same operation (the first one may already back a public commitment).
 * Backup/restore: plain rows of otk_openings (pg_dump), tenant-scoped like every other table.
 *
 * @module operations/PgOpeningStore
 */
import type { CommitmentOpening, OpeningStore, OperationKey } from '../types/d1d8/index.js';
import { decodeOpening, encodeJson } from './codec.js';
import { canonicalJson, sha256Hex } from './ids.js';
import type { PgQueryable } from './schema.js';

export class OpeningConflictError extends Error {
  constructor(key: OperationKey) {
    // never include the opening itself in the message
    super(`a different opening is already stored for ${key.tenantId}/${key.operationId}`);
    this.name = 'OpeningConflictError';
  }
}

export const openingDigest = (o: CommitmentOpening): string => sha256Hex(canonicalJson(o));

export class PgOpeningStore implements OpeningStore {
  constructor(private readonly pool: PgQueryable) {}

  async put(opening: CommitmentOpening): Promise<void> {
    if (opening.schema !== 'otk.opening.v1') throw new RangeError(`unsupported opening schema ${String(opening.schema)}`);
    const digest = openingDigest(opening);
    const ins = await this.pool.query(
      `INSERT INTO otk_openings (tenant_id, operation_id, circuit_id, opening, opening_digest)
       VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [opening.key.tenantId, opening.key.operationId, opening.circuitId, encodeJson(opening), digest],
    );
    if ((ins.rowCount ?? 0) === 1) return;
    const cur = await this.pool.query<{ opening_digest: string }>(
      'SELECT opening_digest FROM otk_openings WHERE tenant_id = $1 AND operation_id = $2',
      [opening.key.tenantId, opening.key.operationId],
    );
    if (cur.rows[0]?.opening_digest !== digest) throw new OpeningConflictError(opening.key);
  }

  async get(key: OperationKey): Promise<CommitmentOpening | null> {
    const r = await this.pool.query<{ opening: unknown }>(
      'SELECT opening FROM otk_openings WHERE tenant_id = $1 AND operation_id = $2',
      [key.tenantId, key.operationId],
    );
    return r.rows[0] ? decodeOpening(r.rows[0].opening) : null;
  }
}
