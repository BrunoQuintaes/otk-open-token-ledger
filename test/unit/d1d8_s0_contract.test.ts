/**
 * S0 (run 20260930-1625): the shared D1–D8 contract compiles, exposes no operational stub and
 * every tracked path has exactly one owner under the frozen ownership rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contract from '../../src/types/d1d8/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tool = path.join(root, 'scripts', 'ops', 'd1d8_ownership.mjs');
const run = (...args: string[]) => execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: 'utf8' });

test('contract exports only frozen constants (no functions that could answer success)', () => {
  const functions = Object.entries(contract).filter(([, v]) => typeof v === 'function').map(([k]) => k);
  assert.deepEqual(functions, []);
  assert.equal(contract.D1D8_INTERFACES_VERSION, 'd1d8-interfaces-1.4.0'); // v1.4: OVERNIGHT 20261005 (digest v2, attribution)
  assert.ok(Object.isFrozen(contract.D1D8_SCHEMA_IDS));
  const ids = Object.values(contract.D1D8_SCHEMA_IDS);
  assert.equal(new Set(ids).size, ids.length, 'schema ids are unique');
});

test('quota rule constant names the preserved crossing policy', () => {
  assert.equal(contract.D1D8_QUOTA_ADMISSION_RULE, 'check_before_crossing_admitted@1');
  assert.equal(contract.D1D8_MONEY_ADMISSION_RULE, 'strict_ceiling_worst_case@1');
});

test('ownership: representative paths map to the documented owner', () => {
  const expect: Record<string, string> = {
    'src/types/d1d8/common.ts': 'S0',
    'package-lock.json': 'S0',
    'tools/hardhat/package.json': 'S0',
    'tools/hardhat/contracts/ReceiptRegistryV2.sol': 'A',
    'zk/circuits/metering_v2.circom': 'A',
    'src/receipt/canonicalReceiptV2.ts': 'A',
    'src/metering/SignatureManager.ts': 'A',
    'src/metering/OracleAttestationEngine.ts': 'B',
    'src/proxy/UsageExtractor.ts': 'B',
    'src/proxy/StreamTapper.ts': 'B',
    'src/economics/CUEngine.ts': 'B',
    'src/economics/ReconciliationSystem.ts': 'C',
    'src/pricing/economics/CostReconciliation.ts': 'C',
    'src/pricing/PricingEngineV2.ts': 'B',
    'src/proxy/ProxyGateway.ts': 'C',
    'src/security/RedisTAL.ts': 'C',
    'src/billing/meteringQuota.ts': 'C',
    'src/prover/onChainSubmission.ts': 'C',
    'scripts/migrations/100_operations.sql': 'C',
    'scripts/pilot/anthropic/runPilot.ts': 'S4',
    'test/unit/d1d8_a_binding.test.ts': 'A',
    'test/integration/d1d8_c_quota.test.ts': 'C',
    'test/fixtures/d1d8/common_vectors.json': 'B',
    'docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/B/CHECKPOINT.md': 'B',
    'docs/_ops/correcoes/TRACKER_R01_R34.md': 'S0',
    'dissertacao': 'AUTHOR',
    'zk/circuits/circomlib': 'FROZEN',
    'some/unknown/new_file.txt': 'S0',
  };
  const out = run('owner', ...Object.keys(expect));
  const got = Object.fromEntries(out.trim().split('\n').map((l) => { const [p, o] = l.split('\t'); return [p, o]; }));
  assert.deepEqual(got, expect);
});

test('ownership: every tracked path resolves to a known owner', () => {
  const rows = run('table').trim().split('\n').slice(1);
  assert.ok(rows.length > 1000, `expected the full tracked tree, got ${rows.length}`);
  const owners = new Set(rows.map((r) => r.split('\t')[1]));
  for (const o of owners) assert.ok(['S0', 'S4', 'A', 'B', 'C', 'AUTHOR', 'FROZEN'].includes(o!), `unknown owner ${o}`);
  assert.ok(!rows.some((r) => r.split('\t')[2] === '(none)'), 'no path without rule');
});
