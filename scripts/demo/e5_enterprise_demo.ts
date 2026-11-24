/**
 * PACK-E5 — Enterprise Demo Harness
 *
 * Runs 3 deterministic scenarios through the E4 pipeline and writes
 * report.json + report.csv to the output directory (--out <path>).
 *
 * Scenarios:
 *   S1 ALLOW       — quota ok, debit ok, no budget alert
 *   S2 POLICY_DENY — quota exceeded, no debit/pricing
 *   S3 BUDGET_WARN — allowed but 90% budget usage → warn alert
 *
 * All I/O is confined to this script. Core functions remain pure.
 * No network, no live clock in report content (NOW_ISO/NOW_EPOCH fixed).
 *
 * Usage:
 *   npx tsx scripts/demo/e5_enterprise_demo.ts --out <dir>
 *   # OR: npm run demo:e5 -- --out <dir>
 *
 * @module e5_enterprise_demo
 * @since E5
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateEnterprise } from '../../src/enterprise/EnterpriseEvaluator.js';
import { createBillingToken } from '../../src/economics/BillingToken.js';
import type { EnterpriseRequest, EnterpriseResult } from '../../src/enterprise/EnterpriseContext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fixed constants — deterministic (no wall-clock in report content)
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0'.repeat(64);
const NOW_ISO = '2026-01-01T00:00:00Z';
const NOW_EPOCH = 1_000_000;

const BASE_TOKEN = createBillingToken('acme', 1000n, 0, {
  nowIso: NOW_ISO,
  idSeed: 'e5-demo-token',
});

const BASE_POLICIES = [{ type: 'quota' as const, maxCU: 1000n, period: 'daily' as const }];
const BASE_BUDGET = { maxCU: 1000n, warnPct: 80, criticalPct: 95 };

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

type ScenarioName = 'S1_ALLOW' | 'S2_POLICY_DENY' | 'S3_BUDGET_WARN';

const SCENARIOS: Record<ScenarioName, EnterpriseRequest> = {
  S1_ALLOW: {
    tenant: { tenantId: 'acme', userId: 'alice' },
    policies: BASE_POLICIES,
    policyCtx: { consumedCU: 500n },   // 500 < 1000 → allowed
    token: BASE_TOKEN,
    costCU: 100n,
    consumedCU: 500n,                  // same snapshot — post-debit: 600/1000 = 60%
    pricing: { model: 'gpt-4o', costUnits: 100, markupPercent: 20 },
    budgetPolicy: BASE_BUDGET,
    prevAuditHash: GENESIS_HASH,
    nowEpoch: NOW_EPOCH,
    nowIso: NOW_ISO,
  },
  S2_POLICY_DENY: {
    tenant: { tenantId: 'acme', userId: 'bob' },
    policies: BASE_POLICIES,
    policyCtx: { consumedCU: 1000n },  // 1000 >= 1000 → quota denied
    token: BASE_TOKEN,
    costCU: 100n,
    consumedCU: 1000n,
    pricing: { model: 'gpt-4o', costUnits: 100, markupPercent: 20 },
    budgetPolicy: BASE_BUDGET,
    prevAuditHash: GENESIS_HASH,
    nowEpoch: NOW_EPOCH,
    nowIso: NOW_ISO,
  },
  S3_BUDGET_WARN: {
    tenant: { tenantId: 'acme', userId: 'charlie' },
    policies: BASE_POLICIES,
    policyCtx: { consumedCU: 750n },   // 750 < 1000 → allowed
    token: BASE_TOKEN,
    costCU: 100n,
    consumedCU: 800n,                  // same snapshot — post-debit: 900/1000 = 90% → warn
    pricing: { model: 'claude-3-opus', costUnits: 100, markupPercent: 20 },
    budgetPolicy: BASE_BUDGET,
    prevAuditHash: GENESIS_HASH,
    nowEpoch: NOW_EPOCH,
    nowIso: NOW_ISO,
  },
};

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/**
 * Semantic label distinguishing the gate decision from the budget telemetry.
 *   DENY_POLICY — request blocked by policy gate (no debit/pricing)
 *   ALLOW       — request passed all gates (debit + pricing executed)
 */
