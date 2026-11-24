/**
 * Wave 2 Pack 18 — P1.6 Quickstart 5-Minute Guide Tests
 *
 * Validates:
 *   - QUICKSTART.md exists
 *   - Expected sections present (10 numbered sections)
 *   - Curl examples present with realistic payloads
 *   - PROVER_URL=disabled documented for local testing
 *
 * @since Wave 2 Pack 18 (2026-03-15)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

describe('P1.6 — Quickstart 5-Minute Guide', () => {

  const quickstartPath = path.join(ROOT, 'docs/QUICKSTART.md');

  it('docs/QUICKSTART.md exists', () => {
    assert.ok(fs.existsSync(quickstartPath), 'docs/QUICKSTART.md should exist');
  });

  it('contains all 10 expected sections', () => {
    const content = fs.readFileSync(quickstartPath, 'utf8');
    assert.ok(content.includes('## 1. Prerequisites'), 'should have Prerequisites section');
    assert.ok(content.includes('## 2. Clone & Install'), 'should have Clone & Install section');
    assert.ok(content.includes('## 3. Run Tests'), 'should have Run Tests section');
    assert.ok(content.includes('## 4. Start the API Server'), 'should have Start the API Server section');
    assert.ok(content.includes('## 5. Submit Your First Receipt'), 'should have Submit Receipt section');
    assert.ok(content.includes('## 6. Check Receipt Status'), 'should have Check Receipt Status section');
    assert.ok(content.includes('## 7. Check Accounting Balance'), 'should have Check Accounting Balance section');
    assert.ok(content.includes('## 8. Check System Health'), 'should have Check System Health section');
    assert.ok(content.includes('## 9. Next Steps'), 'should have Next Steps section');
    assert.ok(content.includes('## 10. Multi-Tenant Mode'), 'should have Multi-Tenant Mode section');
  });

  it('includes curl examples with realistic payloads', () => {
    const content = fs.readFileSync(quickstartPath, 'utf8');
    assert.ok(content.includes('curl'), 'should include curl commands');
    assert.ok(content.includes('POST http://localhost:8787/receipts'), 'should have POST /receipts curl');
    assert.ok(content.includes('/receipts/req-quickstart-001'), 'should have GET /receipts/:id curl');
    assert.ok(content.includes('/accounting/balance'), 'should have GET /accounting/balance curl');
    assert.ok(content.includes('/health'), 'should have GET /health curl');
    assert.ok(content.includes('"requestId"'), 'curl payloads should include requestId');
    assert.ok(content.includes('"provider"'), 'curl payloads should include provider');
    assert.ok(content.includes('Authorization: Bearer'), 'should show Bearer token usage in multi-tenant section');
  });

  it('documents PROVER_URL=disabled for local testing', () => {
    const content = fs.readFileSync(quickstartPath, 'utf8');
    assert.ok(content.includes('PROVER_URL=disabled'), 'should document PROVER_URL=disabled');
    assert.ok(content.includes('skips ZK proof'), 'should explain that PROVER_URL=disabled skips ZK proofs');
  });
});
