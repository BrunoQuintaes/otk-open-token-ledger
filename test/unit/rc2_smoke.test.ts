/**
 * RC2 — Release Candidate smoke tests
 *
 * Validates that the project is in a releasable state by checking:
 *   1. Canonical files required by CLAUDE.md Section 10 all exist
 *   2. Core source modules (SDK, CUEngine, SignatureManager) are present
 *   3. ZK ceremony artifacts exist (MPC proving key + vkey)
 *   4. Deployment scripts and release artifacts exist
 *   5. ROADMAP_UNIFIED.md contains all pack completion entries (F1–G4)
 *   6. docs/_ops/ evidence directories are present (append-only trail)
 *
 * These tests are the programmatic equivalent of the rc2_release_checklist.md.
 * No I/O to live systems — purely file system assertions.
 *
 * Under test: the repository layout (no source module is imported); files are checked by path relative to the
 * repository root found from this file's location.
 *
 * Strategy / partitions: one existence check per required file or directory, grouped as above; the agent
 * instructions file may instead be declared as excluded by the manifest of the academic package.
 *
 * Needs: only the file system (read only).
 *
 * Run just this file: `npx tsx --test test/unit/rc2_smoke.test.ts`
 *
 * @module test/unit/rc2_smoke.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// ---------------------------------------------------------------------------
// Canonical governance files
// ---------------------------------------------------------------------------

// PKG-03 (RUN-M1-RESUME-R2-20261012): the academic package excludes CLAUDE.md (internal agent instructions) by design and
// lists it in the package MANIFEST.json (one level above source/). There the check is that the exclusion is DECLARED;
// an undeclared absence still fails. Before this, the package run carried one "expected failure" for this test.
function excludedByAcademicPackage(rel: string): boolean {
  const manifest = path.join(ROOT, '..', 'MANIFEST.json');
  if (!fs.existsSync(manifest)) return false;
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { schema?: string; excluded?: unknown };
    return m.schema === 'otk.academic_release_manifest.v2' && Array.isArray(m.excluded) && m.excluded.includes(rel);
  } catch { return false; }
}

describe('RC2 — Canonical governance files', () => {
  it('CLAUDE.md exists (or its exclusion is declared by the academic package manifest)', () => {
    assert.ok(exists('CLAUDE.md') || excludedByAcademicPackage('CLAUDE.md'),
      'CLAUDE.md not found and not declared as excluded by an academic package MANIFEST.json');
  });

  it('docs/DOCS_INDEX.md exists', () => {
    assert.ok(exists('docs/DOCS_INDEX.md'), 'DOCS_INDEX.md not found');
  });

  it('docs/ROADMAP_UNIFIED.md exists', () => {
    assert.ok(exists('docs/ROADMAP_UNIFIED.md'));
  });

  it('docs/_canonical/CORE.md exists', () => {
    assert.ok(exists('docs/_canonical/CORE.md'), 'CORE.md not found');
  });
});

// ---------------------------------------------------------------------------
// Core source modules (must be untouched by G1-RC2 packs)
// ---------------------------------------------------------------------------

describe('RC2 — Core source modules present', () => {
  it('src/sdk/OTKSDK.ts exists', () => {
    assert.ok(exists('src/sdk/OTKSDK.ts'));
  });

  it('src/economics/CUEngine.ts exists', () => {
    assert.ok(exists('src/economics/CUEngine.ts'));
  });

  it('src/metering/SignatureManager.ts exists', () => {
    assert.ok(exists('src/metering/SignatureManager.ts'));
  });
});

// ---------------------------------------------------------------------------
// ZK ceremony artifacts
// ---------------------------------------------------------------------------

describe('RC2 — ZK ceremony artifacts', () => {
  it('metering_v2_final_mpc.zkey exists (MPC proving key)', () => {
    assert.ok(exists('zk/keys/metering_v2_final_mpc.zkey'), 'MPC proving key missing');
  });

  it('metering_v2_vkey_mpc.json exists (MPC verification key)', () => {
    assert.ok(exists('zk/keys/metering_v2_vkey_mpc.json'), 'MPC verification key missing');
  });

  it('zk/ceremony/state.json exists (ceremony state)', () => {
    assert.ok(exists('zk/ceremony/state.json'), 'ceremony state.json missing');
  });
});

// ---------------------------------------------------------------------------
// Release + runbook artifacts
// ---------------------------------------------------------------------------

describe('RC2 — Release artifacts', () => {
  it('docs/release/rc2_release_checklist.md exists', () => {
    assert.ok(exists('docs/release/rc2_release_checklist.md'));
  });

  it('docs/runbooks/rc2_run_from_zero.md exists', () => {
    assert.ok(exists('docs/runbooks/rc2_run_from_zero.md'));
  });

  it('scripts/ops/rc2_run_from_zero.sh exists', () => {
    assert.ok(exists('scripts/ops/rc2_run_from_zero.sh'));
  });

  it('scripts/ops/rc2_final_audit.sh exists', () => {
    assert.ok(exists('scripts/ops/rc2_final_audit.sh'));
  });
});

// ---------------------------------------------------------------------------
// ROADMAP completeness
// ---------------------------------------------------------------------------

describe('RC2 — ROADMAP completeness', () => {
  it('ROADMAP contains all F1-F4 + G1-G4 pack entries', () => {
    const roadmap = readFile('docs/ROADMAP_UNIFIED.md');
    for (const pack of ['PACK-F1', 'PACK-F2', 'PACK-F3', 'PACK-F4', 'PACK-G1', 'PACK-G2', 'PACK-G3', 'PACK-G4']) {
      assert.ok(roadmap.includes(pack), `${pack} missing from ROADMAP`);
    }
  });
});

// ---------------------------------------------------------------------------
// docs/_ops/ append-only evidence trail
// ---------------------------------------------------------------------------

describe('RC2 — Evidence trail (docs/_ops/)', () => {
  it('all expected EVD phase dirs exist', () => {
    for (const dir of ['f1', 'f2', 'f3', 'f4', 'g1', 'g2', 'g3', 'g4', 'rc2', 'revalidation']) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'docs', '_ops', dir)),
        `docs/_ops/${dir} missing`,
      );
    }
  });
});
