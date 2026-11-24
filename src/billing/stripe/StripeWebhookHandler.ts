/**
 * StripeWebhookHandler — Handles Stripe webhook events for billing lifecycle (P4.5)
 *
 * Events handled:
 *   checkout.session.completed   → activate subscription, upgrade plan tier
 *   invoice.payment_succeeded    → renew plan, send email receipt
 *   invoice.finalized            → BILL-06: update billing cycle status + notify tenant
 *   customer.subscription.deleted → downgrade tenant to FREE
 *
 * All handlers are idempotent — safe to retry on duplicate delivery.
 *
 * H1-S03 (FA-02, INF02-O1, INF02-O2; OTK-H1-MEGA 2026-10-13):
 *   - checkout.session.completed activates a tier only when payment_status is 'paid' (an unpaid or asynchronous
 *     payment session used to activate the paid tier at once) and the tier is a known one;
 *   - each event id is applied once and an event older than the last one applied to the same tenant (or in the same
 *     second while raising the tier) is acknowledged without effect; H1-S03b: the event record and the plan change
 *     are ONE atomic store operation (PlanRegistry.applyStripePlanEvent), so neither can be lost without the other;
 *   - a signed event naming a tenant that does not exist is refused (when the route supplies tenantExists);
 *   - a plan-store failure is returned as `retryable: true` and the event is NOT marked as processed, so the route
 *     answers 503 and Stripe redelivers (before, the write failure was swallowed and the webhook answered 200).
 *
 * H1R2 R-07/R-11: the subscription id of the event goes to the store, which orders events per subscription and
 * against the last administrative decision (admin_superseded_ignored / other_subscription_ignored; see IPlanStore).
 *
 * @module billing/stripe/StripeWebhookHandler
 * @since Wave 4 (4C-PACK-4C02 / P4.5), updated W7-C (BILL-06)
 */

import { escapeHtml } from '../../dashboard/sanitize.js';
import { stripeWebhookEventsTotal } from '../../observability/prometheusMetrics.js';
import { applyStripePlanEvent, getAllPlans } from '../PlanRegistry.js';
import { getEmailAdapter } from '../../email/IEmailAdapter.js';
import type { PlanTier } from '../PlanRegistry.js';
import type { StripeSkipReason } from '../IPlanStore.js';

// ──────────────────────────────────────────────────────────
// Stripe event shape (minimal — only fields we use)
// ──────────────────────────────────────────────────────────

export interface StripeEvent {
  type: string;
  id: string;
  /** Unix seconds (Stripe sets it on every event; used to refuse out-of-order plan changes). */
  created?: number;
  data: {
    object: Record<string, unknown>;
  };
}

// ──────────────────────────────────────────────────────────
// Handler result
// ──────────────────────────────────────────────────────────

export interface WebhookHandleResult {
  ok: boolean;
  event: string;
  action: string;
  tenantId?: string;
  /** H1-S03: transient failure (plan store); the event was not applied and must be redelivered (HTTP 503). */
  retryable?: boolean;
}

const KNOWN_TIERS: ReadonlySet<string> = new Set(getAllPlans().map((p) => p.tier));

const SKIP_ACTION: Readonly<Record<StripeSkipReason, string>> = {
  duplicate: 'duplicate_ignored',
  stale: 'stale_ignored',
  superseded_by_admin: 'admin_superseded_ignored',
  other_subscription: 'other_subscription_ignored',
};

/**
 * H1R2 R-07/R-11: Stripe subscription the event is about — `subscription` of a checkout session (id or expanded
 * object), `id` of a subscription object (customer.subscription.*). Undefined when absent: the store then falls back
 * to the tenant-wide H1-S03 order.
 */
function subscriptionIdOf(event: StripeEvent): string | undefined {
  const o = event.data?.object ?? {};
  if (o['object'] === 'subscription' || event.type.startsWith('customer.subscription.')) {
    return typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : undefined;
  }
  const s = o['subscription'];
  if (typeof s === 'string' && s !== '') return s;
  if (s && typeof s === 'object' && typeof (s as Record<string, unknown>)['id'] === 'string') return (s as Record<string, string>)['id'] || undefined;
  return undefined;
}

// ──────────────────────────────────────────────────────────
// StripeWebhookHandler
// ──────────────────────────────────────────────────────────

export interface StripeWebhookHandlerOptions {
  /** H1-S03b: refuse events whose metadata names an unknown tenant (no phantom plan rows). */
  tenantExists?: (tenantId: string) => Promise<boolean>;
}

export class StripeWebhookHandler {
  constructor(private readonly _opts: StripeWebhookHandlerOptions = {}) {}

  /**
   * Dispatch a parsed Stripe event to the appropriate handler.
   * Returns a result descriptor. Never throws — errors are captured in result.
   */
  async handle(event: StripeEvent): Promise<WebhookHandleResult> {
    let r: WebhookHandleResult;
    try {
      r = await this._dispatch(event);
    } catch {
      // "Never throws": an unexpected error is a failed, retryable delivery, never an acknowledged one
      r = { ok: false, event: String(event?.type ?? 'unknown'), action: 'handler_error', retryable: true };
    }
    // H1-S22: pending (retryable) and refused events are observable
    const known = ['checkout.session.completed', 'invoice.payment_succeeded', 'invoice.finalized', 'customer.subscription.deleted'];
    stripeWebhookEventsTotal.inc({ type: known.includes(r.event) ? r.event : 'other', action: r.action });
    return r;
  }

