/**
 * PAY-01 — ProviderPaymentRouter
 * Tracks end-of-cycle provider payouts (what OTK owes to AI providers).
 *
 * When OTK collects money from tenants it owes the actual provider cost
 * back to the AI provider (OpenAI, Anthropic, etc.).  This module
 * accumulates those amounts and allows marking them paid.
 *
 * @module billing/ProviderPaymentRouter
 * @since W9-A (PAY-01)
 */

export interface ProviderPayout {
  provider: string;
  cycleStart: string;
  cycleEnd: string;
  providerCostUsd: number;
  status: 'pending' | 'paid' | 'failed';
  paidAt?: string;
}

function payoutKey(provider: string, cycleStart: string): string {
  return `${provider}:${cycleStart}`;
}

export class ProviderPaymentRouter {
  private payouts = new Map<string, ProviderPayout>();

  /** Add or update a payout entry.  Idempotent by (provider, cycleStart). */
  addPayout(payout: ProviderPayout): void {
    const key = payoutKey(payout.provider, payout.cycleStart);
    this.payouts.set(key, { ...payout });
  }

  /** Mark a payout as paid, recording paidAt timestamp. */
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

  /** Return all payouts with status === 'pending'. */
  getPendingPayouts(): ProviderPayout[] {
    return Array.from(this.payouts.values()).filter(p => p.status === 'pending');
  }

  /** Return all payouts regardless of status. */
  getAllPayouts(): ProviderPayout[] {
    return Array.from(this.payouts.values());
  }

  /** Total USD owed across all pending payouts. */
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

/** Get or create the module-level ProviderPaymentRouter singleton. */
export function getPaymentRouter(): ProviderPaymentRouter {
  if (!_router) _router = new ProviderPaymentRouter();
  return _router;
}

/** Reset singleton (test cleanup). */
export function resetPaymentRouterForTest(): void {
  _router = undefined;
}
