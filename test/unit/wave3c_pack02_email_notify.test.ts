/**
 * Wave 3C Pack 02 — Email + Notification Backbone Tests (NEW-3.07 + NEW-3.08)
 *
 * Tests:
 *   1. ConsoleEmailAdapter logs emails
 *   2. Email templates generate correct content
 *   3. NotificationService routes events to channels
 *   4. Event lifecycle triggers notifications
 *   5. File structure
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ===========================================================================
// ConsoleEmailAdapter (NEW-3.07)
// ===========================================================================

import { ConsoleEmailAdapter } from '../../src/email/ConsoleEmailAdapter.js';

describe('W3C-02 — ConsoleEmailAdapter (NEW-3.07)', () => {
  it('send returns ok:true with messageId', async () => {
    const adapter = new ConsoleEmailAdapter();
    const result = await adapter.send({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
    });
    assert.ok(result.ok, 'send should return ok');
    assert.ok(result.messageId, 'should have messageId');
    assert.ok(result.messageId!.startsWith('console-'), 'messageId should have console prefix');
  });

  it('tracks sent messages for testing', async () => {
    const adapter = new ConsoleEmailAdapter();
    await adapter.send({ to: 'a@b.com', subject: 'S1', html: '<p>1</p>' });
    await adapter.send({ to: 'c@d.com', subject: 'S2', html: '<p>2</p>' });
    assert.equal(adapter.sent.length, 2);
    assert.equal(adapter.sent[0].to, 'a@b.com');
    assert.equal(adapter.sent[1].subject, 'S2');
  });

  it('clear removes tracked messages', async () => {
    const adapter = new ConsoleEmailAdapter();
    await adapter.send({ to: 'x@y.com', subject: 'X', html: '<p>x</p>' });
    adapter.clear();
    assert.equal(adapter.sent.length, 0);
  });
});

// ===========================================================================
// Email Templates (NEW-3.07)
// ===========================================================================

import { keyCreatedTemplate, keyRevokedTemplate, keyRotatedTemplate, welcomeTemplate } from '../../src/email/templates.js';

describe('W3C-02 — Email templates', () => {
  it('keyCreatedTemplate generates subject and body', () => {
    const t = keyCreatedTemplate({ keyId: 'k1', label: 'Prod', tenantId: 't1' });
    assert.ok(t.subject.includes('Prod'), 'subject should include label');
    assert.ok(t.html.includes('k1'), 'html should include keyId');
    assert.ok(t.text.includes('t1'), 'text should include tenantId');
  });

  it('keyRevokedTemplate generates correct content', () => {
    const t = keyRevokedTemplate({ keyId: 'k2', tenantId: 't2' });
    assert.ok(t.subject.includes('k2'));
    assert.ok(t.html.includes('revoked'));
  });

  it('keyRotatedTemplate includes old and new keyId', () => {
    const t = keyRotatedTemplate({ oldKeyId: 'k1', newKeyId: 'k2', tenantId: 't1' });
    assert.ok(t.html.includes('k1'), 'should include old keyId');
    assert.ok(t.html.includes('k2'), 'should include new keyId');
  });

  it('welcomeTemplate includes name and org', () => {
    const t = welcomeTemplate({ name: 'Alice', orgName: 'Acme' });
    assert.ok(t.subject.includes('Acme'));
    assert.ok(t.html.includes('Alice'));
  });
});

// ===========================================================================
// NotificationService (NEW-3.08)
// ===========================================================================

import { EventDispatcher } from '../../src/publisher/EventDispatcher.js';
import { buildEnvelope } from '../../src/publisher/deliveryTypes.js';
import { NotificationService } from '../../src/notifications/NotificationService.js';
import { DEFAULT_RULES } from '../../src/notifications/notificationRules.js';

describe('W3C-02 — NotificationService (NEW-3.08)', () => {
  it('routes key_created event to log channel', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);

    dispatcher.emit(buildEnvelope('key_created', 'test', { keyId: 'k1', label: 'Test', tenantId: 't1' }));

    assert.equal(svc.stats.processed, 1, 'should process 1 event');
    assert.equal(svc.stats.logsEmitted, 1, 'should emit 1 log notification');
    svc.destroy();
  });

  it('routes key_revoked event to log channel', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);

    dispatcher.emit(buildEnvelope('key_revoked', 'test', { keyId: 'k1', tenantId: 't1' }));

    assert.equal(svc.stats.processed, 1);
    assert.equal(svc.stats.logsEmitted, 1);
    svc.destroy();
  });

  it('routes key_rotated event to log channel', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);

    dispatcher.emit(buildEnvelope('key_rotated', 'test', { oldKeyId: 'k1', newKeyId: 'k2', tenantId: 't1' }));

    assert.equal(svc.stats.processed, 1);
    svc.destroy();
  });

  it('ignores disabled rules', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);

    // usage_metered is disabled by default
    dispatcher.emit(buildEnvelope('usage_metered', 'test', {}));

    assert.equal(svc.stats.processed, 0, 'disabled rule should not process');
    svc.destroy();
  });

  it('processes multiple events', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);

    dispatcher.emit(buildEnvelope('key_created', 'test', { keyId: 'k1', label: 'A', tenantId: 't1' }));
    dispatcher.emit(buildEnvelope('key_revoked', 'test', { keyId: 'k1', tenantId: 't1' }));
    dispatcher.emit(buildEnvelope('policy_denied', 'test', {}));

    assert.equal(svc.stats.processed, 3);
    svc.destroy();
  });

  it('supports custom rules', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher, [
      { eventKind: 'health_check', channel: 'log', template: 'health', enabled: true },
    ]);

    dispatcher.emit(buildEnvelope('health_check', 'test', {}));
    assert.equal(svc.stats.processed, 1);

    // key_created should NOT trigger since it's not in custom rules
    dispatcher.emit(buildEnvelope('key_created', 'test', { keyId: 'k', label: 'L', tenantId: 't' }));
    assert.equal(svc.stats.processed, 1, 'only custom rules should match');

    svc.destroy();
  });

  it('destroy() unsubscribes from dispatcher', () => {
    const dispatcher = new EventDispatcher();
    const svc = new NotificationService(dispatcher);
    svc.destroy();

    dispatcher.emit(buildEnvelope('key_created', 'test', { keyId: 'k', label: 'L', tenantId: 't' }));
    assert.equal(svc.stats.processed, 0, 'destroyed service should not process events');
  });
});

// ===========================================================================
// Notification Rules
// ===========================================================================

describe('W3C-02 — Notification rules', () => {
  it('DEFAULT_RULES has entries for key lifecycle events', () => {
    const kinds = DEFAULT_RULES.map(r => r.eventKind);
    assert.ok(kinds.includes('key_created'));
    assert.ok(kinds.includes('key_revoked'));
    assert.ok(kinds.includes('key_rotated'));
  });

  it('all rules have required fields', () => {
    for (const rule of DEFAULT_RULES) {
      assert.ok(rule.eventKind, 'rule must have eventKind');
      assert.ok(rule.channel, 'rule must have channel');
      assert.ok(rule.template, 'rule must have template');
      assert.equal(typeof rule.enabled, 'boolean', 'enabled must be boolean');
    }
  });
});

// ===========================================================================
// File structure
// ===========================================================================

describe('W3C-02 — File structure', () => {
  const expected = [
    'src/email/IEmailAdapter.ts',
    'src/email/ConsoleEmailAdapter.ts',
    'src/email/templates.ts',
    'src/notifications/NotificationService.ts',
    'src/notifications/notificationRules.ts',
  ];

  for (const f of expected) {
    it(`${f} exists`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} not found`);
    });
  }
});
