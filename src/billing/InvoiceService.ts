/**
 * InvoiceService — Usage summary per billing period
 *
 * Generates per-tenant invoices from TAL data.
 * Scope: operational billing summary, not Stripe/commercial payment.
 *
 * USD-05: Added unitPriceUsd, lineUsd, totalUsd using CostBridge seed prices.
 *
 * Reads the tenant's entries for one epoch from the token accounting layer (`talRuntime`), groups them by
 * provider and model, prices each group with the seed prices of `CostBridge` and compares the CU total with the
 * plan's CU quota from `PlanRegistry`. Pure computation over in-memory data: it does NOT persist the invoice,
 * send it or charge anyone.
 *
 * @module src/billing/InvoiceService
 * @since S2.2 (Wave 1 Pack 6)
 */

import { getAccountingLayer } from '../security/talRuntime.js';
import { getTenantPlan, getTenantPlanDefinition, type PlanTier } from './PlanRegistry.js';
import { calculateUsdCostSync } from '../pricing/economics/CostBridge.js';

/** Invoice line item (per model) */
export interface InvoiceLineItem {
  /** Provider id as recorded in the accounting entry. */
  provider: string;
  /** Model id as recorded in the accounting entry. */
  model: string;
  /** Number of accounting entries in this group. */
  requestCount: number;
  /** Compute units of the group. */
  totalCU: bigint;
  unitPriceUsd: number;   // USD-05: USD per 1K input tokens (seed price)
  lineUsd: number;        // USD-05: total line USD cost
}

/** Invoice summary for a tenant+epoch */
export interface Invoice {
  tenantId: string;
  /** Accounting epoch the invoice covers. */
  epochId: string;
  planTier: PlanTier;
  /** Generation time, ISO 8601. */
  generatedAt: string;
  lineItems: InvoiceLineItem[];
  /** Sum of the line items' compute units. */
  totalCU: bigint;
  totalRequests: number;
  totalUsd: number;       // USD-05: sum of all lineUsd
  quotaUsedPct: number; // 0-100, or -1 for unlimited
}

/**
 * Generate an invoice for a tenant and epoch.
 * Aggregates TAL entries by provider+model.
 *
 * A model with no seed price gets `lineUsd` and `unitPriceUsd` 0 (the pricing error is ignored). Entries without
 * token counts add 0 tokens. `quotaUsedPct` is an integer percentage that can exceed 100.
 *
 * @param tenantId - Tenant to bill.
 * @param epochId - Accounting epoch to read.
 * @returns The invoice; `totalCU` and line `totalCU` are bigint (use `serializeInvoice` before JSON).
 */
export function generateInvoice(tenantId: string, epochId: string): Invoice {
  const tal = getAccountingLayer();
  const entries = tal.entries(tenantId, epochId);
  const planTier = getTenantPlan(tenantId);
  const planDef = getTenantPlanDefinition(tenantId);

  // Aggregate by provider+model (including token counts for USD calc)
  type LineAgg = {
    provider: string;
    model: string;
    requestCount: number;
    totalCU: bigint;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  const groups = new Map<string, LineAgg>();
  for (const e of entries) {
    const key = `${e.provider}:${e.model}`;
    const existing = groups.get(key);
    if (existing) {
      existing.requestCount++;
      existing.totalCU += e.cu;
      existing.totalInputTokens += (e as any).inputTokens ?? 0;
      existing.totalOutputTokens += (e as any).outputTokens ?? 0;
    } else {
      groups.set(key, {
        provider: e.provider,
        model: e.model,
        requestCount: 1,
        totalCU: e.cu,
        totalInputTokens: (e as any).inputTokens ?? 0,
        totalOutputTokens: (e as any).outputTokens ?? 0,
      });
    }
  }

  // USD-05: compute USD amounts per line
  const lineItems: InvoiceLineItem[] = Array.from(groups.values()).map(agg => {
    let lineUsd = 0;
    let unitPriceUsd = 0;
    try {
      const cost = calculateUsdCostSync({
        provider: agg.provider,
        model: agg.model,
        inputTokens: agg.totalInputTokens,
        outputTokens: agg.totalOutputTokens,
      });
      lineUsd = cost.totalCostUsd;
      // unitPriceUsd = effective input price per 1K tokens (seed price reference)
      unitPriceUsd = agg.totalInputTokens > 0
        ? (cost.inputCostUsd / agg.totalInputTokens) * 1000
        : 0;
    } catch { /* unknown provider/model */ }
    return {
      provider: agg.provider,
      model: agg.model,
      requestCount: agg.requestCount,
      totalCU: agg.totalCU,
      unitPriceUsd,
      lineUsd,
    };
  });

  const totalCU = lineItems.reduce((acc, li) => acc + li.totalCU, 0n);
  const totalRequests = lineItems.reduce((acc, li) => acc + li.requestCount, 0);
  const totalUsd = lineItems.reduce((acc, li) => acc + li.lineUsd, 0);

  let quotaUsedPct = -1;
  if (planDef.cuQuotaPerEpoch > 0n) {
    quotaUsedPct = Number((totalCU * 100n) / planDef.cuQuotaPerEpoch);
  }

  return {
    tenantId,
    epochId,
    planTier,
    generatedAt: new Date().toISOString(),
    lineItems,
    totalCU,
    totalRequests,
    totalUsd,
    quotaUsedPct,
  };
}

/**
 * Serialize an invoice to JSON-safe format (bigints → strings).
 *
 * @param invoice - Invoice from `generateInvoice`; not mutated.
 * @returns A shallow copy with `totalCU` fields as decimal strings.
 */
export function serializeInvoice(invoice: Invoice): Record<string, unknown> {
  return {
    ...invoice,
    totalCU: String(invoice.totalCU),
    lineItems: invoice.lineItems.map(li => ({
      ...li,
      totalCU: String(li.totalCU),
    })),
  };
}
