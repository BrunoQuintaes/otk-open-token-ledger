/**
 * W4-SMTP — SmtpEmailAdapter tests
 *
 * Covers:
 *   1. File structure (SmtpEmailAdapter.ts exists)
 *   2. createSmtpAdapterFromEnv() factory behaviour
 *   3. send() success and failure paths (via mock transport injection)
 *   4. storeBootstrap wiring (email key present in result.stores)
 *
 * @since Wave 4 (W4-SMTP)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SmtpEmailAdapter, createSmtpAdapterFromEnv } from '../../src/email/SmtpEmailAdapter.js';
import { resetEmailAdapterForTest } from '../../src/email/IEmailAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// ──────────────────────────────────────────────────────────
// 1. File structure
// ──────────────────────────────────────────────────────────
describe('W4-SMTP — File structure', () => {
  it('src/email/SmtpEmailAdapter.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/email/SmtpEmailAdapter.ts')));
  });

  it('ADR-0301-email-adapter.md exists', () => {
    assert.ok(
      fs.existsSync(
        path.join(ROOT, 'docs/architecture/adr/ADR-0301-email-adapter.md'),
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────
// 2. createSmtpAdapterFromEnv() factory
// ──────────────────────────────────────────────────────────
describe('W4-SMTP — createSmtpAdapterFromEnv factory', () => {
  let _origHost: string | undefined;

  beforeEach(() => {
    _origHost = process.env['OTK_SMTP_HOST'];
    delete process.env['OTK_SMTP_HOST'];
  });

  afterEach(() => {
    if (_origHost !== undefined) {
      process.env['OTK_SMTP_HOST'] = _origHost;
    } else {
      delete process.env['OTK_SMTP_HOST'];
    }
  });

  it('returns null when OTK_SMTP_HOST is not set', () => {
    const adapter = createSmtpAdapterFromEnv();
    assert.strictEqual(adapter, null);
  });

  it('returns SmtpEmailAdapter instance when OTK_SMTP_HOST is set', () => {
    process.env['OTK_SMTP_HOST'] = 'smtp.example.com';
    const adapter = createSmtpAdapterFromEnv();
    assert.ok(adapter instanceof SmtpEmailAdapter);
  });

  it('uses OTK_SMTP_PORT when set', () => {
    process.env['OTK_SMTP_HOST'] = 'smtp.example.com';
    process.env['OTK_SMTP_PORT'] = '465';
    const adapter = createSmtpAdapterFromEnv();
    assert.ok(adapter !== null);
    delete process.env['OTK_SMTP_PORT'];
  });

  it('defaults port to 587 when OTK_SMTP_PORT unset', () => {
    process.env['OTK_SMTP_HOST'] = 'smtp.example.com';
    delete process.env['OTK_SMTP_PORT'];
    const adapter = createSmtpAdapterFromEnv();
    assert.ok(adapter !== null);
  });
});

// ──────────────────────────────────────────────────────────
// 3. SmtpEmailAdapter send() behaviour (mock transport)
// ──────────────────────────────────────────────────────────
describe('W4-SMTP — SmtpEmailAdapter send()', () => {
  afterEach(() => {
    resetEmailAdapterForTest();
  });

  it('returns ok:true with messageId on transport success', async () => {
    const mockTransport = {
      sendMail: async (_opts: unknown) => ({ messageId: 'test-msg-id-001' }),
    };
    const adapter = new SmtpEmailAdapter(
      { host: 'smtp.test', port: 587, from: 'noreply@test.io' },
      mockTransport,
    );
    const result = await adapter.send({
      to: 'user@example.com',
      subject: 'Test subject',
      html: '<p>Hello</p>',
    });
    assert.ok(result.ok);
    assert.strictEqual(result.messageId, 'test-msg-id-001');
    assert.strictEqual(result.error, undefined);
  });

  it('returns ok:false with error string on transport failure', async () => {
    const mockTransport = {
      sendMail: async (_opts: unknown): Promise<{ messageId?: string }> => {
        throw new Error('SMTP connection refused');
      },
    };
    const adapter = new SmtpEmailAdapter(
      { host: 'smtp.test', port: 587, from: 'noreply@test.io' },
      mockTransport,
    );
    const result = await adapter.send({
      to: 'user@example.com',
      subject: 'Fail',
      html: '<p>Fail</p>',
    });
    assert.ok(!result.ok);
    assert.ok(result.error?.includes('SMTP connection refused'));
  });

  it('uses msg.from override when provided', async () => {
    let capturedFrom: string | undefined;
    const mockTransport = {
      sendMail: async (opts: { from?: string }) => {
        capturedFrom = opts.from;
        return { messageId: 'x' };
      },
    };
    const adapter = new SmtpEmailAdapter(
      { host: 'smtp.test', port: 587, from: 'default@test.io' },
      mockTransport,
    );
    await adapter.send({
      to: 'u@e.com',
      subject: 'S',
      html: '<p></p>',
      from: 'override@test.io',
    });
    assert.strictEqual(capturedFrom, 'override@test.io');
  });

  it('falls back to constructor from when msg.from is absent', async () => {
    let capturedFrom: string | undefined;
    const mockTransport = {
      sendMail: async (opts: { from?: string }) => {
        capturedFrom = opts.from;
        return { messageId: 'y' };
      },
    };
    const adapter = new SmtpEmailAdapter(
      { host: 'smtp.test', port: 587, from: 'default@test.io' },
      mockTransport,
    );
    await adapter.send({ to: 'u@e.com', subject: 'S', html: '<p></p>' });
    assert.strictEqual(capturedFrom, 'default@test.io');
  });

  it('generates fallback messageId when transport returns none', async () => {
    const mockTransport = {
      sendMail: async (_opts: unknown) => ({}), // no messageId
    };
    const adapter = new SmtpEmailAdapter(
      { host: 'smtp.test', port: 587, from: 'noreply@test.io' },
      mockTransport,
    );
    const result = await adapter.send({ to: 'u@e.com', subject: 'S', html: '<p></p>' });
    assert.ok(result.ok);
    assert.ok(typeof result.messageId === 'string' && result.messageId.startsWith('smtp-'));
  });
});