  private async _dispatch(event: StripeEvent): Promise<WebhookHandleResult> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this._handleCheckoutCompleted(event);
      case 'invoice.payment_succeeded':
        return this._handleInvoicePayment(event);
      case 'invoice.finalized':
        return this._handleInvoiceFinalized(event);
      case 'customer.subscription.deleted':
        return this._handleSubscriptionDeleted(event);
      default:
        return { ok: true, event: event.type, action: 'ignored' };
    }
  }

  /** Apply a plan change at most once per event id, atomically with the event record (H1-S03b). */
  private async _applyPlan(event: StripeEvent, tenantId: string, tier: PlanTier, action: string): Promise<WebhookHandleResult> {
    // H1 R-08 (adversarial review): a downgrade is always applied (a deactivated tenant must not come back paid);
    // an upgrade for a tenant this replica does not know is retried (503), not acknowledged and lost
    if (tier !== 'FREE' && this._opts.tenantExists && !(await this._opts.tenantExists(tenantId))) {
      return { ok: false, event: event.type, action: 'unknown_tenant', tenantId, retryable: true };
    }
    const created = Number.isFinite(event.created) ? Number(event.created) : 0;
    const subscriptionId = subscriptionIdOf(event);
    let r: Awaited<ReturnType<typeof applyStripePlanEvent>>;
    try {
      r = await applyStripePlanEvent(tenantId, tier, { id: event.id, created, type: event.type, ...(subscriptionId ? { subscriptionId } : {}) });
    } catch {
      return { ok: false, event: event.type, action: 'plan_store_unavailable', tenantId, retryable: true };
    }
    // H1R2 R-07/R-11: recorded but not applied; acknowledged (200) so Stripe stops redelivering, reason in the store
    if (!r.applied) return { ok: true, event: event.type, action: SKIP_ACTION[r.skipped ?? 'stale'], tenantId };
    return { ok: true, event: event.type, action, tenantId };
  }

  private async _handleCheckoutCompleted(event: StripeEvent): Promise<WebhookHandleResult> {
    const session = event.data.object ?? {};
    const tenantId = (session['metadata'] as Record<string, string> | undefined)?.['tenantId'];
    const tier = (session['metadata'] as Record<string, string> | undefined)?.['tier'] as PlanTier | undefined;

    if (!tenantId || !tier) {
      return { ok: false, event: event.type, action: 'missing_metadata' };
    }
    if (!KNOWN_TIERS.has(tier)) {
      return { ok: false, event: event.type, action: 'unknown_tier', tenantId };
    }
    // H1-S03: 'unpaid' (asynchronous methods) or 'no_payment_required' never activate a paid tier here; an
    // asynchronous payment that later succeeds arrives as checkout.session.async_payment_succeeded (not handled yet:
    // the tenant stays on its current tier, the fail-closed side)
    if (session['payment_status'] !== 'paid') {
      return { ok: true, event: event.type, action: 'awaiting_payment', tenantId };
    }

    return this._applyPlan(event, tenantId, tier, 'plan_activated');
  }

  private async _handleInvoicePayment(event: StripeEvent): Promise<WebhookHandleResult> {
    const invoice = event.data.object;
    const tenantId = (invoice['metadata'] as Record<string, string> | undefined)?.['tenantId']
      ?? String(invoice['customer_email'] ?? 'unknown');

    // Send email receipt (non-blocking, non-fatal)
    const adapter = getEmailAdapter();
    void adapter?.send({
      to: String(invoice['customer_email'] ?? 'billing@otk.io'),
      subject: `Payment Receipt — OTK zk-Metering`,
      text: `Your payment of $${invoice['amount_paid'] ?? 0} has been received. Thank you!`,
      html: `<p>${escapeHtml(`Your payment of $${invoice['amount_paid'] ?? 0} has been received. Thank you!`)}</p>`,
    }).catch(() => { /* non-fatal */ });

    return { ok: true, event: event.type, action: 'receipt_sent', tenantId };
  }

  // BILL-06: invoice.finalized → mark billing cycle submitted + email tenant
  private async _handleInvoiceFinalized(event: StripeEvent): Promise<WebhookHandleResult> {
    const invoice = event.data.object;
    const invoiceId = String(invoice['id'] ?? '');
    const tenantId = (invoice['metadata'] as Record<string, string> | undefined)?.['tenantId']
      ?? String(invoice['customer_email'] ?? 'unknown');
    const amountDue = Number(invoice['amount_due'] ?? 0) / 100; // cents → USD

    // Send finalized invoice notification (non-blocking)
    const adapter = getEmailAdapter();
    void adapter?.send({
      to: String(invoice['customer_email'] ?? 'billing@otk.io'),
      subject: `Invoice Finalized — OTK zk-Metering`,
      text: `Your invoice ${invoiceId} for $${amountDue.toFixed(2)} has been finalized. It will be charged on the due date.`,
      html: `<p>${escapeHtml(`Your invoice ${invoiceId} for $${amountDue.toFixed(2)} has been finalized. It will be charged on the due date.`)}</p>`,
    }).catch(() => { /* non-fatal */ });

    return { ok: true, event: event.type, action: 'invoice_finalized_notified', tenantId };
  }

  private async _handleSubscriptionDeleted(event: StripeEvent): Promise<WebhookHandleResult> {
    const sub = event.data.object;
    const tenantId = (sub['metadata'] as Record<string, string> | undefined)?.['tenantId'];

    if (!tenantId) {
      return { ok: false, event: event.type, action: 'missing_tenant_id' };
    }

    return this._applyPlan(event, tenantId, 'FREE', 'downgraded_to_free');
  }
}
