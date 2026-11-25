/**
 * RV2-RUNS-02 (second adversarial review pass of RUN-S, 2026-10-10; MEDIUM). After RV-RUNS-05 the auth guard treated
 * every NODE_ENV except development/dev/test as deployed, but eleven other checks still compared NODE_ENV with the exact
 * string 'production': PostgreSQL TLS (4 places), the CSRF secret requirement, test-only registry/store resets, the CW
 * runtime reset and the SSO stubs. With NODE_ENV=staging (the Helm staging value) PostgreSQL connected without TLS and
 * the CSRF secret fell back to a random per-process value. All of them now use src/infra/deployEnv.ts.
 *
 * Modules under test: `isDeployedEnv` from `src/infra/deployEnv.ts`, `isProductionEnv` from
 * `src/api/productionGuard.ts`, and the test-only resets in `src/api/tenantKeyRegistry.ts` and
 * `src/economics/cwRuntime.ts`; two cases are static scans of source text under `src/`.
 *
 * Strategy / partitions: no file under `src/` compares the environment name with one exact
 * string; both rules agree for production, staging, mixed case, short names, development, test
 * and empty values; the resets refuse in staging; each database pool factory takes its TLS
 * setting from the shared rule.
 *
 * Needs: read access to `src/`. Changes `NODE_ENV` in `process.env` and restores the original
 * value after each test. No network or database.
 *
 * Run just this file: `npx tsx --test test/unit/deploy_env_rule.test.ts`
 *
 * @module test/unit/deploy_env_rule.test
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeployedEnv } from '../../src/infra/deployEnv.js';
import { isProductionEnv } from '../../src/api/productionGuard.js';
import { clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { resetCWRuntime } from '../../src/economics/cwRuntime.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out); else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
let orig: string | undefined = process.env['NODE_ENV'];
afterEach(() => { if (orig === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = orig; });

describe('RV2-RUNS-02: one deployed-environment rule in the whole runtime', () => {
  it('no source file compares NODE_ENV with an exact production string', () => {
    const offenders: string[] = [];
    for (const f of srcFiles(path.join(ROOT, 'src'))) {
      const t = fs.readFileSync(f, 'utf-8');
      if (/NODE_ENV['"`\]]*\s*[!=]==?\s*['"`]production['"`]/.test(t) || /['"`]production['"`]\s*[!=]==?\s*process\.env/.test(t)) offenders.push(path.relative(ROOT, f));
    }
    assert.deepEqual(offenders, []);
  });
  it('the auth guard and the shared rule agree', () => {
    for (const v of ['production', 'staging', 'Production', 'prod', 'qa', 'development', 'dev', 'test', '']) {
      process.env['NODE_ENV'] = v;
      assert.equal(isProductionEnv(), isDeployedEnv(), v);
    }
  });
  it('test-only resets refuse in staging (they used to run there)', () => {
    process.env['NODE_ENV'] = 'staging';
    assert.throws(() => clearRegistry(), /not permitted in production/);
    assert.throws(() => clearHashRegistryForTest(), /not permitted in production/);
    assert.throws(() => resetCWRuntime(), /not permitted in production/);
  });
  it('PostgreSQL TLS follows the shared rule in every pool factory (static check)', () => {
    for (const f of ['src/api/receiptStore.ts', 'src/archive/ReceiptArchive.ts', 'src/infra/storeBootstrap.ts', 'src/operations/runtime.ts']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf-8');
      assert.match(t, /isDeployedEnv\(\) \? \{ rejectUnauthorized: true \}/, f);
    }
  });
});
