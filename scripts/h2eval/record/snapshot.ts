/**
 * R12 pre-call snapshot: built from pre-call facts only, hashed (sha256 of canonical JSON without `snapshotSha256`), written to
 * snapshots/<operationId>.json with fsync BEFORE egress. Overwrite is refused (O_EXCL); reading recomputes the hash and refuses
 * any byte change. No content, no credential: only ids, hashes, counts, pico-USD.
 *
 * Written by `core/runner.ts`; read by `cli/status.ts` and re-exported by `scripts/h2eval/index.ts`.
 *
 * @module scripts/h2eval/record/snapshot
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync, constants } from 'node:fs';
import path from 'node:path';
import { H2EVAL_SCHEMA, type PrecallSnapshot } from '../types.js';
import { canon, sha256Hex } from '../core/canon.js';

/** Snapshot failure: `OVERWRITE_REFUSED`, `TAMPERED` (hash or identity mismatch, unreadable), `SCHEMA` or `PERSISTENCE` (I/O). */
export class SnapshotError extends Error {
  constructor(public readonly code: 'OVERWRITE_REFUSED' | 'TAMPERED' | 'SCHEMA' | 'PERSISTENCE', detail = '') { super(`snapshot: ${code}${detail ? ` ${detail}` : ''}`); this.name = 'SnapshotError'; }
}

/**
 * Hash of a snapshot without its own hash field.
 *
 * @param s - Snapshot fields except `snapshotSha256`.
 * @returns SHA-256 hex of the canonical JSON.
 */
export function hashSnapshot(s: Omit<PrecallSnapshot, 'snapshotSha256'>): string { return sha256Hex(canon(s)); }

/**
 * Returns a frozen copy of the snapshot with a fresh `snapshotSha256` (any previous value is ignored).
 *
 * @param input - Snapshot, with or without a hash.
 * @returns The sealed snapshot.
 * @throws {SnapshotError} `SCHEMA` when the schema id is not the snapshot schema.
 */
export function sealSnapshot(input: Omit<PrecallSnapshot, 'snapshotSha256'> | PrecallSnapshot): PrecallSnapshot {
  if (input.schema !== H2EVAL_SCHEMA.snapshot) throw new SnapshotError('SCHEMA');
  const { snapshotSha256: _prior, ...s } = input as PrecallSnapshot; // a prior seal never feeds the new hash
  return Object.freeze({ ...s, snapshotSha256: hashSnapshot(s) }) as PrecallSnapshot;
}

/**
 * Path of an operation's snapshot file.
 *
 * @param dir - Batch folder.
 * @param operationId - Operation id.
 * @returns `<dir>/snapshots/<operationId>.json`.
 */
export const snapshotPath = (dir: string, operationId: string) => path.join(dir, 'snapshots', `${operationId}.json`);

/**
 * Writes once. A second write for the same operationId throws OVERWRITE_REFUSED even if the content is identical.
 *
 * Creates the file exclusively and fsyncs it; the `snapshots/` folder must already exist.
 *
 * @param dir - Batch folder.
 * @param s - Sealed snapshot.
 * @returns The path written.
 * @throws {SnapshotError} `TAMPERED` when the hash does not match the content, `OVERWRITE_REFUSED` when the file
 *   exists, `PERSISTENCE` on any other I/O error.
 */
export function writeSnapshot(dir: string, s: PrecallSnapshot): string {
  const p = snapshotPath(dir, s.operationId);
  const { snapshotSha256, ...rest } = s;
  if (hashSnapshot(rest) !== snapshotSha256) throw new SnapshotError('TAMPERED', 'hash mismatch before write');
  let fd: number;
  try { fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new SnapshotError('OVERWRITE_REFUSED', s.operationId); throw new SnapshotError('PERSISTENCE', String((e as Error).message)); }
  try { writeSync(fd, JSON.stringify(s)); fsyncSync(fd); } catch (e) { throw new SnapshotError('PERSISTENCE', String((e as Error).message)); } finally { closeSync(fd); }
  return p;
}

/**
 * Reads and verifies; any edited byte (or edited hash) => TAMPERED.
 *
 * @param dir - Batch folder.
 * @param operationId - Operation id.
 * @returns The frozen snapshot.
 * @throws {SnapshotError} `TAMPERED` when the file is unreadable, its schema or id differs, or its hash does not match.
 */
export function readSnapshot(dir: string, operationId: string): PrecallSnapshot {
  let s: PrecallSnapshot;
  try { s = JSON.parse(readFileSync(snapshotPath(dir, operationId), 'utf8')) as PrecallSnapshot; } catch { throw new SnapshotError('TAMPERED', 'unreadable'); }
  if (s.schema !== H2EVAL_SCHEMA.snapshot || s.operationId !== operationId) throw new SnapshotError('TAMPERED', 'identity');
  const { snapshotSha256, ...rest } = s;
  if (hashSnapshot(rest) !== snapshotSha256) throw new SnapshotError('TAMPERED', 'hash');
  return Object.freeze(s);
}
