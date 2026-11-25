/**
 * Dead-Letter Store — captures failed receipt processing for review/retry
 *
 * Thin async wrapper over IDeadLetterStore singleton.
 * Backend selected by storeBootstrap (Memory default, PG when configured).
 *
 * Every function here delegates to `getDeadLetterStore()` from `src/api/IDeadLetterStore.ts`, so callers do
 * not depend on which backend is installed.
 *
 * @module src/api/deadLetterStore
 * @since S1.5 (Wave 1 Pack 1), refactored Wave 3A (PACK 3A-01)
 */

import { getDeadLetterStore, type DeadLetterEntry, type DeadLetterStatus } from './IDeadLetterStore.js';

/** Reason categories for dead-letter entries (backward-compat re-export) */
export type DeadLetterReason =
  | 'validation_error'
  | 'store_error'
  | 'dispatch_error'
  | 'processing_error';

// Re-export types for callers that import from this module
export type { DeadLetterEntry, DeadLetterStatus };

/**
 * Add an item to the dead-letter store.
 *
 * @param params - The failed payload (as a string), the error message, the reason category, the component that
 *   produced it and, when known, the owning tenant.
 * @returns The stored entry, with status `pending`.
 */
export async function addDeadLetter(params: {
  originalPayload: string;
  error: string;
  reason: DeadLetterReason;
  source: string;
  tenantId?: string;
}): Promise<DeadLetterEntry> {
  return getDeadLetterStore().add(params);
}

/**
 * Get a single dead-letter entry by id.
 *
 * @param id - Entry id.
 * @returns The entry, or `null` when unknown.
 */
export async function getDeadLetter(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().get(id);
}

/**
 * List dead-letter entries, optionally filtered by status/reason/tenantId.
 *
 * @param filter - Optional `status`, `reason` and `tenantId` filters and a `limit`; without a filter every entry
 *   is returned.
 * @returns The matching entries; when `reason` is given the limit is applied after the reason filter.
 */
export async function listDeadLetters(filter?: {
  status?: DeadLetterStatus;
  reason?: DeadLetterReason;
  tenantId?: string;
  limit?: number;
}): Promise<DeadLetterEntry[]> {
  // RV-RUNS-02 (RUN-S): status and tenantId are filtered in the store; reason stays client-side
  let entries = await getDeadLetterStore().list({
    status: filter?.status,
    tenantId: filter?.tenantId || undefined,
    limit: !filter?.reason ? filter?.limit : undefined,
  });
  if (filter?.reason) entries = entries.filter(e => e.reason === filter.reason);
  if (filter?.limit && filter?.reason) {
    entries = entries.slice(0, filter.limit);
  }
  return entries;
}

/**
 * Mark a dead-letter entry as retried.
 *
 * @param id - Entry id.
 * @returns The updated entry, or `null` when unknown.
 */
export async function markRetried(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().markRetried(id);
}

/**
 * Mark a dead-letter entry as discarded.
 *
 * @param id - Entry id.
 * @returns The updated entry, or `null` when unknown.
 */
export async function markDiscarded(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().markDiscarded(id);
}

/**
 * Total count of dead-letter entries.
 *
 * @param tenantId - When given, counts only this tenant's entries.
 * @returns Number of entries.
 */
export async function deadLetterCount(tenantId?: string): Promise<number> {
  return getDeadLetterStore().count(tenantId);
}

/**
 * Count of pending (unresolved) dead-letter entries.
 *
 * @param tenantId - When given, counts only this tenant's entries.
 * @returns Number of entries with status `pending`.
 */
export async function pendingCount(tenantId?: string): Promise<number> {
  return getDeadLetterStore().pendingCount(tenantId);
}

/**
 * Clear all dead-letter entries.
 *
 * @returns Resolves once the store is empty.
 * @internal Test only
 */
export async function clearDeadLettersForTest(): Promise<void> {
  return getDeadLetterStore().clear();
}
