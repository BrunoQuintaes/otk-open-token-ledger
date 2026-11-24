/**
 * H2.9 — Indexer Store Interface
 *
 * Storage backend for dashboard receipt indexer.
 * Future: PG materialized view with NUMERIC precision for totalCU.
 *
 * @module dashboard/IIndexerStore
 * @since Wave 2H (H2.9)
 */

export interface IndexedReceipt {
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUnits: number;
  latencyMs: number;
  timestamp: number;
  tenantId: string;
  indexedAt: number;
}

export interface TenantSummary {
  tenantId: string;
  totalReceipts: number;
  totalCU: number;
  lastActivityAt: number;
}

export interface IIndexerStore {
  index(receipt: IndexedReceipt): Promise<void>;
  getRecentReceipts(opts?: { limit?: number; offset?: number; tenantId?: string }): Promise<IndexedReceipt[]>;
  getTenantSummary(): Promise<TenantSummary[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

/** In-memory indexer store with bounded circular buffer (default). */
export class MemoryIndexerStore implements IIndexerStore {
  private _receipts: IndexedReceipt[] = [];
  private _tenantStats = new Map<string, { totalReceipts: number; totalCU: number; lastActivityAt: number }>();
  private readonly _maxSize: number;

  constructor(maxSize = 1000) {
    this._maxSize = maxSize;
  }

  async index(receipt: IndexedReceipt): Promise<void> {
    if (this._receipts.length >= this._maxSize) {
      this._receipts.shift(); // evict oldest
    }
    this._receipts.push(receipt);

    const tid = receipt.tenantId || 'unknown';
    const stats = this._tenantStats.get(tid) ?? { totalReceipts: 0, totalCU: 0, lastActivityAt: 0 };
    stats.totalReceipts++;
    stats.totalCU += receipt.costUnits;
    stats.lastActivityAt = Math.max(stats.lastActivityAt, receipt.indexedAt);
    this._tenantStats.set(tid, stats);
  }

  async getRecentReceipts(opts?: { limit?: number; offset?: number; tenantId?: string }): Promise<IndexedReceipt[]> {
    let result = this._receipts.slice().reverse(); // newest first
    if (opts?.tenantId) result = result.filter(r => r.tenantId === opts.tenantId);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return result.slice(offset, offset + limit);
  }

  async getTenantSummary(): Promise<TenantSummary[]> {
    return Array.from(this._tenantStats.entries()).map(([tenantId, stats]) => ({
      tenantId,
      ...stats,
    }));
  }

  async size(): Promise<number> {
    return this._receipts.length;
  }

  async clear(): Promise<void> {
    this._receipts = [];
    this._tenantStats.clear();
  }
}

let _store: IIndexerStore = new MemoryIndexerStore();
export function getIndexerStore(): IIndexerStore { return _store; }
export function setIndexerStore(store: IIndexerStore): void { _store = store; }
export function resetIndexerStoreForTest(): void { _store = new MemoryIndexerStore(); }
