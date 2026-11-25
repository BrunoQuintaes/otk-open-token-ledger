/**
 * F2 — Compliance behavioral tests
 *
 * Validates:
 *   - ComplianceProfile presets have expected values
 *   - minimizeEvent produces correct output per mode (full / aggregate / redacted)
 *   - RetentionPolicy hints map to correct purgeable/maxAgeSecs
 *   - toComplianceAuditRecord bridges minimized event → AuditRecord
 *
 * Module under test: the privacy exports of `src/privacy/index.ts`.
 *
 * Strategy / partitions: the three presets (DEFAULT, STRICT, AUDIT); event minimization in full,
 * aggregate and redacted mode (which fields survive, which are removed or masked); each
 * retention class (ephemeral, short term, long term, permanent) and whether it is purgeable;
 * the audit record built from a minimized event in each mode.
 *
 * Needs: nothing external (one in-memory usage event from `evt()`).
 *
 * Run just this file: `npx tsx --test test/unit/compliance.test.ts`
 *
 * @module test/unit/compliance.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLIANCE_PROFILES,
  minimizeEvent,
  toComplianceAuditRecord,
  getRetentionPolicy,
  isPurgeable,
} from '../../src/privacy/index.js';
import type { NormalizedUsageEvent } from '../../src/providers/types.js';

function evt(): NormalizedUsageEvent {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    latencyMs: 200,
    costUnits: 600,
    timestamp: 1_700_000_000,
    requestId: 'req-abc-123',
  };
}

// ---------------------------------------------------------------------------
// COMPLIANCE_PROFILES presets
// ---------------------------------------------------------------------------

describe('ComplianceProfiles — presets', () => {
  it('DEFAULT has internal/short_term/full', () => {
    const p = COMPLIANCE_PROFILES.DEFAULT;
    assert.equal(p.dataClass, 'internal');
    assert.equal(p.retentionHint, 'short_term');
    assert.equal(p.minimizationMode, 'full');
  });

  it('STRICT has sensitive/ephemeral/redacted', () => {
    const p = COMPLIANCE_PROFILES.STRICT;
    assert.equal(p.dataClass, 'sensitive');
    assert.equal(p.retentionHint, 'ephemeral');
    assert.equal(p.minimizationMode, 'redacted');
  });

  it('AUDIT has internal/long_term/aggregate', () => {
    const p = COMPLIANCE_PROFILES.AUDIT;
    assert.equal(p.dataClass, 'internal');
    assert.equal(p.retentionHint, 'long_term');
    assert.equal(p.minimizationMode, 'aggregate');
  });
});

// ---------------------------------------------------------------------------
// minimizeEvent
// ---------------------------------------------------------------------------

describe('minimizeEvent — full mode', () => {
  it('preserves requestId and model', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.DEFAULT);
    assert.equal(m.provider, 'openai');
    assert.equal(m.model, 'gpt-4o');
    assert.equal(m.requestId, 'req-abc-123');
    assert.equal(m.totalTokens, 150);
    assert.equal(m.costUnits, 600);
    assert.equal(m.retentionHint, 'short_term');
  });
});

describe('minimizeEvent — aggregate mode', () => {
  it('suppresses requestId, keeps model and tokens', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.AUDIT);
    assert.equal(m.model, 'gpt-4o');
    assert.equal(m.requestId, undefined);
    assert.equal(m.totalTokens, 150);
  });
});

describe('minimizeEvent — redacted mode', () => {
  it('suppresses requestId and redacts model', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.STRICT);
    assert.equal(m.model, '[redacted]');
    assert.equal(m.requestId, undefined);
    assert.equal(m.provider, 'openai');   // provider is kept
    assert.equal(m.totalTokens, 150);
    assert.equal(m.retentionHint, 'ephemeral');
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy
// ---------------------------------------------------------------------------

describe('RetentionPolicy', () => {
  it('ephemeral is purgeable with short maxAgeSecs', () => {
    const p = getRetentionPolicy('ephemeral');
    assert.equal(p.purgeable, true);
    assert.ok(p.maxAgeSecs <= 3_600);
  });

  it('short_term is purgeable', () => {
    assert.equal(isPurgeable('short_term'), true);
  });

  it('long_term is NOT purgeable', () => {
    assert.equal(isPurgeable('long_term'), false);
  });

  it('permanent is NOT purgeable with max maxAgeSecs', () => {
    const p = getRetentionPolicy('permanent');
    assert.equal(p.purgeable, false);
    assert.equal(p.maxAgeSecs, Number.MAX_SAFE_INTEGER);
  });
});

// ---------------------------------------------------------------------------
// toComplianceAuditRecord
// ---------------------------------------------------------------------------

describe('toComplianceAuditRecord', () => {
  it('produces AuditRecord with correct fields (full mode)', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.DEFAULT);
    const rec = toComplianceAuditRecord(m, 'tenant-1', 'user-a', '2026-01-01T00:00:00Z');
    assert.equal(rec.ts, '2026-01-01T00:00:00Z');
    assert.equal(rec.tenantId, 'tenant-1');
    assert.equal(rec.actor, 'user-a');
    assert.equal(rec.action, 'usage_metered');
    assert.equal(rec.meta?.['provider'], 'openai');
    assert.equal(rec.meta?.['model'], 'gpt-4o');
    assert.equal(rec.meta?.['requestId'], 'req-abc-123');
  });

  it('redacted mode: meta has no requestId and model=[redacted]', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.STRICT);
    const rec = toComplianceAuditRecord(m, 'tenant-2', 'svc', '2026-01-01T00:00:00Z');
    assert.equal(rec.meta?.['model'], '[redacted]');
    assert.equal(rec.meta?.['requestId'], undefined);
  });

  it('aggregate mode: meta has no requestId', () => {
    const m = minimizeEvent(evt(), COMPLIANCE_PROFILES.AUDIT);
    const rec = toComplianceAuditRecord(m, 'tenant-3', 'svc', '2026-01-01T00:00:00Z');
    assert.equal(rec.meta?.['requestId'], undefined);
    assert.equal(rec.meta?.['model'], 'gpt-4o');
  });
});
