/**
 * H2.9 — Indexer Store Interface
 *
 * Storage backend for dashboard receipt indexer.
 * Future: PG materialized view with NUMERIC precision for totalCU.
 *
 * `src/dashboard/indexer.ts` writes every indexed receipt here as well (fire and forget). The default backend is
 * the in-memory `MemoryIndexerStore`; `setIndexerStore()` swaps it (a PostgreSQL version lives in
 * `src/infra/pg/PgIndexerStore.ts`). It does NOT hold receipt bodies or proofs, only the summary fields below.
 *
 * @module src/dashboard/IIndexerStore
 * @since Wave 2H (H2.9)
 */

/** Summary of one receipt as shown by the dashboard. */
export interface IndexedReceipt {
  requestId: string;
  provider: string;
  model: string;
  /** Input tokens reported for the request. */
  inputTokens: number;
  /** Output tokens reported for the request. */
  outputTokens: number;
  /** Compute units (CU) charged for the request. */
  costUnits: number;
  /** Upstream latency in milliseconds. */
  latencyMs: number;
  /** Receipt time in Unix seconds (copied from the receipt). */
  timestamp: number;
  tenantId: string;
  /** When the dashboard indexed it, in epoch milliseconds. */
  indexedAt: number;
}

/** Running totals of one tenant in the indexer. */
export interface TenantSummary {
  tenantId: string;
  /** Receipts indexed for the tenant (not reduced when old receipts are evicted). */
  totalReceipts: number;
  /** Sum of `costUnits` of those receipts. */
  totalCU: number;
  /** Largest `indexedAt` seen, epoch milliseconds. */
  lastActivityAt: number;
}

/** Storage contract of the dashboard receipt index. */
export interface IIndexerStore {
  /**
   * Adds one receipt and updates the tenant totals.
   *
   * @param receipt - Receipt summary to store.
   */
  index(receipt: IndexedReceipt): Promise<void>;
  /**
   * Lists receipts, newest first.
   *
   * @param opts - `limit` (default 50), `offset` (default 0) and an optional tenant filter.
   * @returns The selected page of receipts.
   */
  getRecentReceipts(opts?: { limit?: number; offset?: number; tenantId?: string }): Promise<IndexedReceipt[]>;
  /**
   * Returns the running totals of every tenant seen.
   *
   * @returns One summary per tenant.
   */
  getTenantSummary(): Promise<TenantSummary[]>;
  /**
   * Counts the receipts currently held.
   *
   * @returns Number of receipts.
   */
  size(): Promise<number>;
  /** Removes every receipt and tenant total. */
  clear(): Promise<void>;
}

/**
 * In-memory indexer store with bounded circular buffer (default).
 *
 * When full, the oldest receipt is dropped; tenant totals keep counting it. A receipt with an empty `tenantId`
 * is counted under `'unknown'`.
 */
export class MemoryIndexerStore implements IIndexerStore {
  private _receipts: IndexedReceipt[] = [];
  private _tenantStats = new Map<string, { totalReceipts: number; totalCU: number; lastActivityAt: number }>();
  private readonly _maxSize: number;

  /**
   * Creates an empty store.
   *
   * @param maxSize - Maximum receipts kept (default 1000).
   */
  constructor(maxSize = 1000) {
    this._maxSize = maxSize;
  }

  /**
   * See {@link IIndexerStore.index}.
   *
   * @param receipt - Receipt summary to store (kept by reference).
   */
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

  /**
   * See {@link IIndexerStore.getRecentReceipts}.
   *
   * @param opts - `limit` (default 50), `offset` (default 0) and an optional tenant filter.
   * @returns The selected page, newest first.
   */
  async getRecentReceipts(opts?: { limit?: number; offset?: number; tenantId?: string }): Promise<IndexedReceipt[]> {
    let result = this._receipts.slice().reverse(); // newest first
    if (opts?.tenantId) result = result.filter(r => r.tenantId === opts.tenantId);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return result.slice(offset, offset + limit);
  }

  /**
   * See {@link IIndexerStore.getTenantSummary}.
   *
   * @returns One summary per tenant.
   */
  async getTenantSummary(): Promise<TenantSummary[]> {
    return Array.from(this._tenantStats.entries()).map(([tenantId, stats]) => ({
      tenantId,
      ...stats,
    }));
  }

  /**
   * See {@link IIndexerStore.size}.
   *
   * @returns Number of receipts held (at most `maxSize`).
   */
  async size(): Promise<number> {
    return this._receipts.length;
  }

  /** See {@link IIndexerStore.clear}. */
  async clear(): Promise<void> {
    this._receipts = [];
    this._tenantStats.clear();
  }
}

let _store: IIndexerStore = new MemoryIndexerStore();
/**
 * Returns the active indexer store.
 *
 * @returns The current backend (in-memory by default).
 */
export function getIndexerStore(): IIndexerStore { return _store; }
/**
 * Replaces the active indexer store.
 *
 * @param store - New backend; receipts in the old one are not copied.
 */
export function setIndexerStore(store: IIndexerStore): void { _store = store; }
/** Restores a fresh in-memory store (tests). */
export function resetIndexerStoreForTest(): void { _store = new MemoryIndexerStore(); }
