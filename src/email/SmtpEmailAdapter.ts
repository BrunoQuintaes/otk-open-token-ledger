/**
 * SmtpEmailAdapter — production SMTP email adapter (W4-SMTP)
 *
 * Sends email via nodemailer SMTP transport.
 * Falls back to ConsoleEmailAdapter when OTK_SMTP_HOST is not set.
 *
 * Env vars:
 *   OTK_SMTP_HOST   — SMTP server hostname (required to activate)
 *   OTK_SMTP_PORT   — SMTP port (default: 587)
 *   OTK_SMTP_USER   — SMTP auth username (optional)
 *   OTK_SMTP_PASS   — SMTP auth password (optional)
 *   OTK_EMAIL_FROM  — Default from address (default: noreply@otk.io)
 *
 * @module email/SmtpEmailAdapter
 * @since Wave 4 (W4-SMTP)
 * @see ADR-0301-email-adapter.md
 */

import type { IEmailAdapter, EmailMessage, EmailResult } from './IEmailAdapter.js';

/** Minimal transport interface — compatible with nodemailer.Transporter */
interface MailTransporter {
  sendMail(opts: {
    from?: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export interface SmtpAdapterOpts {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpEmailAdapter implements IEmailAdapter {
  private readonly _from: string;
  private readonly _transport: MailTransporter;

  /**
   * @param opts    SMTP connection options
   * @param transport  Optional pre-built transport (for testing / DI).
   *                   When omitted, a nodemailer SMTP transport is created.
   */
  constructor(opts: SmtpAdapterOpts, transport?: MailTransporter) {
    this._from = opts.from;
    if (transport) {
      this._transport = transport;
    } else {
      // Dynamic import keeps nodemailer optional at module-load time.
      // The transport is created synchronously via require-compatible interop.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      // biome-ignore lint: dynamic require for optional peer dependency
      // We use createTransport lazily — but since ESM has no sync require,
      // we store a sentinel and initialise on first send().
      // To keep send() async-clean, store a promise-based init.
      this._transport = SmtpEmailAdapter._buildTransport(opts);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _buildTransport(opts: SmtpAdapterOpts): any {
    // nodemailer is an optional runtime peer dependency.
    // If not installed, send() returns {ok:false, error:'nodemailer not installed'}.
    let _transporter: MailTransporter | null = null;
    let _initErr: string | null = null;

    // Attempt eager init using dynamic import (returns a lazy wrapper).
    return {
      sendMail: async (mailOpts: {
        from?: string;
        to: string;
        subject: string;
        html: string;
        text?: string;
      }): Promise<{ messageId?: string }> => {
        if (_initErr) throw new Error(_initErr);
        if (!_transporter) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nm: any = await import('nodemailer');
            const nodemailer = nm.default ?? nm;
            _transporter = nodemailer.createTransport({
              host: opts.host,
              port: opts.port,
              secure: opts.port === 465,
              auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
            }) as MailTransporter;
          } catch (e) {
            _initErr = `nodemailer not available: ${e instanceof Error ? e.message : String(e)}`;
            throw new Error(_initErr);
          }
        }
        return _transporter.sendMail(mailOpts);
      },
    };
  }

  async send(msg: EmailMessage): Promise<EmailResult> {
    try {
      const info = await this._transport.sendMail({
        from: msg.from ?? this._from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      return { ok: true, messageId: info.messageId ?? `smtp-${Date.now()}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Factory: reads OTK_SMTP_* environment variables.
 * Returns null when OTK_SMTP_HOST is not set (caller should fall back to ConsoleEmailAdapter).
 */
export function createSmtpAdapterFromEnv(): SmtpEmailAdapter | null {
  const host = process.env['OTK_SMTP_HOST'];
  if (!host) return null;
  return new SmtpEmailAdapter({
    host,
    port: Number(process.env['OTK_SMTP_PORT'] ?? 587),
    user: process.env['OTK_SMTP_USER'],
    pass: process.env['OTK_SMTP_PASS'],
    from: process.env['OTK_EMAIL_FROM'] ?? 'noreply@otk.io',
  });
}
