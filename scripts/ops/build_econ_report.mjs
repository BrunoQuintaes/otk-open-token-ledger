#!/usr/bin/env node
/**
 * U3.6 — CLI: build economic report from UsageLedger JSONL
 *
 * Reads docs/_ops/_usage_ledger/usage_events.jsonl and writes
 * docs/_ops/_usage_ledger/reports/econ_report.csv with USD cost,
 * final price, margin, and optional BRL conversion.
 *
 * Usage:
 *   node scripts/reports/build_econ_report.mjs <markupPercent> [fxRate]
 *
 * Example:
 *   node scripts/reports/build_econ_report.mjs 40 5.80
 *
 * @since U3.6
 */
import { buildEconomicReport } from "../../src/pricing/economics/EconomicReport.js";

const markupPercent = Number(process.argv[2] ?? "40");
const fxRate = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

if (isNaN(markupPercent) || markupPercent < 0) {
  console.error("Usage: node build_econ_report.mjs <markupPercent> [fxRate]");
  process.exit(1);
}

buildEconomicReport({
  ledgerJsonlPath: "docs/_ops/_usage_ledger/usage_events.jsonl",
  outCsvPath:      "docs/_ops/_usage_ledger/reports/econ_report.csv",
  markupPercent,
  fxRate,
});

console.log("OK: wrote docs/_ops/_usage_ledger/reports/econ_report.csv");
if (fxRate) console.log(`   FX rate used: USD→BRL ${fxRate}`);
console.log(`   Markup: ${markupPercent}%`);
