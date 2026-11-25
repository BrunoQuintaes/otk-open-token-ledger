/**
 * STOPGATE-01 P1.4 (S23-F04): the GDPR export notification (tenant id, instant, receipt count) went to the fixed
 * external address gdpr-notifications@otk.io whenever an e-mail adapter was configured. It now goes only to the
 * operator's OTK_GDPR_NOTIFY_EMAIL and is not sent without it.
 *
 * Module under test: `handleGdprExport` in `src/api/gdpr.ts`, with a recording e-mail adapter installed through
 * `src/email/IEmailAdapter.ts` (nothing is actually sent).
 *
 * Partitions: the notification variable unset (export answers 200, no message at all) and set (exactly one message, to
 * that address only, none to the former fixed domain).
 *
 * Needs: nothing external. Sets and removes `OTK_GDPR_NOTIFY_EMAIL` (a reserved example domain) and restores the
 * caller's value at the end.
 *
 * Run just this file: `npx tsx --test test/security/stopgate01_s23f04_gdpr_notify.test.ts`
 *
 * @module test/security/stopgate01_s23f04_gdpr_notify.test
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGdprExport } from '../../src/api/gdpr.js';
import { setEmailAdapter, resetEmailAdapterForTest } from '../../src/email/IEmailAdapter.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeRes(): any {
  const r: any = { statusCode: 0, headers: {} as Record<string, unknown>, body: '' };
  r.setHeader = (k: string, v: unknown) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k: string) => r.headers[k.toLowerCase()];
  r.writeHead = (s: number, h?: Record<string, unknown>) => { r.statusCode = s; Object.assign(r.headers, h ?? {}); return r; };
  r.end = (b?: string) => { r.body += b ?? ''; };
  return r;
}

describe('STOPGATE-01 S23-F04: GDPR export notification recipient', () => {
  const sent: Array<{ to: string; subject: string }> = [];
  const saved = process.env['OTK_GDPR_NOTIFY_EMAIL'];
  beforeEach(() => {
    sent.length = 0;
    setEmailAdapter({ send: async (m: any) => { sent.push({ to: m.to, subject: m.subject }); return { ok: true } as any; } } as any);
  });
  after(() => {
    resetEmailAdapterForTest();
    if (saved === undefined) delete process.env['OTK_GDPR_NOTIFY_EMAIL']; else process.env['OTK_GDPR_NOTIFY_EMAIL'] = saved;
  });

  it('without OTK_GDPR_NOTIFY_EMAIL nothing leaves the operator (no e-mail at all)', async () => {
    delete process.env['OTK_GDPR_NOTIFY_EMAIL'];
    const res = fakeRes();
    await handleGdprExport({ url: '/gdpr/export' } as IncomingMessage, res as ServerResponse, 'tenant-s23f04');
    await new Promise((r) => setImmediate(r));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(sent, []);
  });

  it('with OTK_GDPR_NOTIFY_EMAIL the notification goes only there', async () => {
    process.env['OTK_GDPR_NOTIFY_EMAIL'] = 'privacy@operator.example';
    const res = fakeRes();
    await handleGdprExport({ url: '/gdpr/export' } as IncomingMessage, res as ServerResponse, 'tenant-s23f04');
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'privacy@operator.example');
    assert.ok(!sent.some((m) => m.to.endsWith('@otk.io')));
  });
});
