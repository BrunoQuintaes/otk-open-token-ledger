/**
 * G3 — Oracle surface behavioral tests
 *
 * Validates the reference oracle contract:
 *   - evaluateReferenceRate is pure (injectable clock)
 *   - isFresh reflects staleness window correctly
 *   - DEFAULT_ORACLE_CONFIG is source='fixed'
 *   - getOracleConfig / setOracleConfig / resetOracleConfig singleton works
 *   - evaluateCurrentRate convenience wrapper works
 *
 * Modules under test: `src/oracle/referenceOracle.ts` and the configuration singleton in
 * `src/oracle/oracleRuntime.ts`.
 *
 * Strategy / partitions: a snapshot inside and outside the staleness window, and exactly at the
 * snapshot time (age 0); source and rate copied from the configuration; a non-positive rate
 * (throws); the singleton at its default, after an override, after reset, and used by the
 * current-rate wrapper.
 *
 * Needs: nothing external (the current time is passed in).
 *
 * Run just this file: `npx tsx --test test/unit/oracle_surface.test.ts`
 *
 * @module test/unit/oracle_surface.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateReferenceRate,
  DEFAULT_ORACLE_CONFIG,
  DEFAULT_STALENESS_SECS,
  type ReferenceOracleConfig,
} from '../../src/oracle/referenceOracle.js';
import {
  getOracleConfig,
  setOracleConfig,
  resetOracleConfig,
  evaluateCurrentRate,
} from '../../src/oracle/oracleRuntime.js';

const SNAPSHOT_EPOCH = 1_740_873_600; // 2026-03-02T00:00:00Z

describe('Oracle surface — evaluateReferenceRate (pure)', () => {
  it('returns isFresh=true when snapshot is within staleness window', () => {
    const nowSecs = SNAPSHOT_EPOCH + 3600; // 1h after snapshot
    const out = evaluateReferenceRate(DEFAULT_ORACLE_CONFIG, nowSecs);
    assert.equal(out.isFresh, true);
    assert.equal(out.snapshotAgeSecs, 3600);
  });

  it('returns isFresh=false when snapshot is older than staleness window', () => {
    const nowSecs = SNAPSHOT_EPOCH + DEFAULT_STALENESS_SECS + 1;
    const out = evaluateReferenceRate(DEFAULT_ORACLE_CONFIG, nowSecs);
    assert.equal(out.isFresh, false);
  });

  it('referenceRate.source matches config.source', () => {
    const out = evaluateReferenceRate(DEFAULT_ORACLE_CONFIG, SNAPSHOT_EPOCH);
    assert.equal(out.referenceRate.source, 'fixed');
  });

  it('referenceRate.rate matches config.rate', () => {
    const out = evaluateReferenceRate(DEFAULT_ORACLE_CONFIG, SNAPSHOT_EPOCH);
    assert.equal(out.referenceRate.rate, DEFAULT_ORACLE_CONFIG.rate);
  });

  it('throws on non-positive rate', () => {
    const badConfig: ReferenceOracleConfig = { ...DEFAULT_ORACLE_CONFIG, rate: 0 };
    assert.throws(() => evaluateReferenceRate(badConfig, SNAPSHOT_EPOCH), /rate=0 must be > 0/);
  });

  it('snapshotAgeSecs=0 when nowSecs equals snapshotEpoch', () => {
    const out = evaluateReferenceRate(DEFAULT_ORACLE_CONFIG, SNAPSHOT_EPOCH);
    assert.equal(out.snapshotAgeSecs, 0);
    assert.equal(out.isFresh, true);
  });
});

describe('Oracle runtime — singleton', () => {
  beforeEach(() => { resetOracleConfig(); });

  it('getOracleConfig returns DEFAULT_ORACLE_CONFIG initially', () => {
    const cfg = getOracleConfig();
    assert.equal(cfg.pair, 'USD_BRL');
    assert.equal(cfg.source, 'fixed');
  });

  it('setOracleConfig overrides the singleton', () => {
    const custom: ReferenceOracleConfig = {
      pair: 'USD_EUR', rate: 0.92, snapshotEpoch: SNAPSHOT_EPOCH,
      source: 'injected', version: 'test',
    };
    setOracleConfig(custom);
    assert.equal(getOracleConfig().pair, 'USD_EUR');
    assert.equal(getOracleConfig().rate, 0.92);
  });

  it('resetOracleConfig restores DEFAULT_ORACLE_CONFIG', () => {
    setOracleConfig({ ...DEFAULT_ORACLE_CONFIG, pair: 'USD_EUR', source: 'injected' });
    resetOracleConfig();
    assert.equal(getOracleConfig().pair, 'USD_BRL');
    assert.equal(getOracleConfig().source, 'fixed');
  });

  it('evaluateCurrentRate uses active config', () => {
    const out = evaluateCurrentRate(SNAPSHOT_EPOCH);
    assert.equal(out.referenceRate.rate, DEFAULT_ORACLE_CONFIG.rate);
  });
});
