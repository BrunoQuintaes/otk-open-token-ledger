/**
 * P2.1 — Receipt Indexer for Dashboard
 *
 * Maintains an in-memory index of recent receipts with per-tenant
 * aggregation. Designed to be consumed by the dashboard API endpoints.
 *
 * The indexer pulls data from the receipt store and accounting layer
 * on each call (pull model) rather than subscribing to events (push model),
 * keeping the implementation minimal and avoiding coupling with store internals.
 *
 * @module dashboard/indexer
 * @since Wave 2 Pack 19 (P2.1)
 */

import { size as receiptStoreSize, chainHead, auditCount } from '../api/receiptStore.js';
import { getIndexerStore } from './IIndexerStore.js';
import { calculateUsdCostSync } from '../pricing/economics/CostBridge.js';

const START_TIME = Date.now();

/** Shape of a receipt entry in the index. */
export interface IndexedReceipt {
  requestId: string;
  provider: string;
  model: string;
  costUsd?: number;   // USD-01: live or seed price (0 if provider/model unknown)
  inputTokens: number;
  outputTokens: number;
  costUnits: number;
  latencyMs: number;
  timestamp: number;
  tenantId: string;
  indexedAt: number;
  teamId?: string;    // TEAM-05: optional team attribution (from x-otk-team-id header)
}

/** Per-tenant summary. */
export interface TenantSummary {
  tenantId: string;
  totalReceipts: number;
  totalCU: number;
  totalCostUsd: number;  // USD-01
  lastActivityAt: number;
}

/** Per-team usage breakdown (TEAM-06). */
export interface TeamUsage {
  teamId: string;
  totalCU: number;
  totalUsd: number;
  requestCount: number;
}

/** Per-provider usage breakdown (P2.3, Wave 3D). */
export interface ProviderUsage {
  provider: string;
  model: string;
  requests: number;
  totalCU: number;
  totalCostUsd: number;  // USD-04
  avgLatencyMs: number;
  totalTokens: number;
}

/** Provider health metrics (P2.6, Wave 3D). */
export interface ProviderHealth {
  provider: string;
  requests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  totalCU: number;
}

/** System-wide overview. */
export interface SystemOverview {
  totalReceipts: number;
  totalTenants: number;
  totalCU: number;
  totalSpendUsd: number;  // USD-02: Total Spend (USD) KPI
  uptimeMs: number;
  queueDepth: number;
  chainHead: string;
  auditEntries: number;
}

/**
 * ReceiptIndexer — in-memory secondary index for dashboard views.
 *
 * Stores recent receipts in insertion order with a configurable max size.
 * Provides per-tenant aggregation and system overview.
 */
export class ReceiptIndexer {
  private _receipts: IndexedReceipt[] = [];
  private _tenantStats: Map<string, { totalReceipts: number; totalCU: number; totalCostUsd: number; lastActivityAt: number }> = new Map();
  private _maxSize: number;

  constructor(opts?: { maxSize?: number }) {
    this._maxSize = opts?.maxSize ?? 1000;
  }

  /**
   * Index a receipt. Called after a receipt is stored.
   * Maintains insertion-order array and per-tenant aggregation.
   */
  index(receipt: {
    requestId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUnits: number;
    latencyMs: number;
    timestamp: number;
    tenantId?: string;
    teamId?: string;   // TEAM-05: optional team attribution
  }): void {
    const tenantId = receipt.tenantId ?? 'default';

    // USD-01: compute USD cost using seed prices (sync, no Redis lookup needed for indexer)
    let costUsd = 0;
    try {
      costUsd = calculateUsdCostSync({
        provider: receipt.provider,
        model: receipt.model,
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
      }).totalCostUsd;
    } catch { /* unknown provider/model — costUsd stays 0 */ }

    const entry: IndexedReceipt = {
      requestId: receipt.requestId,
      provider: receipt.provider,
      model: receipt.model,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      costUnits: receipt.costUnits,
      costUsd,
      latencyMs: receipt.latencyMs,
      timestamp: receipt.timestamp,
      tenantId,
      indexedAt: Date.now(),
      teamId: receipt.teamId,
    };

    this._receipts.push(entry);

    // Evict oldest if over max size
    if (this._receipts.length > this._maxSize) {
      this._receipts.shift();
    }

    // Update tenant stats
    const stats = this._tenantStats.get(tenantId) ?? { totalReceipts: 0, totalCU: 0, totalCostUsd: 0, lastActivityAt: 0 };
    stats.totalReceipts++;
    stats.totalCU += receipt.costUnits;
    stats.totalCostUsd += costUsd;
    stats.lastActivityAt = entry.indexedAt;
    this._tenantStats.set(tenantId, stats);

    // H2.9: Delegate to IIndexerStore for cross-instance persistence.
    // Fire-and-forget — in-memory index remains authoritative locally.
    getIndexerStore().index(entry).catch(() => { /* non-fatal */ });
  }

  /**
   * Get the most recent receipts in reverse-chronological order.
   */
  getRecentReceipts(limit = 50): IndexedReceipt[] {
    const start = Math.max(0, this._receipts.length - limit);
    return this._receipts.slice(start).reverse();
  }

  /**
   * Get receipts for a specific tenant in reverse-chronological order.
   */
  getReceiptsByTenant(tenantId: string, limit = 50): IndexedReceipt[] {
    const filtered = this._receipts.filter(r => r.tenantId === tenantId);
    const start = Math.max(0, filtered.length - limit);
    return filtered.slice(start).reverse();
  }

