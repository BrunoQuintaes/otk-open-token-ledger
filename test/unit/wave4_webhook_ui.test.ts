/**
 * W4-4E02 — Webhook management UI tests (NEW-4.06)
 *
 * Covers:
 *   1.  src/dashboard/webhooks.ts exists
 *   2.  renderWebhooksPage returns HTML string
 *   3.  Page contains <table> element
 *   4.  Page has "Register Endpoint" section
 *   5.  Page lists endpoint URL when endpoints provided
 *   6.  Page shows "No endpoints registered" when empty
 *   7.  Page shows delivery log table
 *   8.  Page shows DLQ section
 *   9.  Page includes Replay button for unresolved DLQ entries
 *  10.  app.ts has /app/webhooks route
 *
 * @since Wave 4 (4E-PACK-4E02 / NEW-4.06)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { renderWebhooksPage } from '../../src/dashboard/webhooks.js';
import type { WebhookEndpoint, WebhookDeliveryLog, WebhookDeadLetter } from '../../src/webhooks/WebhookRegistry.js';

const NOW = '2026-04-02T00:00:00.000Z';

function makeEndpoint(overrides?: Partial<WebhookEndpoint>): WebhookEndpoint {
  return {
    id: 'ep-test-uuid-1234',
    tenantId: 't1',
    url: 'https://hooks.example.com/recv',
    events: ['receipt_submitted'],
    active: true,
    secret: 'secret-abc',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDelivery(endpointId: string, overrides?: Partial<WebhookDeliveryLog>): WebhookDeliveryLog {
  return {
    id: 'd-1',
    endpointId,
    eventKind: 'receipt_submitted',
    payload: '{"event":"receipt_submitted"}',
    attempt: 1,
    status: 'success',
    statusCode: 200,
    deliveredAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDeadLetter(endpointId: string, overrides?: Partial<WebhookDeadLetter>): WebhookDeadLetter {
  return {
    id: 'dl-1',
    endpointId,
    eventKind: 'proof_ready',
    payload: '{"event":"proof_ready"}',
    attempts: 5,
    lastError: 'Connection refused',
    createdAt: NOW,
    ...overrides,
  };
}

describe('W4-4E02 — File structure', () => {
  it('src/dashboard/webhooks.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/dashboard/webhooks.ts')));
  });

  it('app.ts has /app/webhooks route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/dashboard/app.ts'), 'utf-8');
    assert.ok(c.includes('/app/webhooks'));
  });
});

describe('W4-4E02 — renderWebhooksPage', () => {
  it('returns HTML string', () => {
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [] });
    assert.ok(typeof html === 'string');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('page contains table element', () => {
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [] });
    assert.ok(html.includes('<table>'));
  });

  it('page has Register Endpoint section', () => {
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [] });
    assert.ok(html.includes('Register Endpoint'));
  });

  it('shows No endpoints registered when empty', () => {
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [] });
    assert.ok(html.includes('No endpoints registered'));
  });

  it('lists endpoint URL when endpoints provided', () => {
    const ep = makeEndpoint();
    const html = renderWebhooksPage({ endpoints: [ep], deliveries: {}, deadLetters: [] });
    assert.ok(html.includes('hooks.example.com'));
  });

  it('shows delivery log table', () => {
    const ep = makeEndpoint();
    const dl = makeDelivery(ep.id);
    const html = renderWebhooksPage({ endpoints: [ep], deliveries: { [ep.id]: [dl] }, deadLetters: [] });
    assert.ok(html.includes('Recent Deliveries'));
    assert.ok(html.includes('receipt_submitted'));
  });

  it('shows DLQ section', () => {
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [] });
    assert.ok(html.includes('Dead-Letter Queue'));
  });

  it('includes Replay button for unresolved DLQ entries', () => {
    const ep = makeEndpoint();
    const dlEntry = makeDeadLetter(ep.id);
    const html = renderWebhooksPage({ endpoints: [], deliveries: {}, deadLetters: [dlEntry] });
    assert.ok(html.includes('Replay'));
    assert.ok(html.includes('replayDlq'));
  });
});
