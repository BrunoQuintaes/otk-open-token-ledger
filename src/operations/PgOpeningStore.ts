/**
 * D1–D8 / C — PostgreSQL OpeningStore (contract `OpeningStore`; D2 §5, D2-G06).
 *
 * The opening of a public commitment is private and recoverable: written durably BEFORE the
 * dependent public effect is enqueued, read only with the owning tenant's key, never logged,
 * never placed in a queue payload. put() is idempotent for identical content and refuses a
 * different opening for the same operation (the first one may already back a public commitment).
 * Backup/restore: plain rows of otk_openings (pg_dump), tenant-scoped like every other table.
 *
 * The opening is stored as plain JSON in the database (not encrypted by this module); database
 * access control is what keeps it private.
 *
 * @module src/operations/PgOpeningStore
 */
import type { CommitmentOpening, OpeningStore, OperationKey } from '../types/d1d8/index.js';
import { decodeOpening, encodeJson } from './codec.js';
import { canonicalJson, sha256Hex } from './ids.js';
import type { PgQueryable } from './schema.js';

/** Thrown when a different opening is already stored for the same operation. */
export class OpeningConflictError extends Error {
  /**
   * Builds the error; the message names the operation, never the opening.
   *
   * @param key - The operation whose stored opening differs.
   */
  constructor(key: OperationKey) {
    // never include the opening itself in the message
    super(`a different opening is already stored for ${key.tenantId}/${key.operationId}`);
    this.name = 'OpeningConflictError';
  }
}

/**
 * SHA-256 hex of the opening's canonical JSON; used to compare two openings without reading them back.
 *
 * @param o - The opening.
 * @returns 64-character lower-case hex digest.
 */
export const openingDigest = (o: CommitmentOpening): string => sha256Hex(canonicalJson(o));

/** PostgreSQL implementation of the `OpeningStore` contract over table `otk_openings`. */
export class PgOpeningStore implements OpeningStore {
  /**
   * Binds the store to a database connection.
   *
   * @param pool - PostgreSQL pool (or client).
   */
  constructor(private readonly pool: PgQueryable) {}

  /**
   * Stores the opening once per operation; storing the identical opening again is a no-op.
   *
   * @param opening - The opening to store (schema `otk.opening.v1`).
   * @throws {RangeError} When the schema is not `otk.opening.v1`.
   * @throws {@link OpeningConflictError} When a different opening exists for the same operation.
   */
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

  /**
   * Reads the opening of one operation (tenant-scoped by the key).
   *
   * @param key - Tenant and operation id.
   * @returns The decoded opening, or `null` when none is stored.
   * @throws {Error} When the stored JSON does not decode as an opening (see `decodeOpening` in `codec.ts`).
   */
  async get(key: OperationKey): Promise<CommitmentOpening | null> {
    const r = await this.pool.query<{ opening: unknown }>(
      'SELECT opening FROM otk_openings WHERE tenant_id = $1 AND operation_id = $2',
      [key.tenantId, key.operationId],
    );
    return r.rows[0] ? decodeOpening(r.rows[0].opening) : null;
  }
}
