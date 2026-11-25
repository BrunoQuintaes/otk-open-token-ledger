/**
 * U3.6/U3.7 — EconomicReport
 *
 * Reads UsageLedger JSONL events (U7.8) and produces a deterministic CSV
 * with USD/BRL + margin + reconciliation columns (U3.7).
 *
 * SECURITY: reads only metering fields (no prompts/headers/secrets).
 * Uses CostBridge (USD) + MarginEngine (markup/FX) + CostReconciliation (U3.7).
 *
 * Reads one JSONL file and overwrites one CSV file (creating its directory). The `UsageEvent` type below is
 * a local copy of `src/metering/ledger/UsageEvent.ts`. Called by the economics report script under
 * `scripts/ops/`.
 *
 * @module src/pricing/economics/EconomicReport
 */
import fs from "node:fs";
import path from "node:path";
import { calculateMargin } from "./MarginEngine.js";
import { reconcileCost } from "./CostReconciliation.js";

/** Paths and pricing parameters of one report run. */
export type EconomicReportConfig = {
  ledgerJsonlPath: string;   // e.g. docs/_ops/_usage_ledger/usage_events.jsonl
  outCsvPath: string;        // e.g. docs/_ops/_usage_ledger/reports/econ_report.csv
  markupPercent: number;     // e.g. 40 (for 40%)
  fxRate?: number;           // optional USD→BRL snapshot
};

type UsageEvent = {
  tsUnix: number;
  iso: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUnits: number;
  currency?: string;
  cost?: number;
  requestId?: string;
  sessionTag?: string;
};

const CSV_HEADER = [
  "iso", "provider", "model",
  "inputTokens", "outputTokens", "totalTokens",
  "latencyMs", "costUnits",
  "usdCost",                                                     // legacy (= usdCostEstimated)
  "usdCostEstimated", "usdCostReal", "costSource", "usdCostDelta", "deltaPercent",
  "usdPriceFinal", "usdMargin", "markupPercent",
  "brlPriceFinal",
  "sessionTag", "requestId",
].join(",");

/**
 * Builds the economic CSV report from a usage ledger (one row per event, in ledger order).
 *
 * USD amounts are written with 6 decimals; empty cells mean "not available".
 *
 * @param cfg - Ledger path, output path, markup percent and optional USD→BRL rate.
 * @throws {Error} When the ledger is missing, a line is not JSON, an event's provider/model is not in the seed
 *   table, or the markup is negative.
 */
export function buildEconomicReport(cfg: EconomicReportConfig): void {
  if (!fs.existsSync(cfg.ledgerJsonlPath)) {
    throw new Error(`EconomicReport: ledger not found at ${cfg.ledgerJsonlPath}`);
  }

  const lines = fs
    .readFileSync(cfg.ledgerJsonlPath, "utf8")
    .split("\n")
    .filter(Boolean);

  const events = lines.map((l) => JSON.parse(l) as UsageEvent);

  const rows = events.map((e) => {
    // U3.7: reconcile real vs estimated cost
    const recon = reconcileCost({
      provider: e.provider,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      realCostUsd: e.cost,
      currency: e.currency,
    });

    // Margin uses the best available cost (real if present, estimated otherwise)
    const effectiveCostUsd =
      recon.source === "real" ? (recon.usdCostReal as number) : recon.usdCostEstimated;

    const margin = calculateMargin({
      costUsd: effectiveCostUsd,
      markupPercent: cfg.markupPercent,
      fxRate: cfg.fxRate,
    });

    return [
      e.iso,
      e.provider,
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.totalTokens,
      e.latencyMs,
      e.costUnits,
      round6(recon.usdCostEstimated),                                  // usdCost (legacy)
      round6(recon.usdCostEstimated),
      recon.usdCostReal !== null ? round6(recon.usdCostReal) : "",
      recon.source,
      recon.usdCostDelta !== null ? round6(recon.usdCostDelta) : "",
      recon.deltaPercent !== null ? recon.deltaPercent.toFixed(4) : "",
      round6(margin.finalPriceUsd),
      round6(margin.marginUsd),
      cfg.markupPercent,
      margin.finalPriceBrl !== undefined ? round6(margin.finalPriceBrl) : "",
      e.sessionTag ?? "",
      e.requestId ?? "",
    ]
      .map(csvEscape)
      .join(",");
  });

  fs.mkdirSync(path.dirname(cfg.outCsvPath), { recursive: true });
  fs.writeFileSync(
    cfg.outCsvPath,
    [CSV_HEADER, ...rows].join("\n") + "\n",
    "utf8"
  );
}

function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function round6(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : "";
}
