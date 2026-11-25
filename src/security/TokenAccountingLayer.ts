/**
 * TokenAccountingLayer — Minimal CU Ledger (ADR-0203 / TOKEN_ACCOUNTING_LAYER_SPEC_v1)
 *
 * Records CU debits and computes per-tenant, per-epoch aggregates.
 * In-memory for v1; production would persist to DB/Redis.
 *
 * Responsibilities:
 *   1. Debit: record CU spent for a (tenantId, epochId, requestId)
 *   2. Balance: return cumulative CU for (tenantId, epochId)
 *   3. Reconcile: compare on-chain submitted vs off-chain recorded
 *
 * Does NOT convert CU to USD (CU ≠ USD — CORE.md §1).
 *
 * @module security/TokenAccountingLayer
 * @since U12.POST-CLAIM-CLOSURE (TOKEN_ACCOUNTING_LAYER_SPEC_v1)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One CU debit of a metered request.
 */
export type TALEntry = {
  tenantId: string;
  epochId: string;
  requestId: string;
  provider: string;
  model: string;
  /** Cost units debited (CU, not money). */
  cu: bigint;
  ts: number;        // unix ms
  /**
   * Token counts behind this debit (R02). Billing prices tokens, not CU, so
   * they must travel with the entry. Undefined = not recorded (never read as 0).
   */
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Aggregate of the debits of one tenant and epoch.
 */
export type TALBalance = {
  tenantId: string;
  epochId: string;
  totalCU: bigint;
  entryCount: number;
};

/**
 * Comparison of the off-chain ledger with an on-chain CU total for one tenant and epoch.
 */
export type ReconcileResult = {
  tenantId: string;
  epochId: string;
  offChainCU: bigint;
  onChainCU: bigint;
  delta: bigint;
  ok: boolean;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory CU ledger; each instance has its own list of entries (lost on restart).
 */
export class TokenAccountingLayer {
  private readonly ledger: TALEntry[] = [];

  /**
   * Record a CU debit for a metered request.
   * Idempotent by requestId within (tenantId, epochId).
   *
   * @param entry - Debit to record (copied); a repeated requestId in the same tenant and epoch is ignored.
   */
  debit(entry: TALEntry): void {
    const dup = this.ledger.find(
      e => e.tenantId === entry.tenantId &&
           e.epochId === entry.epochId &&
           e.requestId === entry.requestId
    );
    if (!dup) {
      this.ledger.push({ ...entry });
    }
  }

  /**
   * Return cumulative CU balance for a (tenantId, epochId) pair.
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @returns Total CU and entry count (zero when there is none).
   */
  balance(tenantId: string, epochId: string): TALBalance {
    const entries = this.ledger.filter(
      e => e.tenantId === tenantId && e.epochId === epochId
    );
    return {
      tenantId,
      epochId,
      totalCU: entries.reduce((acc, e) => acc + e.cu, 0n),
      entryCount: entries.length,
    };
  }

  /**
   * List all entries for a tenant+epoch (for export/audit).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @returns A new array with the matching entries (the entry objects themselves are shared).
   */
  entries(tenantId: string, epochId: string): ReadonlyArray<TALEntry> {
    return this.ledger.filter(
      e => e.tenantId === tenantId && e.epochId === epochId
    );
  }

  /**
   * Reconcile off-chain ledger vs an on-chain CU total.
   * Returns delta = offChainCU - onChainCU (positive = unsubmitted receipts).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @param onChainCU - CU total submitted on-chain.
   * @returns Both totals, their difference and `ok` when they are equal.
   */
  reconcile(tenantId: string, epochId: string, onChainCU: bigint): ReconcileResult {
    const { totalCU: offChainCU } = this.balance(tenantId, epochId);
    const delta = offChainCU - onChainCU;
    return {
      tenantId,
      epochId,
      offChainCU,
      onChainCU,
      delta,
      ok: delta === 0n,
    };
  }

  /**
   * Total entries in ledger (for monitoring).
   *
   * @returns Number of entries, all tenants.
   */
  size(): number {
    return this.ledger.length;
  }
}
