/**
 * Dead-Letter Store — captures failed receipt processing for review/retry
 *
 * Thin async wrapper over IDeadLetterStore singleton.
 * Backend selected by storeBootstrap (Memory default, PG when configured).
 *
 * @module api/deadLetterStore
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

/** Get a single dead-letter entry by id. */
export async function getDeadLetter(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().get(id);
}

/** List dead-letter entries, optionally filtered by status/reason/tenantId. */
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

/** Mark a dead-letter entry as retried. */
export async function markRetried(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().markRetried(id);
}

/** Mark a dead-letter entry as discarded. */
export async function markDiscarded(id: string): Promise<DeadLetterEntry | null> {
  return getDeadLetterStore().markDiscarded(id);
}

/** Total count of dead-letter entries. */
export async function deadLetterCount(tenantId?: string): Promise<number> {
  return getDeadLetterStore().count(tenantId);
}

/** Count of pending (unresolved) dead-letter entries. */
export async function pendingCount(tenantId?: string): Promise<number> {
  return getDeadLetterStore().pendingCount(tenantId);
}

/**
 * Clear all dead-letter entries.
 * @internal Test only
 */
export async function clearDeadLettersForTest(): Promise<void> {
  return getDeadLetterStore().clear();
}
