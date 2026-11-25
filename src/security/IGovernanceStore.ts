/**
 * H2.6 — Governance Store Interface
 *
 * Storage backend for GovernanceTrail entries.
 * GovernanceTrail class delegates to this store instead of internal array.
 *
 * @module security/IGovernanceStore
 * @since Wave 2H (H2.6)
 */

import { sha256Hex, chainHash } from './AuditLogChain.js';
import type { GovernanceEvent, GovernanceEntry } from './GovernanceTrail.js';

/**
 * Storage backend for governance trail entries (shared across instances when not in memory).
 */
export interface IGovernanceStore {
  append(event: GovernanceEvent, prevHash: string): Promise<GovernanceEntry>;
  list(opts?: { limit?: number; offset?: number }): Promise<GovernanceEntry[]>;
  head(): Promise<string>;
  count(): Promise<number>;
  verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }>;
  clear(): Promise<void>;
}

const GENESIS_HASH = sha256Hex('governance-genesis');

/** In-memory governance store. */
export class MemoryGovernanceStore implements IGovernanceStore {
  private _entries: GovernanceEntry[] = [];
  private _lastHash = GENESIS_HASH;

  /**
   * Appends an event, chaining it to this store's own last hash.
   *
   * @param event - Event to append.
   * @param _prevHash - Ignored by this implementation (it uses its own last hash).
   * @returns The new entry; `seq` is 1-based here.
   */
  async append(event: GovernanceEvent, _prevHash?: string): Promise<GovernanceEntry> {
    const record = { ts: event.ts, tenantId: event.tenantId, actor: event.actor, action: event.action, meta: event.meta };
    const hash = chainHash(this._lastHash, record);
    const entry: GovernanceEntry = { ...event, seq: this._entries.length + 1, hash };
    this._entries.push(entry);
    this._lastHash = hash;
    return entry;
  }

  /**
   * Lists entries in chain order, paged.
   *
   * @param opts - Optional `offset` (default 0) and `limit` (default all).
   * @returns The entries (same objects as stored).
   */
  async list(opts?: { limit?: number; offset?: number }): Promise<GovernanceEntry[]> {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? this._entries.length;
    return this._entries.slice(offset, offset + limit);
  }

  /**
   * Returns the hash of the last entry.
   *
   * @returns The last hash, or the genesis hash when empty.
   */
  async head(): Promise<string> { return this._lastHash; }
  /**
   * Counts the entries.
   *
   * @returns Number of entries.
   */
  async count(): Promise<number> { return this._entries.length; }

  /**
   * Recomputes every hash from the genesis hash.
   *
   * @returns `valid: true`, or `valid: false` with the 1-based `brokenAt` of the first mismatch.
   */
  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    let prev = GENESIS_HASH;
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];
      const expected = chainHash(prev, { ts: e.ts, tenantId: e.tenantId, actor: e.actor, action: e.action, meta: e.meta });
      if (expected !== e.hash) return { valid: false, brokenAt: i + 1 };
      prev = e.hash;
    }
    return { valid: true };
  }

  /**
   * Deletes every entry and resets the chain.
   */
  async clear(): Promise<void> {
    this._entries = [];
    this._lastHash = GENESIS_HASH;
  }
}

let _store: IGovernanceStore = new MemoryGovernanceStore();
/**
 * Returns the process-wide governance store.
 *
 * @returns The current store (in-memory unless replaced).
 */
export function getGovernanceStore(): IGovernanceStore { return _store; }
/**
 * Replaces the process-wide governance store.
 *
 * @param store - New backend; existing entries are not copied.
 */
export function setGovernanceStore(store: IGovernanceStore): void { _store = store; }
/**
 * Restores an empty in-memory governance store (tests only).
 */
export function resetGovernanceStoreForTest(): void { _store = new MemoryGovernanceStore(); }