  /**
   * Get per-tenant summary.
   */
  getTenantSummary(): TenantSummary[] {
    const result: TenantSummary[] = [];
    for (const [tenantId, stats] of this._tenantStats.entries()) {
      result.push({
        tenantId,
        totalReceipts: stats.totalReceipts,
        totalCU: stats.totalCU,
        totalCostUsd: stats.totalCostUsd,
        lastActivityAt: stats.lastActivityAt,
      });
    }
    return result.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * Get system-wide overview.
   */
  getSystemOverview(): SystemOverview {
    let totalCU = 0;
    let totalSpendUsd = 0;
    for (const stats of this._tenantStats.values()) {
      totalCU += stats.totalCU;
      totalSpendUsd += stats.totalCostUsd;
    }
    return {
      totalReceipts: this._receipts.length,
      totalTenants: this._tenantStats.size,
      totalCU,
      totalSpendUsd,
      uptimeMs: Date.now() - START_TIME,
      queueDepth: receiptStoreSize(),
      chainHead: chainHead(),
      auditEntries: auditCount(),
    };
  }

  /**
   * Get usage breakdown by provider+model (P2.3, Wave 3D).
   * Optionally filtered by tenantId.
   */
  getUsageByProvider(tenantId?: string): ProviderUsage[] {
    const source = tenantId
      ? this._receipts.filter(r => r.tenantId === tenantId)
      : this._receipts;

    const map = new Map<string, { requests: number; totalCU: number; totalCostUsd: number; totalLatencyMs: number; totalTokens: number }>();
    for (const r of source) {
      const key = `${r.provider}::${r.model}`;
      const agg = map.get(key) ?? { requests: 0, totalCU: 0, totalCostUsd: 0, totalLatencyMs: 0, totalTokens: 0 };
      agg.requests++;
      agg.totalCU += r.costUnits;
      agg.totalCostUsd += r.costUsd ?? 0;
      agg.totalLatencyMs += r.latencyMs;
      agg.totalTokens += r.inputTokens + r.outputTokens;
      map.set(key, agg);
    }

    const result: ProviderUsage[] = [];
    for (const [key, agg] of map) {
      const [provider, model] = key.split('::');
      result.push({
        provider,
        model,
        requests: agg.requests,
        totalCU: agg.totalCU,
        totalCostUsd: agg.totalCostUsd,
        avgLatencyMs: Math.round(agg.totalLatencyMs / agg.requests),
        totalTokens: agg.totalTokens,
      });
    }
    return result.sort((a, b) => b.totalCU - a.totalCU);
  }

  /**
   * Get provider health metrics (P2.6, Wave 3D).
   * Aggregates latency stats per provider from recent receipts.
   * Optionally filtered by tenantId (M24-SEC-03: a tenant caller must not read other tenants' CU and counts).
   */
  getProviderHealth(tenantId?: string): ProviderHealth[] {
    const source = tenantId ? this._receipts.filter(r => r.tenantId === tenantId) : this._receipts;
    const map = new Map<string, { latencies: number[]; totalCU: number }>();
    for (const r of source) {
      const agg = map.get(r.provider) ?? { latencies: [], totalCU: 0 };
      agg.latencies.push(r.latencyMs);
      agg.totalCU += r.costUnits;
      map.set(r.provider, agg);
    }

    const result: ProviderHealth[] = [];
    for (const [provider, agg] of map) {
      const sorted = agg.latencies.slice().sort((a, b) => a - b);
      const len = sorted.length;
      result.push({
        provider,
        requests: len,
        avgLatencyMs: Math.round(sorted.reduce((s, v) => s + v, 0) / len),
        p95LatencyMs: sorted[Math.min(Math.ceil(len * 0.95) - 1, len - 1)] ?? 0,
        maxLatencyMs: sorted[len - 1] ?? 0,
        totalCU: agg.totalCU,
      });
    }
    return result.sort((a, b) => b.requests - a.requests);
  }

  /**
   * Get usage aggregated by teamId (TEAM-06).
   * Only includes receipts that have a teamId set. Optionally filtered by tenantId (M24-DYN-05).
   */
  getUsageByTeam(tenantId?: string): TeamUsage[] {
    const map = new Map<string, { totalCU: number; totalUsd: number; requestCount: number }>();
    for (const r of this._receipts) {
      if (tenantId !== undefined && r.tenantId !== tenantId) continue;
      if (!r.teamId) continue;
      const agg = map.get(r.teamId) ?? { totalCU: 0, totalUsd: 0, requestCount: 0 };
      agg.totalCU += r.costUnits;
      agg.totalUsd += r.costUsd ?? 0;
      agg.requestCount++;
      map.set(r.teamId, agg);
    }
    const result: TeamUsage[] = [];
    for (const [teamId, agg] of map) {
      result.push({ teamId, ...agg });
    }
    return result.sort((a, b) => b.totalCU - a.totalCU);
  }

  /** Total indexed receipt count. */
  get size(): number {
    return this._receipts.length;
  }

  /** Reset all state (for tests). */
  reset(): void {
    this._receipts = [];
    this._tenantStats.clear();
  }
}

// ── Singleton instance ──────────────────────────────────────────────
let _instance: ReceiptIndexer | null = null;

export function getIndexer(): ReceiptIndexer {
  if (!_instance) _instance = new ReceiptIndexer();
  return _instance;
}

export function resetIndexerForTest(): void {
  if (_instance) _instance.reset();
  _instance = null;
}
