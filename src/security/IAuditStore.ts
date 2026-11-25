/**
 * H2.3 — Audit Log Store Interface
 *
 * Storage backend for audit log chain entries.
 * Pure hash functions in AuditLogChain.ts remain unchanged.
 *
 * @module security/IAuditStore
 * @since Wave 2H (H2.3)
 */

import type { AuditRecord } from './AuditLogChain.js';
import { chainHash, sha256Hex } from './AuditLogChain.js';

/**
 * One stored entry of the audit chain.
 */
export interface AuditEntry {
  /** 1-based position in the chain. */
  seq: number;
  hash: string;
  /** Hash of the previous entry (the genesis hash for the first entry). */
  prevHash: string;
  record: AuditRecord;
  /** Copy of `record.ts` (ISO-8601). */
  createdAt: string;
}

/**
 * Storage backend for the audit hash chain.
 */
export interface IAuditStore {
  append(record: AuditRecord): Promise<AuditEntry>;
  list(opts?: { limit?: number; offset?: number; action?: string }): Promise<AuditEntry[]>;
  head(): Promise<string>;
  count(): Promise<number>;
  verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }>;
  clear(): Promise<void>;
}

const GENESIS_HASH = sha256Hex('audit-genesis');

/** In-memory audit store (default fallback). */
export class MemoryAuditStore implements IAuditStore {
  private _entries: AuditEntry[] = [];
  private _lastHash = GENESIS_HASH;

  /**
   * Appends a record and links it to the previous hash.
   *
   * @param record - Record to append (stored by reference).
   * @returns The new entry.
   */
  async append(record: AuditRecord): Promise<AuditEntry> {
    const hash = chainHash(this._lastHash, record);
    const entry: AuditEntry = {
      seq: this._entries.length + 1,
      hash,
      prevHash: this._lastHash,
      record,
      createdAt: record.ts,
    };
    this._entries.push(entry);
    this._lastHash = hash;
    return entry;
  }

  /**
   * Lists entries in chain order, optionally filtered by action, then paged.
   *
   * @param opts - Optional `action` filter, `offset` (default 0) and `limit` (default all).
   * @returns The matching entries (same objects as stored).
   */
  async list(opts?: { limit?: number; offset?: number; action?: string }): Promise<AuditEntry[]> {
    let result = this._entries;
    if (opts?.action) result = result.filter(e => e.record.action === opts.action);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  /**
   * Returns the hash of the last entry.
   *
   * @returns The last hash, or the genesis hash when the chain is empty.
   */
  async head(): Promise<string> {
    return this._lastHash;
  }

  /**
   * Counts the entries.
   *
   * @returns Number of entries.
   */
  async count(): Promise<number> {
    return this._entries.length;
  }

  /**
   * Recomputes every hash from the genesis hash.
   *
   * @returns `valid: true`, or `valid: false` with the 1-based `brokenAt` of the first mismatching entry.
   */
  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < this._entries.length; i++) {
      const expected = chainHash(prevHash, this._entries[i].record);
      if (expected !== this._entries[i].hash) {
        return { valid: false, brokenAt: i + 1 };
      }
      prevHash = this._entries[i].hash;
    }
    return { valid: true };
  }

  /**
   * Deletes every entry and resets the chain to the genesis hash.
   */
  async clear(): Promise<void> {
    this._entries = [];
    this._lastHash = GENESIS_HASH;
  }
}

// Singleton
let _store: IAuditStore = new MemoryAuditStore();

/**
 * Returns the process-wide audit store.
 *
 * @returns The current store (in-memory unless replaced).
 */
export function getAuditStore(): IAuditStore { return _store; }
/**
 * Replaces the process-wide audit store.
 *
 * @param store - New backend; existing entries are not copied.
 */
export function setAuditStore(store: IAuditStore): void { _store = store; }
/**
 * Restores an empty in-memory audit store (tests only).
 */
export function resetAuditStoreForTest(): void { _store = new MemoryAuditStore(); }
