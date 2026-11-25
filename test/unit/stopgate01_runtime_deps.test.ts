/**
 * STOPGATE-01 P2.1 (R2-D2 / H1R2 lane C3): every package imported by production code (src/) is a production dependency.
 *
 * Before: snarkjs and circomlibjs were imported by src/prover/*, src/zk/batch/* and src/zk/v3/* but declared in
 * devDependencies, so `npm ci --omit=dev` (which skips every lockfile entry flagged "dev": true) produced an install in
 * which the prover and ZK v3 could not load. The images install devDependencies on purpose (tsx is the runtime loader),
 * which hid the mismatch. The check is static: package.json and package-lock.json, no network.
 *
 * Under test: the dependency declarations in `package.json` and `package-lock.json` against the packages
 * imported by the code under `src/` (no source module is imported; the files are scanned as text).
 *
 * Strategy / partitions: the scan finds the known runtime imports (so an empty scan cannot pass); every
 * imported package is a production dependency, except the optional SSO packages loaded with a guarded dynamic
 * import; no lockfile entry of a runtime import is marked dev; the ZK library versions did not change.
 *
 * Needs: only the file system (read only), from the repository root found from this file's location.
 *
 * Run just this file: `npx tsx --test test/unit/stopgate01_runtime_deps.test.ts`
 *
 * @module test/unit/stopgate01_runtime_deps.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const builtin = new Set(builtinModules);

/** Loaded with a guarded dynamic import and a documented stub fallback when absent (SSO is optional). */
const OPTIONAL_GUARDED: Record<string, string> = {
  'openid-client': 'src/auth/sso/OidcProvider.ts: dynamic import in try/catch, stub result without it',
  '@node-saml/node-saml': 'src/auth/sso/SamlProvider.ts: dynamic import in try/catch, stub validation without it',
};

function srcImports(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e.name)) {
        const s = fs.readFileSync(p, 'utf8');
        const re = /(?:^|\n)\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+[^;]*?from\s+['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s))) {
          if (m[1]) continue; // type-only import: erased at runtime
          const spec = m[2] ?? m[3] ?? m[4] ?? m[5];
          if (!spec || spec.startsWith('.') || spec.startsWith('node:') || builtin.has(spec)) continue;
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
          if (!found.has(name)) found.set(name, new Set());
          found.get(name)!.add(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return found;
}

describe('STOPGATE-01 P2.1: runtime imports are production dependencies', () => {
  const imports = srcImports();

  it('the scan sees the known runtime imports (guard against a silently empty scan)', () => {
    for (const n of ['ethers', 'pg', 'snarkjs', 'circomlibjs']) assert.ok(imports.has(n), `scan should find ${n}`);
  });

  it('every package imported by src/ is in dependencies (optional guarded imports excepted)', () => {
    const wrong = [...imports.keys()].filter((n) => !OPTIONAL_GUARDED[n] && !pkg.dependencies?.[n])
      .map((n) => `${n} (${pkg.devDependencies?.[n] ? 'devDependencies' : 'missing'}; ${[...imports.get(n)!].join(', ')})`);
    assert.deepEqual(wrong, []);
  });

  it('npm ci --omit=dev keeps them: no lockfile entry of a runtime import is flagged dev', () => {
    const dev = [...imports.keys()].filter((n) => !OPTIONAL_GUARDED[n]).filter((n) => lock.packages?.[`node_modules/${n}`]?.dev === true);
    assert.deepEqual(dev, []);
    assert.equal(lock.packages?.['']?.dependencies?.snarkjs, pkg.dependencies.snarkjs, 'lockfile root agrees with package.json');
  });

  it('the reclassification did not change the ZK library versions (proof semantics unchanged)', () => {
    assert.equal(lock.packages['node_modules/snarkjs'].version, '0.7.6');
    assert.equal(lock.packages['node_modules/circomlibjs'].version, '0.1.7');
  });
});
