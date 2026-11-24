/**
 * GA Readiness tests — src/api/gaReadinessCheck.ts
 *
 * Verifies the structure and correctness of the GA readiness check module.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { checkGAReadiness, isGAReady } from '../../src/api/gaReadinessCheck.js';
import type { GARequirement } from '../../src/api/gaReadinessCheck.js';

// ─── Resolve project root for file-existence checks ──────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../');

// ─── Structure tests ─────────────────────────────────────────────────────────

describe('checkGAReadiness()', () => {
  test('returns an array of exactly 6 requirements', () => {
    const reqs = checkGAReadiness();
    assert.ok(Array.isArray(reqs), 'result must be an array');
    assert.equal(reqs.length, 6, 'must have exactly 6 GA requirements');
  });

  test('each requirement has id, name, status, and notes', () => {
    const reqs = checkGAReadiness();
    const validStatuses = new Set(['pass', 'pending', 'fail']);

    for (const req of reqs) {
      const label = `requirement "${req.id}"`;
      assert.ok(typeof req.id === 'string' && req.id.length > 0, `${label}: id must be a non-empty string`);
      assert.ok(typeof req.name === 'string' && req.name.length > 0, `${label}: name must be a non-empty string`);
      assert.ok(validStatuses.has(req.status), `${label}: status must be pass|pending|fail, got "${req.status}"`);
      assert.ok(typeof req.notes === 'string' && req.notes.length > 0, `${label}: notes must be a non-empty string`);
    }
  });

  test('requirement ids are unique', () => {
    const reqs = checkGAReadiness();
    const ids = reqs.map(r => r.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'all requirement ids must be unique');
  });

  test('canonical ids are present', () => {
    const reqs = checkGAReadiness();
    const ids = new Set(reqs.map(r => r.id));
    const expected = ['pentest', 'dr_drill', 'load_test', 'slo_signoff', 'legal_pages', 'first_paying_customer'];
    for (const id of expected) {
      assert.ok(ids.has(id), `expected requirement id "${id}" to be present`);
    }
  });
});

// ─── Legal pages check ───────────────────────────────────────────────────────

describe('GA-5 legal_pages requirement', () => {
  test('returns status "pass" since legal routes are wired', () => {
    const reqs = checkGAReadiness();
    const legal = reqs.find(r => r.id === 'legal_pages');
    assert.ok(legal !== undefined, '"legal_pages" requirement must exist');
    assert.equal(legal!.status, 'pass', 'legal pages should return pass — routes are wired in routes.ts');
  });

  test('notes mention the three legal routes', () => {
    const reqs = checkGAReadiness();
    const legal = reqs.find(r => r.id === 'legal_pages')!;
    assert.ok(legal.notes.includes('/terms'), 'notes should reference /terms route');
    assert.ok(legal.notes.includes('/privacy'), 'notes should reference /privacy route');
    assert.ok(legal.notes.includes('/dpa'), 'notes should reference /dpa route');
  });
});

// ─── Pending requirements ────────────────────────────────────────────────────

describe('human-gated requirements', () => {
  const pendingIds = ['pentest', 'dr_drill', 'load_test', 'slo_signoff', 'first_paying_customer'];

  for (const id of pendingIds) {
    test(`"${id}" is pending (requires human action)`, () => {
      const reqs = checkGAReadiness();
      const req  = reqs.find(r => r.id === id);
      assert.ok(req !== undefined, `requirement "${id}" must exist`);
      assert.equal(req!.status, 'pending', `"${id}" must be pending until human sign-off`);
    });
  }
});

// ─── isGAReady() ─────────────────────────────────────────────────────────────

describe('isGAReady()', () => {
  test('returns false when any requirement is pending', () => {
    const reqs = checkGAReadiness();
    // Current state: only legal_pages is pass, rest are pending
    assert.equal(isGAReady(reqs), false, 'GA must not be ready while sign-offs are pending');
  });

  test('returns true when all requirements are pass', () => {
    const allPass: GARequirement[] = [
      { id: 'pentest',               name: 'Pentest',    status: 'pass', notes: 'ok' },
      { id: 'dr_drill',              name: 'DR Drill',   status: 'pass', notes: 'ok' },
      { id: 'load_test',             name: 'Load Test',  status: 'pass', notes: 'ok' },
      { id: 'slo_signoff',           name: 'SLO',        status: 'pass', notes: 'ok' },
      { id: 'legal_pages',           name: 'Legal',      status: 'pass', notes: 'ok' },
      { id: 'first_paying_customer', name: 'Customer',   status: 'pass', notes: 'ok' },
    ];
    assert.equal(isGAReady(allPass), true, 'GA must be ready when all requirements pass');
  });

  test('returns false when any requirement is fail', () => {
    const withFail: GARequirement[] = [
      { id: 'pentest',               name: 'Pentest',    status: 'pass', notes: 'ok' },
      { id: 'dr_drill',              name: 'DR Drill',   status: 'fail', notes: 'oops' },
      { id: 'load_test',             name: 'Load Test',  status: 'pass', notes: 'ok' },
      { id: 'slo_signoff',           name: 'SLO',        status: 'pass', notes: 'ok' },
      { id: 'legal_pages',           name: 'Legal',      status: 'pass', notes: 'ok' },
      { id: 'first_paying_customer', name: 'Customer',   status: 'pass', notes: 'ok' },
    ];
    assert.equal(isGAReady(withFail), false, 'GA must not be ready when a requirement fails');
  });
});

// ─── File-existence checks ───────────────────────────────────────────────────

describe('GA infrastructure files exist', () => {
  test('load_test.js script exists', () => {
    const p = resolve(PROJECT_ROOT, 'scripts/ops/load_test.js');
    assert.ok(existsSync(p), `load_test.js not found at ${p}`);
  });

  test('dr_drill.sh script exists', () => {
    const p = resolve(PROJECT_ROOT, 'scripts/ops/dr_drill.sh');
    assert.ok(existsSync(p), `dr_drill.sh not found at ${p}`);
  });

  test('GA_READINESS.md doc exists', () => {
    const p = resolve(PROJECT_ROOT, 'docs/GA_READINESS.md');
    assert.ok(existsSync(p), `GA_READINESS.md not found at ${p}`);
  });
});
