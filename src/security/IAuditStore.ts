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

export interface AuditEntry {
  seq: number;
  hash: string;
  prevHash: string;
  record: AuditRecord;
  createdAt: string;
}

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

  async list(opts?: { limit?: number; offset?: number; action?: string }): Promise<AuditEntry[]> {
    let result = this._entries;
    if (opts?.action) result = result.filter(e => e.record.action === opts.action);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  async head(): Promise<string> {
    return this._lastHash;
  }

  async count(): Promise<number> {
    return this._entries.length;
  }

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

  async clear(): Promise<void> {
    this._entries = [];
    this._lastHash = GENESIS_HASH;
  }
}

// Singleton
let _store: IAuditStore = new MemoryAuditStore();

export function getAuditStore(): IAuditStore { return _store; }
export function setAuditStore(store: IAuditStore): void { _store = store; }
export function resetAuditStoreForTest(): void { _store = new MemoryAuditStore(); }