type DecisionKind = 'DENY_POLICY' | 'ALLOW';

type ReportRow = {
  scenario: ScenarioName;
  decisionKind: DecisionKind;
  allowed: boolean;
  policyType: string;
  reason: string;
  tokenBalanceAfter: string;
  tier: string;
  finalPriceUsd: string;
  auditHash: string;
  alertTriggered: boolean;
  alertLevel: string;
  pctUsed: string;
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScenario(name: ScenarioName, req: EnterpriseRequest): ReportRow {
  const r: EnterpriseResult = evaluateEnterprise(req);
  return {
    scenario: name,
    decisionKind: (r.policyDecision.allowed ? 'ALLOW' : 'DENY_POLICY') as DecisionKind,
    allowed: r.policyDecision.allowed,
    policyType: r.policyDecision.allowed ? '' : r.policyDecision.policy,
    reason: r.policyDecision.allowed ? '' : r.policyDecision.reason,
    tokenBalanceAfter: r.tokenAfterDebit !== null ? String(r.tokenAfterDebit.balanceCU) : 'null',
    tier: r.pricing?.tier ?? 'null',
    finalPriceUsd: r.pricing !== null ? r.pricing.finalPriceUsd.toFixed(6) : 'null',
    auditHash: r.auditHash,
    alertTriggered: r.budgetAlert.triggered,
    alertLevel: r.budgetAlert.level ?? 'none',
    pctUsed: r.budgetAlert.pctUsed.toFixed(2),
  };
}

function toCSV(rows: ReportRow[]): string {
  const header = Object.keys(rows[0]!).join(',');
  const lines = rows.map(r =>
    Object.values(r).map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseOutDir(): string {
  const idx = process.argv.indexOf('--out');
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(REPO_ROOT, process.argv[idx + 1]!);
  }
  // Default: write to cwd
  return process.cwd();
}

const outDir = parseOutDir();
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('E5 Enterprise Demo Harness');
console.log('==========================');
console.log(`Output dir: ${outDir}`);
console.log(`NOW_ISO: ${NOW_ISO}  NOW_EPOCH: ${NOW_EPOCH}`);
console.log('');

const rows: ReportRow[] = [];

for (const [name, req] of Object.entries(SCENARIOS) as [ScenarioName, EnterpriseRequest][]) {
  const row = runScenario(name, req);
  rows.push(row);
  console.log(`[${name}]`);
  console.log(`  allowed:         ${row.allowed}`);
  console.log(`  policyType:      ${row.policyType || '(n/a)'}`);
  console.log(`  reason:          ${row.reason || '(n/a)'}`);
  console.log(`  tokenBalance:    ${row.tokenBalanceAfter}`);
  console.log(`  tier:            ${row.tier}`);
  console.log(`  finalPriceUsd:   ${row.finalPriceUsd}`);
  console.log(`  auditHash:       ${row.auditHash.slice(0, 16)}...`);
  console.log(`  alertTriggered:  ${row.alertTriggered}  level=${row.alertLevel}  pctUsed=${row.pctUsed}%`);
  console.log('');
}

// Write outputs
const reportJsonPath = path.join(outDir, 'report.json');
const reportCsvPath = path.join(outDir, 'report.csv');

fs.writeFileSync(reportJsonPath, JSON.stringify(rows, null, 2) + '\n', 'utf8');
fs.writeFileSync(reportCsvPath, toCSV(rows), 'utf8');

console.log(`report.json → ${reportJsonPath}`);
console.log(`report.csv  → ${reportCsvPath}`);
console.log('');
console.log('DONE.');
