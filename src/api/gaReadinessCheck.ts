/**
 * GA Readiness Check — structured readiness status for each GA requirement.
 *
 * Returns a snapshot of readiness for the 6 General Availability gates.
 * Items that can be verified programmatically return 'pass'; human-gated
 * items (pentest, DR drill, first customer, SLO 30-day window) return 'pending'.
 *
 * Route: GET /v1/admin/ga-readiness (admin:chain-head)
 *
 * @module api/gaReadinessCheck
 * @since GA infrastructure (2026-04-07)
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GARequirement {
  /** Machine-readable identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /**
   * - 'pass'    — verified programmatically; infrastructure confirmed ready.
   * - 'pending' — human decision / external process required.
   * - 'fail'    — previously-passing check regressed.
   */
  status: 'pass' | 'pending' | 'fail';
  /** Explanation of current status and next action. */
  notes: string;
}

// ─── Requirement checkers ────────────────────────────────────────────────────

/**
 * GA-1: External pentest.
 * Cannot be verified programmatically — requires engagement of an external firm.
 */
function checkPentest(): GARequirement {
  return {
    id: 'pentest',
    name: 'External Pentest',
    status: 'pending',
    notes:
      'OWASP Top 10 + auth flows + BYOK vault. ' +
      'Engage an approved external security firm. ' +
      'See docs/GA_READINESS.md §GA-1 for scope. ' +
      'Archive report in docs/_ops/ga/ when complete.',
  };
}

/**
 * GA-2: Disaster recovery drill.
 * Script exists at scripts/ops/dr_drill.sh but live execution is a human gate.
 */
function checkDrDrill(): GARequirement {
  return {
    id: 'dr_drill',
    name: 'Disaster Recovery Drill',
    status: 'pending',
    notes:
      'DR script available at scripts/ops/dr_drill.sh. ' +
      'Run full drill in staging: PG backup restore + Redis failover. ' +
      'Target RTO < 30 min, RPO < 1 hour. ' +
      'Archive results in docs/_ops/ga/ when complete.',
  };
}

/**
 * GA-3: Load test.
 * Script exists at scripts/ops/load_test.js; live run against production is human gate.
 */
function checkLoadTest(): GARequirement {
  return {
    id: 'load_test',
    name: 'Load Test (p99 < 200 ms)',
    status: 'pending',
    notes:
      'Load test script at scripts/ops/load_test.js. ' +
      'Target: 100 concurrent × 50 AI calls/hour = 5,000 req/hour, p99 < 200 ms. ' +
      'Run: node scripts/ops/load_test.js <prod_url> 100 500. ' +
      'Archive results in docs/_ops/ga/ when passing.',
  };
}

/**
 * GA-4: SLO sign-off.
 * Status page infrastructure is live; 30-day window must elapse in production.
 */
function checkSloSignOff(): GARequirement {
  return {
    id: 'slo_signoff',
    name: 'SLO Sign-Off (99.9% / 30 days)',
    status: 'pending',
    notes:
      'Status page live at GET /status (src/dashboard/status.ts). ' +
      'Prometheus metrics available at GET /metrics. ' +
      'SLO per plan: PRO = 99.9% uptime, p99 < 1 s. ' +
      '30-day production window must elapse before sign-off. ' +
      'SRE lead signs off when target window is complete.',
  };
}

/**
 * GA-5: Legal pages active.
 * Verified programmatically — /terms, /privacy, /dpa routes are wired in routes.ts
 * (src/dashboard/legal.ts: renderTermsPage, renderPrivacyPage, renderDpaPage).
 * Content still requires legal counsel review before production.
 */
function checkLegalPages(): GARequirement {
  // These routes are statically wired in routes.ts.
  // Verify the legal module file exists on disk — works for both compiled (.js)
  // and tsx/source (.ts) runtimes.
  const legalModuleExists = (() => {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const dir = dirname(__filename);
      return (
        existsSync(resolve(dir, '../dashboard/legal.js')) ||
        existsSync(resolve(dir, '../dashboard/legal.ts'))
      );
    } catch {
      return false;
    }
  })();

  if (legalModuleExists) {
    return {
      id: 'legal_pages',
      name: 'Legal Pages Active',
      status: 'pass',
      notes:
        'Routes /terms, /privacy, /dpa wired in routes.ts. ' +
        'Handlers: renderTermsPage, renderPrivacyPage, renderDpaPage (src/dashboard/legal.ts). ' +
        'Action required: replace placeholder content with text reviewed by legal counsel.',
    };
  }

  return {
    id: 'legal_pages',
    name: 'Legal Pages Active',
    status: 'fail',
    notes: 'Legal module not found — check src/dashboard/legal.ts.',
  };
}

/**
 * GA-6: First paying customer.
 * Cannot be verified programmatically — requires signed contract + live production use.
 */
function checkFirstPayingCustomer(): GARequirement {
  return {
    id: 'first_paying_customer',
    name: 'First Paying Customer',
    status: 'pending',
    notes:
      'Requires: signed contract or ToS acceptance + payment method on file (Stripe). ' +
      'At least one receipt submitted and persisted in production PostgreSQL. ' +
      'Stripe billing cycle running (src/billing/stripe/). ' +
      'Update this check to "pass" once first contract is signed and live.',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the current GA readiness status for all 6 requirements.
 * Order matches docs/GA_READINESS.md.
 */
export function checkGAReadiness(): GARequirement[] {
  return [
    checkPentest(),
    checkDrDrill(),
    checkLoadTest(),
    checkSloSignOff(),
    checkLegalPages(),
    checkFirstPayingCustomer(),
  ];
}

/**
 * Returns true only when every requirement has status 'pass'.
 */
export function isGAReady(requirements: GARequirement[]): boolean {
  return requirements.every(r => r.status === 'pass');
}
