/**
 * PAY-01 — ProviderPaymentRouter
 * Tracks end-of-cycle provider payouts (what OTK owes to AI providers).
 *
 * When OTK collects money from tenants it owes the actual provider cost
 * back to the AI provider (OpenAI, Anthropic, etc.).  This module
 * accumulates those amounts and allows marking them paid.
 *
 * In-memory only (lost on restart); it moves no money and calls no provider: "paid" is a status set by the
 * caller. Read by the billing payout endpoint in `src/api/routes.ts` through `getPaymentRouter()`.
 *
 * @module src/billing/ProviderPaymentRouter
 * @since W9-A (PAY-01)
 */

/** What the platform owes one provider for one billing cycle. */
export interface ProviderPayout {
  /** Provider id, e.g. `openai`. */
  provider: string;
  /** First day of the cycle, `YYYY-MM-DD`; with `provider` it is the payout key. */
  cycleStart: string;
  /** Last day of the cycle, `YYYY-MM-DD`. */
  cycleEnd: string;
  /** Amount owed, in USD (float). */
  providerCostUsd: number;
  status: 'pending' | 'paid' | 'failed';
  /** When `markPaid` was called, ISO 8601; absent while not paid. */
  paidAt?: string;
}

function payoutKey(provider: string, cycleStart: string): string {
  return `${provider}:${cycleStart}`;
}

/** In-memory ledger of provider payouts keyed by provider and cycle start. */
export class ProviderPaymentRouter {
  private payouts = new Map<string, ProviderPayout>();

/**
 * Add or update a payout entry.  Idempotent by (provider, cycleStart).
 *
 * @param payout - Entry to store; it is copied, not kept by reference.
 */
  addPayout(payout: ProviderPayout): void {
    const key = payoutKey(payout.provider, payout.cycleStart);
    this.payouts.set(key, { ...payout });
  }

/**
 * Mark a payout as paid, recording paidAt timestamp. Does nothing when no such payout exists.
 *
 * @param provider - Provider id.
 * @param cycleStart - Cycle start day, `YYYY-MM-DD`.
 */
  markPaid(provider: string, cycleStart: string): void {
    const key = payoutKey(provider, cycleStart);
    const entry = this.payouts.get(key);
    if (!entry) return;
    this.payouts.set(key, {
      ...entry,
      status: 'paid',
      paidAt: new Date().toISOString(),
    });
  }

/**
 * Return all payouts with status === 'pending'.
 *
 * @returns The stored entries (not copies).
 */
  getPendingPayouts(): ProviderPayout[] {
    return Array.from(this.payouts.values()).filter(p => p.status === 'pending');
  }

/**
 * Return all payouts regardless of status.
 *
 * @returns The stored entries (not copies).
 */
  getAllPayouts(): ProviderPayout[] {
    return Array.from(this.payouts.values());
  }

/**
 * Total USD owed across all pending payouts.
 *
 * @returns Sum of `providerCostUsd` of the pending entries.
 */
  getTotalOwedUsd(): number {
    return this.getPendingPayouts().reduce((sum, p) => sum + p.providerCostUsd, 0);
  }

  /** Clear all entries (test cleanup). */
  clearForTest(): void {
    this.payouts.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _router: ProviderPaymentRouter | undefined;

/**
 * Get or create the module-level ProviderPaymentRouter singleton.
 *
 * @returns The process-wide router.
 */
export function getPaymentRouter(): ProviderPaymentRouter {
  if (!_router) _router = new ProviderPaymentRouter();
  return _router;
}

/** Reset singleton (test cleanup). */
export function resetPaymentRouterForTest(): void {
  _router = undefined;
}
