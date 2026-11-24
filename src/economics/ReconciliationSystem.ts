/**
 * RB-054 — Reconciliation System (Stub)
 *
 * Periodic reconciliation: compares OTK on-chain receipts (JSONL) with
 * external billing records (CSV/JSON) to detect discrepancies.
 *
 * Builds on existing CostReconciliation.ts (U3.7 — per-receipt delta).
 * This module adds batch/periodic reconciliation at the reporting level.
 *
 * Invariant: reconcile() is deterministic when nowIso is provided.
 * Without nowIso, defaults to wall-clock (acceptable at report boundary only).
 *
 * @module economics/ReconciliationSystem
 * @since RB-054
 */

import { calculateUsdCostSync } from '../pricing/economics/CostBridge.js';

export type OTKRecord = {
  txHash: string;
  userId: string;
  costUnits: bigint;
  epoch: number;
  // USD-07: optional fields for USD reconciliation
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Receipt identity (requestId). Several receipts may share one txHash (batch). */
  receiptId?: string;
};

export type ExternalBillingRecord = {
  txHash: string;
  userId: string;
  /** Cost in USD from external billing provider */
  billedUsd: number;
};

export type ReconciliationLineItem = {
  txHash: string;
  userId: string;
  otkCU: bigint | null;
  externalUsd: number | null;
  /** USD-07: OTK's expected USD cost (from CostBridge seed, null if provider/model unknown) */
  expectedUsd: number | null;
  /** USD-07: externalUsd - expectedUsd (null if either is missing) */
  deltaUsd: number | null;
  /** USD-07: (deltaUsd / expectedUsd) * 100 (null if not computable) */
  deltaPercent: number | null;
  /** USD-07: true if |deltaPercent| > 5% */
  discrepancyFlag: boolean;
  /** Status: matched | otk_only | external_only */
  status: 'matched' | 'otk_only' | 'external_only';
  /**
   * R06: one line per txHash aggregates every OTK receipt of that transaction.
   * otkCU is their sum; these fields keep the per-receipt traceability.
   */
  otkReceiptCount: number;
  receiptIds: string[];
  userIds: string[];
  epochs: number[];
  /** Receipts of this tx whose expected USD could not be computed (expectedUsd is then null). */
  unpricedReceipts: number;
  externalRecordCount: number;
};

export type ReconciliationReport = {
  generatedAt: string;
  totalOTK: number;
  totalExternal: number;
  matched: number;
  otkOnly: number;
  externalOnly: number;
  items: ReconciliationLineItem[];
};

/**
 * Reconcile OTK receipts against external billing records.
 *
 * @param nowIso - Timestamp for generatedAt (injectable for determinism/tests).
 *                 Defaults to wall-clock (acceptable at report boundary only).
 *
 * Pure when nowIso provided — no I/O, no side effects.
 */
export function reconcile(
  otkRecords: OTKRecord[],
  externalRecords: ExternalBillingRecord[],
  nowIso = new Date().toISOString(),
): ReconciliationReport {
  // R06: group instead of keying a Map by txHash, which silently kept only the
  // last receipt of a batch transaction. Grouping is explicit and lossless.
  const otkGroups = new Map<string, OTKRecord[]>();
  for (const r of otkRecords) {
    const g = otkGroups.get(r.txHash);
    if (g) g.push(r); else otkGroups.set(r.txHash, [r]);
  }
  const extGroups = new Map<string, ExternalBillingRecord[]>();
  for (const r of externalRecords) {
    const g = extGroups.get(r.txHash);
    if (g) g.push(r); else extGroups.set(r.txHash, [r]);
  }
  const allKeys = new Set([...otkGroups.keys(), ...extGroups.keys()]);

  const items: ReconciliationLineItem[] = [];
  for (const key of allKeys) {
    const otk = otkGroups.get(key) ?? [];
    const ext = extGroups.get(key) ?? [];
    const externalUsd = ext.length > 0 ? ext.reduce((s, r) => s + r.billedUsd, 0) : null;

    // USD-07: expected USD from CostBridge; any unpriced receipt makes the tx total unknown.
    let pricedSum = 0;
    let unpricedReceipts = 0;
    for (const r of otk) {
      if (r.provider && r.model && r.inputTokens != null && r.outputTokens != null) {
        try {
          pricedSum += calculateUsdCostSync({
            provider: r.provider,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
          }).totalCostUsd;
          continue;
        } catch { /* unknown provider/model */ }
      }
      unpricedReceipts++;
    }
    const expectedUsd = otk.length > 0 && unpricedReceipts === 0 ? pricedSum : null;

    const deltaUsd = externalUsd !== null && expectedUsd !== null ? externalUsd - expectedUsd : null;
    const deltaPercent = deltaUsd !== null && expectedUsd !== null && expectedUsd !== 0
      ? (deltaUsd / expectedUsd) * 100
      : null;
    const discrepancyFlag = deltaPercent !== null && Math.abs(deltaPercent) > 5;

    const userIds = [...new Set([...otk.map(r => r.userId), ...ext.map(r => r.userId)])];
    items.push({
      txHash: key,
      userId: userIds.length === 1 ? userIds[0]! : userIds.length === 0 ? 'unknown' : 'multiple',
      otkCU: otk.length > 0 ? otk.reduce((s, r) => s + r.costUnits, 0n) : null,
      externalUsd,
      expectedUsd,
      deltaUsd,
      deltaPercent,
      discrepancyFlag,
      status: otk.length > 0 && ext.length > 0 ? 'matched' : otk.length > 0 ? 'otk_only' : 'external_only',
      otkReceiptCount: otk.length,
      receiptIds: otk.map((r, i) => r.receiptId ?? `${key}#${i}`),
      userIds,
      epochs: [...new Set(otk.map(r => r.epoch))],
      unpricedReceipts,
      externalRecordCount: ext.length,
    });
  }

  const matched = items.filter(i => i.status === 'matched').length;
  const otkOnly = items.filter(i => i.status === 'otk_only').length;
  const externalOnly = items.filter(i => i.status === 'external_only').length;

  return {
    generatedAt: nowIso,
    totalOTK: otkRecords.length,
    totalExternal: externalRecords.length,
    matched,
    otkOnly,
    externalOnly,
    items,
  };
}
