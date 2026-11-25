/**
 * Wave 6 tests — NEW-6.01 (Feature Flags) + NEW-6.02 (Changelog) + P5.1 (Evidence Index)
 *
 * Modules under test: `src/features/FeatureFlagService.ts`, `src/dashboard/changelog.ts` (`parseChangelog`)
 * and `src/automation/EvidenceIndexer.ts` (`buildIndex`).
 *
 * Strategy / partitions: flags (create, update, invalid and valid keys, default, unknown flag, tenant override
 * set, created on demand and cleared, delete, sorted list, independent overrides); changelog (empty, one and
 * several versions, no date, other headings, empty sections); evidence index (no evidence directory, files per
 * phase, design files, several phases, skipped directory, sort order, timestamp).
 *
 * Needs: temporary directories for the evidence index cases; no network.
 *
 * Run just this file: `npx tsx --test test/unit/wave6.test.ts`
 *
 * @module test/unit/wave6.test
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── NEW-6.01: FeatureFlagService ────────────────────────────────────────────

import { FeatureFlagService } from '../../src/features/FeatureFlagService.js';

describe('FeatureFlagService', () => {
  let svc: FeatureFlagService;

  beforeEach(() => {
    svc = new FeatureFlagService();
  });

  test('upsert creates flag with global default', () => {
    const flag = svc.upsert('zk.proof.enabled', true, 'Enable ZK proof generation');
    assert.equal(flag.key, 'zk.proof.enabled');
    assert.equal(flag.enabled, true);
    assert.equal(flag.description, 'Enable ZK proof generation');
    assert.deepEqual(flag.overrides, {});
  });

  test('upsert updates existing flag', () => {
    svc.upsert('flag.a', true);
    const updated = svc.upsert('flag.a', false, 'Updated');
    assert.equal(updated.enabled, false);
    assert.equal(updated.description, 'Updated');
  });

  test('upsert rejects invalid key', () => {
    assert.throws(() => svc.upsert('INVALID KEY', true), /Invalid flag key/);
    assert.throws(() => svc.upsert('', true), /Invalid flag key/);
    assert.throws(() => svc.upsert('has space', true), /Invalid flag key/);
  });

  test('valid key formats accepted', () => {
    assert.doesNotThrow(() => svc.upsert('zk.proof.enabled', true));
    assert.doesNotThrow(() => svc.upsert('feature-flag-1', false));
    assert.doesNotThrow(() => svc.upsert('ab', true));
  });

  test('evaluate returns global default when no override', () => {
    svc.upsert('my.flag', true);
    const decision = svc.evaluate('my.flag', 'tenant-1');
    assert.equal(decision.enabled, true);
    assert.equal(decision.source, 'global');
  });

  test('evaluate returns false for unknown flag', () => {
    const decision = svc.evaluate('unknown.flag');
    assert.equal(decision.enabled, false);
    assert.equal(decision.source, 'default');
  });

  test('setOverride applies per-tenant override', () => {
    svc.upsert('my.flag', false); // globally disabled
    svc.setOverride('my.flag', 'tenant-vip', true); // enable for VIP

    const vipDecision = svc.evaluate('my.flag', 'tenant-vip');
    assert.equal(vipDecision.enabled, true);
    assert.equal(vipDecision.source, 'override');

    const regularDecision = svc.evaluate('my.flag', 'tenant-regular');
    assert.equal(regularDecision.enabled, false);
    assert.equal(regularDecision.source, 'global');
  });

  test('setOverride creates flag if missing', () => {
    svc.setOverride('new.flag', 'tenant-x', true);
    assert.equal(svc.evaluate('new.flag', 'tenant-x').enabled, true);
    assert.equal(svc.evaluate('new.flag', 'other-tenant').enabled, false); // global default = false
  });

  test('clearOverride removes per-tenant override, falls back to global', () => {
    svc.upsert('my.flag', false);
    svc.setOverride('my.flag', 'tenant-a', true);
    assert.equal(svc.evaluate('my.flag', 'tenant-a').enabled, true);

    svc.clearOverride('my.flag', 'tenant-a');
    const after = svc.evaluate('my.flag', 'tenant-a');
    assert.equal(after.enabled, false);
    assert.equal(after.source, 'global');
  });

  test('isEnabled convenience method', () => {
    svc.upsert('zk.enabled', true);
    assert.equal(svc.isEnabled('zk.enabled'), true);
    assert.equal(svc.isEnabled('nonexistent'), false);
  });

  test('delete removes flag', () => {
    svc.upsert('to.delete', true);
    assert.equal(svc.size, 1);
    assert.equal(svc.delete('to.delete'), true);
    assert.equal(svc.size, 0);
    assert.equal(svc.get('to.delete'), undefined);
  });

  test('list returns sorted flags', () => {
    svc.upsert('zzz.flag', true);
    svc.upsert('aaa.flag', false);
    svc.upsert('mmm.flag', true);
    const keys = svc.list().map(f => f.key);
    assert.deepEqual(keys, ['aaa.flag', 'mmm.flag', 'zzz.flag']);
  });

  test('multiple overrides per flag work independently', () => {
    svc.upsert('beta.feature', false);
    svc.setOverride('beta.feature', 'tenant-a', true);
    svc.setOverride('beta.feature', 'tenant-b', false);
    svc.setOverride('beta.feature', 'tenant-c', true);

    assert.equal(svc.evaluate('beta.feature', 'tenant-a').enabled, true);
    assert.equal(svc.evaluate('beta.feature', 'tenant-b').enabled, false);
    assert.equal(svc.evaluate('beta.feature', 'tenant-c').enabled, true);
    assert.equal(svc.evaluate('beta.feature', 'tenant-d').enabled, false); // falls to global
  });
});

// ─── NEW-6.02: Changelog Parser ──────────────────────────────────────────────

import { parseChangelog } from '../../src/dashboard/changelog.js';

describe('parseChangelog', () => {
  test('parses empty string to empty array', () => {
    assert.deepEqual(parseChangelog(''), []);
  });

  test('parses single version block', () => {
    const raw = `## [1.0.0] - 2026-01-01

### Added
- Feature A
- Feature B

### Fixed
- Bug fix C
`;
    const entries = parseChangelog(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, '1.0.0');
    assert.equal(entries[0].date, '2026-01-01');
    assert.deepEqual(entries[0].sections['Added'], ['Feature A', 'Feature B']);
    assert.deepEqual(entries[0].sections['Fixed'], ['Bug fix C']);
  });

  test('parses multiple version blocks', () => {
    const raw = `## [2.0.0] - 2026-03-01

### Breaking
- Removed old API

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;
    const entries = parseChangelog(raw);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].version, '2.0.0');
    assert.equal(entries[1].version, '1.0.0');
  });

  test('handles version without date', () => {
    const raw = `## 1.2.3

### Changed
- Something changed
`;
    const entries = parseChangelog(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, '1.2.3');
    assert.equal(entries[0].date, null);
  });

  test('skips non-version headings', () => {
    const raw = `# Main Title

Some intro text.

## [1.0.0] - 2026-01-01

### Added
- Item
`;
    const entries = parseChangelog(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, '1.0.0');
  });

  test('handles empty sections gracefully', () => {
    const raw = `## [1.0.0] - 2026-01-01
`;
    const entries = parseChangelog(raw);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].sections, {});
  });
});

// ─── P5.1: EvidenceIndexer ───────────────────────────────────────────────────

import { buildIndex } from '../../src/automation/EvidenceIndexer.js';

describe('EvidenceIndexer.buildIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'otk-evd-test-'));
  });

  test('returns empty index when _ops dir missing', () => {
    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 0);
    assert.deepEqual(idx.evds, []);
    assert.ok(idx.generatedAt);
  });

  test('detects EVDs under phase directories', () => {
    // Create: docs/_ops/wave6/W6_PACK01_20260404/
    const opsDir = join(tmpDir, 'docs', '_ops');
    const evdDir = join(opsDir, 'wave6', 'W6_PACK01_20260404');
    mkdirSync(evdDir, { recursive: true });
    writeFileSync(join(evdDir, '00_context.txt'), 'context');
    writeFileSync(join(evdDir, '05_tests.txt'), 'tests output');

    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 1);
    const evd = idx.evds[0];
    assert.equal(evd.name, 'W6_PACK01_20260404');
    assert.equal(evd.phase, 'wave6');
    assert.ok(evd.files.includes('00_context.txt'));
    assert.ok(evd.files.includes('05_tests.txt'));
    assert.equal(evd.hasTests, true);
    assert.equal(evd.hasGateR0, false);
    assert.equal(evd.hasDesign, false);
  });

  test('detects gate_r0 and design files', () => {
    const evdDir = join(tmpDir, 'docs', '_ops', 'u6', 'U6_GATE_20260101');
    mkdirSync(evdDir, { recursive: true });
    writeFileSync(join(evdDir, '06_gate_r0.txt'), 'GO');
    writeFileSync(join(evdDir, '01_design.md'), '# Design');

    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 1);
    assert.equal(idx.evds[0].hasGateR0, true);
    assert.equal(idx.evds[0].hasDesign, true);
  });

  test('detects multiple EVDs across phases', () => {
    const opsDir = join(tmpDir, 'docs', '_ops');
    for (const [phase, evd] of [['wave5', 'W5_PACK01'], ['wave6', 'W6_PACK01'], ['u6', 'U6_GATE']]) {
      const dir = join(opsDir, phase, evd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'readme.txt'), 'test');
    }

    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 3);
    const phases = idx.evds.map(e => e.phase).sort();
    assert.deepEqual(phases, ['u6', 'wave5', 'wave6']);
  });

  test('skips patterns directory', () => {
    const opsDir = join(tmpDir, 'docs', '_ops');
    mkdirSync(join(opsDir, 'patterns', 'some-pattern'), { recursive: true });
    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 0); // patterns skipped
  });

  test('EVDs are sorted by path', () => {
    const opsDir = join(tmpDir, 'docs', '_ops');
    mkdirSync(join(opsDir, 'wave6', 'B_PACK'), { recursive: true });
    mkdirSync(join(opsDir, 'wave5', 'A_PACK'), { recursive: true });
    writeFileSync(join(opsDir, 'wave6', 'B_PACK', 'f.txt'), '');
    writeFileSync(join(opsDir, 'wave5', 'A_PACK', 'f.txt'), '');

    const idx = buildIndex(tmpDir);
    assert.equal(idx.totalEvds, 2);
    // Should be sorted: wave5/A_PACK before wave6/B_PACK
    assert.ok(idx.evds[0].path < idx.evds[1].path);
  });

  test('index includes generatedAt timestamp', () => {
    const before = Date.now();
    const idx = buildIndex(tmpDir);
    const after = Date.now();
    const ts = new Date(idx.generatedAt).getTime();
    assert.ok(ts >= before && ts <= after);
  });
});
