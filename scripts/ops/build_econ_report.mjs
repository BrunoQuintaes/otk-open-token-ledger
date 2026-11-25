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
 * The script lives in scripts/ops/ (the paths in Usage and Example above name an older location).
 * Run it from the repository root: the ledger and report paths are relative to the working directory.
 * The cost computation itself is `buildEconomicReport` in src/pricing/economics/EconomicReport.ts;
 * this file only parses the arguments (markupPercent must be a number >= 0; fxRate is optional).
 * That module is TypeScript imported through a `.js` specifier, so plain `node` cannot resolve it: run
 * the script through a TypeScript loader such as `npx tsx`.
 * Exit codes: 0 = report written; 1 = invalid markup, or an uncaught error from the report builder.
 *
 * @since U3.6
 * @module scripts/ops/build_econ_report
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
