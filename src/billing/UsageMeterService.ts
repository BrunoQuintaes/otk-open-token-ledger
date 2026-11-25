/**
 * BILL-01 — UsageMeterService
 *
 * Computes per-tenant USD usage from TAL data for a billing period and
 * submits usage records to Stripe (metered billing for PRO tier).
 *
 * Flow:
 *   1. Pull TAL entries for tenant+epoch
 *   2. Compute totalUsd via CostBridge seed prices
 *   3. For PRO (usage-based): submit to Stripe as a usage record
 *   4. For STARTER (flat): return computed USD for P&L only (Stripe billed flat)
 *   5. For FREE: return 0 (no charge)
 *
 * Pricing uses the seed price table (`PRICE_TABLE_VERSION`); entries without token counts or without a price are
 * listed in `unpricedEntries` and block the Stripe submission. The Stripe call is injected as a
 * `StripeUsageRecordPort`; without one nothing is sent. No caller in `src/` at the evaluated version.
 *
 * @module src/billing/UsageMeterService
 * @since W7-C (BILL-01)
 */

import { getAccountingLayer } from '../security/talRuntime.js';
import { getTenantPlanDefinition } from './PlanRegistry.js';
import { calculateUsdCostSync } from '../pricing/economics/CostBridge.js';
import { PRICE_TABLE_VERSION } from '../pricing/economics/ProviderPriceTable.js';

/** Result of `computeAndSubmitUsage` for one tenant and epoch. */
export interface UsageSummary {
  tenantId: string;
  epochId: string;
  /** Billing model of the tenant's cached plan tier. */
  billingModel: 'free' | 'flat' | 'usage';
  /** Compute units of every entry of the period, priced or not. */
  totalCU: bigint;
  /** USD of the priced entries only. Meaningful as an invoice total only when complete=true. */
  totalUsd: number;
  /** Seed price table version applied to every priced entry (R02/R08: price is identifiable). */
  priceVersion: string;
  /** Number of entries that were priced. */
  pricedEntries: number;
  /** Entries that could not be priced; never silently counted as USD 0 (R02). */
  unpricedEntries: Array<{ requestId: string; reason: 'missing_tokens' | 'unknown_price' }>;
  /** true only when every entry of the period was priced. */
  complete: boolean;
  /** Stripe usage record ID if submitted, null otherwise */
  stripeUsageRecordId: string | null;
  /** Why no Stripe submission happened although the plan is usage-based. */
  submissionBlocked?: 'incomplete_pricing' | 'stripe_usage_port_not_configured';
}

/**
 * OVERNIGHT 20261005 / Phase 5 (R03): the usage-record call of metered billing, injected by the caller. The previous
 * code imported a `getStripeClient` that StripeClient never exported (raw tsc TS2339), so the submission path could
 * only fail at run time inside a catch. Real Stripe metered billing is outside the validated scope of the thesis;
 * without a port the result says so explicitly instead of pretending an attempt.
 */
export interface StripeUsageRecordPort {
  /** Creates (action `set`) the usage record of a subscription item; `quantity` is in US cents. */
  createUsageRecord(subscriptionItemId: string, params: { quantity: number; timestamp: 'now'; action: 'set' }): Promise<{ id: string }>;
}

/**
 * Compute USD usage for a tenant+epoch and optionally submit to Stripe.
 *
 * Stripe submission only happens for PRO (usage-based) tenants and only when
 * a Stripe subscription item ID is provided. All other paths return computed
 * USD without side effects.
 *
 * A Stripe error is logged to the console and not thrown; the result then has `stripeUsageRecordId: null`.
 * The quantity sent is the USD total in cents, rounded.
 *
 * @param tenantId - Tenant to meter.
 * @param epochId - Accounting epoch to read.
 * @param opts - Subscription item id, dry-run flag and the Stripe usage-record port.
 * @returns The usage summary, with the Stripe record id when one was created.
 */
export async function computeAndSubmitUsage(
  tenantId: string,
  epochId: string,
  opts: {
    /** Stripe subscription item ID for metered billing (PRO only) */
    stripeSubscriptionItemId?: string;
    /** If true, skip Stripe submission even for PRO (dry-run mode) */
    dryRun?: boolean;
    /** Usage-record call (Stripe SDK subscriptionItems.createUsageRecord or a test double). */
    usageRecords?: StripeUsageRecordPort;
  } = {},
): Promise<UsageSummary> {
  const tal = getAccountingLayer();
  const entries = tal.entries(tenantId, epochId);
  const planDef = getTenantPlanDefinition(tenantId);

  // Compute totalUsd from TAL entries using CostBridge seed.
  // R02: tokens come from the entry itself; absent tokens or unknown prices are
  // reported in unpricedEntries instead of being read as 0.
  let totalCU = 0n;
  let totalUsd = 0;
  let pricedEntries = 0;
  const unpricedEntries: UsageSummary['unpricedEntries'] = [];
  for (const e of entries) {
    totalCU += e.cu;
    if (e.inputTokens === undefined || e.outputTokens === undefined) {
      unpricedEntries.push({ requestId: e.requestId, reason: 'missing_tokens' });
      continue;
    }
    try {
      const cost = calculateUsdCostSync({
        provider: e.provider,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      });
      totalUsd += cost.totalCostUsd;
      pricedEntries++;
    } catch {
      unpricedEntries.push({ requestId: e.requestId, reason: 'unknown_price' });
    }
  }
  const complete = unpricedEntries.length === 0;
  const base = {
    tenantId,
    epochId,
    billingModel: planDef.billingModel,
    totalCU,
    totalUsd,
    priceVersion: PRICE_TABLE_VERSION,
    pricedEntries,
    unpricedEntries,
    complete,
  };

  // No Stripe submission for free or flat plans
  if (planDef.billingModel !== 'usage' || opts.dryRun || !opts.stripeSubscriptionItemId) {
    return { ...base, stripeUsageRecordId: null };
  }

  // R02: never submit a partial total as if it were the whole period.
  if (!complete) {
    return { ...base, stripeUsageRecordId: null, submissionBlocked: 'incomplete_pricing' };
  }

  // PRO usage-based: submit usage record to Stripe
  // Stripe metered billing uses integer quantity (cents to avoid float issues)
  const quantityCents = Math.round(totalUsd * 100);

  if (!opts.usageRecords) {
    return { ...base, stripeUsageRecordId: null, submissionBlocked: 'stripe_usage_port_not_configured' };
  }
  let stripeUsageRecordId: string | null = null;
  try {
    const record = await opts.usageRecords.createUsageRecord(
      opts.stripeSubscriptionItemId,
      {
        quantity: quantityCents,
        timestamp: 'now',
        action: 'set',
      },
    );
    stripeUsageRecordId = record.id;
  } catch (err) {
    // Log but don't throw — billing failures are non-fatal for the API path
    // The BillingCycleWorker will retry on next cycle
    console.error('[UsageMeterService] Stripe usage record failed:', err);
  }

  return { ...base, stripeUsageRecordId };
}
