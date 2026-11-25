/**
 * IReceiptStore — Contract for receipt storage backends (ADR-0205)
 *
 * Defines the interface that any receipt store implementation must fulfill.
 * Current implementation: module-level functions in receiptStore.ts (in-memory + JSONL).
 * Future implementation: class-based adapters (PostgreSQL, Redis) fulfilling this contract.
 *
 * The only implementation today is the set of module-level functions in `src/api/receiptStore.ts`, whose
 * conformance is checked at compile time at the end of that file. This file has no runtime code.
 *
 * @module src/api/IReceiptStore
 * @since u12.p3.p (ADR-0205)
 */

import type { RawReceipt } from '../types/receipt.js';
import type { BatchResult } from '../batch/BatchAggregator.js';

/**
 * Core receipt store operations.
 *
 * All implementations must be idempotent on `storeReceipt` (same requestId
 * can be stored multiple times; only the latest value is kept).
 */
export interface IReceiptStore {
  /**
   * Store a receipt. Idempotent by requestId.
   * Returns { stored: true } on first store, { stored: false } on duplicate.
   * Duplicate: no side effects (no TAL debit, no JSONL append, no ProverDaemon dispatch).
   * The resolved tenant is persisted on the stored receipt; a tenantId argument that
   * conflicts with receipt.tenantId is rejected with reason 'tenant_mismatch' (R12).
   * If the synchronous durable write fails, nothing is stored: 'persistence_failed' (R13).
   */
  storeReceipt(
    receipt: RawReceipt,
    tenantId?: string,
  ): { stored: boolean; reason?: 'duplicate' | 'tenant_mismatch' | 'persistence_failed' };

  /** Retrieve a receipt by requestId. Returns undefined if not found. */
  getReceipt(requestId: string): RawReceipt | undefined;

  /** Return current receipt count. */
  size(): number;

  /**
   * Flush all receipts into a Merkle batch.
   * Returns null if store is empty.
   * Clears the store after batch creation.
   */
  flushBatch(opts?: { tenantId?: string }): BatchResult | null;

  /**
   * Flush and discard all receipts (no batch).
   * Returns count before flush.
   */
  flushAll(): number;

  /** Current AuditLogChain head hash (64-char hex). */
  chainHead(): string;

  /** Total audit entries appended (does not reset on flush). */
  auditCount(): number;
}

/**
 * Extended interface for implementations that expose circuit breaker status.
 * Optional — only the ProverDaemon-aware implementation supports this.
 */
export interface IReceiptStoreWithProver extends IReceiptStore {
  circuitBreakerStatus(): { open: boolean; consecutiveFails: number; pendingProofs?: number };
}
