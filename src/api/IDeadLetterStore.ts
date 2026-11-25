/**
 * H2.8 — Dead Letter Store Interface
 *
 * Storage backend for failed receipts. Current JSONL/Map implementation
 * can be swapped for PostgreSQL via this interface.
 *
 * Holds the storage contract for receipts that could not be processed, the in-memory default and the
 * process-wide holder (`getDeadLetterStore` / `setDeadLetterStore`). `src/api/deadLetterStore.ts` is the
 * facade the rest of the code calls; `src/infra/storeBootstrap.ts` installs the PostgreSQL store when a
 * database is configured. It does NOT retry anything by itself: "retried" and "discarded" are status marks
 * set by callers.
 *
 * @module src/api/IDeadLetterStore
 * @since Wave 2H (H2.8)
 */

/** Lifecycle state of a dead-letter entry: waiting, re-submitted by an operator, or dropped. */
export type DeadLetterStatus = 'pending' | 'retried' | 'discarded';

/** One failed receipt kept for inspection and manual retry. */
export interface DeadLetterEntry {
  /** Store-assigned id (`dl-<counter>-<epoch ms>` in the in-memory store). */
  id: string;
  /** The original payload as a string, exactly as received. */
  originalPayload: string;
  /** Error message that caused the failure. */
  error: string;
  /** Short machine-readable reason for the failure. */
  reason: string;
  /** Component that produced the entry. */
  source: string;
  /** Owning tenant; absent when the failure could not be attributed to a tenant. */
  tenantId?: string;
  status: DeadLetterStatus;
  /** ISO-8601 creation timestamp (UTC). */
  createdAt: string;
  /** ISO-8601 timestamp of the `retried` mark; absent until then. */
  retriedAt?: string;
  /** ISO-8601 timestamp of the `discarded` mark; absent until then. */
  discardedAt?: string;
}

/** Storage contract for dead-letter entries (in-memory or PostgreSQL). */
export interface IDeadLetterStore {
  /** Stores a new entry with status `pending` and returns it with its id and `createdAt`. */
  add(entry: Omit<DeadLetterEntry, 'id' | 'status' | 'createdAt'>): Promise<DeadLetterEntry>;
  /** Returns the entry, or `null` when unknown. */
  get(id: string): Promise<DeadLetterEntry | null>;
  /** RV-RUNS-02 (RUN-S): `tenantId` filters in the store, before limit/offset, so tenants never share a window. */
  list(opts?: { limit?: number; offset?: number; status?: DeadLetterStatus; tenantId?: string }): Promise<DeadLetterEntry[]>;
  /** Sets status `retried` and `retriedAt`; returns the entry or `null` when unknown. */
  markRetried(id: string): Promise<DeadLetterEntry | null>;
  /** Sets status `discarded` and `discardedAt`; returns the entry or `null` when unknown. */
  markDiscarded(id: string): Promise<DeadLetterEntry | null>;
  /** Counts entries, optionally only those of one tenant. */
  count(tenantId?: string): Promise<number>;
  /** Counts `pending` entries, optionally only those of one tenant. */
  pendingCount(tenantId?: string): Promise<number>;
  /** Removes every entry (tests and resets). */
  clear(): Promise<void>;
}

/** In-memory dead-letter store (default). */
/** In-memory dead-letter store (default). Lost on restart; entries are mutated in place by the mark methods. */
export class MemoryDeadLetterStore implements IDeadLetterStore {
  private _store = new Map<string, DeadLetterEntry>();
  private _counter = 0;

  /**
   * Stores a new pending entry.
   *
   * @param entry - Entry fields without `id`, `status` and `createdAt` (those are assigned here).
   * @returns The stored entry.
   */
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

  /**
   * Looks up one entry.
   *
   * @param id - Entry id.
   * @returns The entry (the stored object, not a copy), or `null` when unknown.
   */
  async get(id: string): Promise<DeadLetterEntry | null> {
    return this._store.get(id) ?? null;
  }

  /**
   * Lists entries in insertion order, filtered before paging.
   *
   * @param opts - Optional `status` and `tenantId` filters, `offset` (default 0) and `limit` (default: all).
   * @returns The matching entries in the requested window.
   */
  async list(opts?: { limit?: number; offset?: number; status?: DeadLetterStatus; tenantId?: string }): Promise<DeadLetterEntry[]> {
    let result = Array.from(this._store.values());
    if (opts?.status) result = result.filter(e => e.status === opts.status);
    if (opts?.tenantId !== undefined) result = result.filter(e => e.tenantId === opts.tenantId);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  /**
   * Marks an entry as retried now.
   *
   * @param id - Entry id.
   * @returns The updated entry, or `null` when unknown.
   */
  async markRetried(id: string): Promise<DeadLetterEntry | null> {
    const entry = this._store.get(id);
    if (!entry) return null;
    entry.status = 'retried';
    entry.retriedAt = new Date().toISOString();
    return entry;
  }

  /**
   * Marks an entry as discarded now.
   *
   * @param id - Entry id.
   * @returns The updated entry, or `null` when unknown.
   */
  async markDiscarded(id: string): Promise<DeadLetterEntry | null> {
    const entry = this._store.get(id);
    if (!entry) return null;
    entry.status = 'discarded';
    entry.discardedAt = new Date().toISOString();
    return entry;
  }

  /**
   * Counts entries.
   *
   * @param tenantId - When given, counts only this tenant's entries.
   * @returns Number of entries.
   */
  async count(tenantId?: string): Promise<number> {
    if (tenantId === undefined) return this._store.size;
    return Array.from(this._store.values()).filter(e => e.tenantId === tenantId).length;
  }

  /**
   * Counts pending entries.
   *
   * @param tenantId - When given, counts only this tenant's entries.
   * @returns Number of entries with status `pending`.
   */
  async pendingCount(tenantId?: string): Promise<number> {
    return Array.from(this._store.values()).filter(e => e.status === 'pending' && (tenantId === undefined || e.tenantId === tenantId)).length;
  }

  /** Removes every entry and resets the id counter. */
  async clear(): Promise<void> {
    this._store.clear();
    this._counter = 0;
  }
}

let _dlStore: IDeadLetterStore = new MemoryDeadLetterStore();
/**
 * Returns the process-wide dead-letter store.
 *
 * @returns The current store (in-memory unless `setDeadLetterStore` replaced it).
 */
export function getDeadLetterStore(): IDeadLetterStore { return _dlStore; }
/**
 * Replaces the process-wide dead-letter store (store bootstrap and tests).
 *
 * @param store - The store every later `getDeadLetterStore` call returns.
 */
export function setDeadLetterStore(store: IDeadLetterStore): void { _dlStore = store; }
/** Resets the process-wide store to a fresh in-memory one (tests only). */
export function resetDeadLetterStoreForTest(): void { _dlStore = new MemoryDeadLetterStore(); }
