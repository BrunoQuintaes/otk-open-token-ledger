/**
 * H2.8 — Dead Letter Store Interface
 *
 * Storage backend for failed receipts. Current JSONL/Map implementation
 * can be swapped for PostgreSQL via this interface.
 *
 * @module api/IDeadLetterStore
 * @since Wave 2H (H2.8)
 */

export type DeadLetterStatus = 'pending' | 'retried' | 'discarded';

export interface DeadLetterEntry {
  id: string;
  originalPayload: string;
  error: string;
  reason: string;
  source: string;
  tenantId?: string;
  status: DeadLetterStatus;
  createdAt: string;
  retriedAt?: string;
  discardedAt?: string;
}

export interface IDeadLetterStore {
  add(entry: Omit<DeadLetterEntry, 'id' | 'status' | 'createdAt'>): Promise<DeadLetterEntry>;
  get(id: string): Promise<DeadLetterEntry | null>;
  /** RV-RUNS-02 (RUN-S): `tenantId` filters in the store, before limit/offset, so tenants never share a window. */
  list(opts?: { limit?: number; offset?: number; status?: DeadLetterStatus; tenantId?: string }): Promise<DeadLetterEntry[]>;
  markRetried(id: string): Promise<DeadLetterEntry | null>;
  markDiscarded(id: string): Promise<DeadLetterEntry | null>;
  count(tenantId?: string): Promise<number>;
  pendingCount(tenantId?: string): Promise<number>;
  clear(): Promise<void>;
}

/** In-memory dead-letter store (default). */
export class MemoryDeadLetterStore implements IDeadLetterStore {
  private _store = new Map<string, DeadLetterEntry>();
  private _counter = 0;

  async add(entry: Omit<DeadLetterEntry, 'id' | 'status' | 'createdAt'>): Promise<DeadLetterEntry> {
    const id = `dl-${++this._counter}-${Date.now()}`;
    const full: DeadLetterEntry = {
      ...entry,
      id,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this._store.set(id, full);
    return full;
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    return this._store.get(id) ?? null;
  }

  async list(opts?: { limit?: number; offset?: number; status?: DeadLetterStatus; tenantId?: string }): Promise<DeadLetterEntry[]> {
    let result = Array.from(this._store.values());
    if (opts?.status) result = result.filter(e => e.status === opts.status);
    if (opts?.tenantId !== undefined) result = result.filter(e => e.tenantId === opts.tenantId);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  async markRetried(id: string): Promise<DeadLetterEntry | null> {
    const entry = this._store.get(id);
    if (!entry) return null;
    entry.status = 'retried';
    entry.retriedAt = new Date().toISOString();
    return entry;
  }

  async markDiscarded(id: string): Promise<DeadLetterEntry | null> {
    const entry = this._store.get(id);
    if (!entry) return null;
    entry.status = 'discarded';
    entry.discardedAt = new Date().toISOString();
    return entry;
  }

  async count(tenantId?: string): Promise<number> {
    if (tenantId === undefined) return this._store.size;
    return Array.from(this._store.values()).filter(e => e.tenantId === tenantId).length;
  }

  async pendingCount(tenantId?: string): Promise<number> {
    return Array.from(this._store.values()).filter(e => e.status === 'pending' && (tenantId === undefined || e.tenantId === tenantId)).length;
  }

  async clear(): Promise<void> {
    this._store.clear();
    this._counter = 0;
  }
}

let _dlStore: IDeadLetterStore = new MemoryDeadLetterStore();
export function getDeadLetterStore(): IDeadLetterStore { return _dlStore; }
export function setDeadLetterStore(store: IDeadLetterStore): void { _dlStore = store; }
export function resetDeadLetterStoreForTest(): void { _dlStore = new MemoryDeadLetterStore(); }
