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

  async append(event: GovernanceEvent, _prevHash?: string): Promise<GovernanceEntry> {
    const record = { ts: event.ts, tenantId: event.tenantId, actor: event.actor, action: event.action, meta: event.meta };
    const hash = chainHash(this._lastHash, record);
    const entry: GovernanceEntry = { ...event, seq: this._entries.length + 1, hash };
    this._entries.push(entry);
    this._lastHash = hash;
    return entry;
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<GovernanceEntry[]> {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? this._entries.length;
    return this._entries.slice(offset, offset + limit);
  }

  async head(): Promise<string> { return this._lastHash; }
  async count(): Promise<number> { return this._entries.length; }

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

  async clear(): Promise<void> {
    this._entries = [];
    this._lastHash = GENESIS_HASH;
  }
}

let _store: IGovernanceStore = new MemoryGovernanceStore();
export function getGovernanceStore(): IGovernanceStore { return _store; }
export function setGovernanceStore(store: IGovernanceStore): void { _store = store; }
export function resetGovernanceStoreForTest(): void { _store = new MemoryGovernanceStore(); }
