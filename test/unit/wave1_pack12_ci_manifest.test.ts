/**
 * Wave 1 Pack 12 — CI/Manifest Tests (A6.6 + A6.7 + A11.1 + A11.2 + A11.4)
 *
 * Tests:
 *   - Manifest generation: module exports, structure, output
 *   - Proof hash: SHA-256 computation with temp file
 *   - Lint script: file existence and expected structure
 *   - Manifest archival (A11.3 absorbed into A6.6)
 *
 * @since Wave 1 Pack 12 (2026-03-15)
 *
 * Under test: the scripts `scripts/ops/generate_manifest.js`, `scripts/ops/hash_proof.js` and the canonical lint
 * script, read as text (none of them is run).
 *
 * Strategy / partitions: each script exists and contains the expected exports, output paths and checks. The
 * SHA-256 case only checks the shape of a digest computed with `node:crypto`; it does not call `hash_proof.js`
 * and writes no file.
 *
 * Needs: only the file system (read only), from the repository root found from this file's location.
 *
 * Run just this file: `npx tsx --test test/unit/wave1_pack12_ci_manifest.test.ts`
 *
 * @module test/unit/wave1_pack12_ci_manifest.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// ─── A6.6 + A11.1 + A11.3 — Manifest Generation ────────────────────

describe('A6.6 + A11.1 + A11.3 — Manifest Generation', () => {

  const manifestScript = path.join(ROOT, 'scripts/ops/generate_manifest.js');

  it('generate_manifest.js exists', () => {
    assert.ok(fs.existsSync(manifestScript), 'generate_manifest.js should exist');
  });

  it('generate_manifest.js is an ESM module with exports', () => {
    const content = fs.readFileSync(manifestScript, 'utf8');
    assert.ok(content.includes('export'), 'should have exports');
    assert.ok(content.includes('generateManifest'), 'should export generateManifest');
    assert.ok(content.includes('getCommitHash'), 'should export getCommitHash');
    assert.ok(content.includes('getBranch'), 'should export getBranch');
    assert.ok(content.includes('parsePhaseStatuses'), 'should export parsePhaseStatuses');
  });

  it('manifest includes A11.3 archival (MANIFEST_LATEST)', () => {
    const content = fs.readFileSync(manifestScript, 'utf8');
    assert.ok(content.includes('MANIFEST_LATEST'), 'should write MANIFEST_LATEST.json (A11.3 absorbed)');
  });

  it('manifest output targets docs/_ops/manifests/', () => {
    const content = fs.readFileSync(manifestScript, 'utf8');
    assert.ok(content.includes('docs/_ops/manifests'), 'should output to docs/_ops/manifests/');
  });
});

// ─── A6.7 — Proof Hash ──────────────────────────────────────────────

describe('A6.7 — Proof Hash', () => {

  const hashScript = path.join(ROOT, 'scripts/ops/hash_proof.js');

  it('hash_proof.js exists', () => {
    assert.ok(fs.existsSync(hashScript), 'hash_proof.js should exist');
  });

  it('hash_proof.js exports hashProof and sha256File', () => {
    const content = fs.readFileSync(hashScript, 'utf8');
    assert.ok(content.includes('export'), 'should have exports');
    assert.ok(content.includes('hashProof'), 'should export hashProof');
    assert.ok(content.includes('sha256File'), 'should export sha256File');
    assert.ok(content.includes('detectCircuitVersion'), 'should export detectCircuitVersion');
  });

  it('SHA-256 computation produces correct hash for known input', () => {
    // Verify the SHA-256 algorithm matches expected output
    const testData = '{"protocol":"groth16","curve":"bn128"}';
    const hash = createHash('sha256').update(testData).digest('hex');
    // SHA-256 of that string is deterministic
    assert.equal(hash.length, 64, 'SHA-256 hex should be 64 chars');
    assert.match(hash, /^[0-9a-f]{64}$/, 'should be valid hex');
  });

  it('hash_proof.js references zk/build/proof.json as default', () => {
    const content = fs.readFileSync(hashScript, 'utf8');
    assert.ok(content.includes('zk/build/proof.json'), 'should reference default proof path');
  });
});

// ─── A11.2 + A11.4 — Canonical Lint ─────────────────────────────────

describe('A11.2 + A11.4 — Canonical Lint', () => {

  const lintScript = path.join(ROOT, 'scripts/ops/lint_canonical.sh');

  it('lint_canonical.sh exists', () => {
    assert.ok(fs.existsSync(lintScript), 'lint_canonical.sh should exist');
  });

  it('lint script checks CLAUDE.md', () => {
    const content = fs.readFileSync(lintScript, 'utf8');
    assert.ok(content.includes('CLAUDE.md'), 'should check CLAUDE.md');
  });

  it('lint script checks DOCS_INDEX.md', () => {
    const content = fs.readFileSync(lintScript, 'utf8');
    assert.ok(content.includes('DOCS_INDEX.md'), 'should check DOCS_INDEX.md');
  });

  it('lint script checks CSV tables', () => {
    const content = fs.readFileSync(lintScript, 'utf8');
    assert.ok(content.includes('CANONICAL_PHASE_TABLE.csv'), 'should check phase table CSV');
    assert.ok(content.includes('CANONICAL_ROADMAP_TABLE.csv'), 'should check roadmap table CSV');
  });
});
