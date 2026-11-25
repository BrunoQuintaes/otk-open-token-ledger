/**
 * ConsoleEmailAdapter — dev/test email adapter (NEW-3.07)
 *
 * Logs email content via StructuredLogger instead of sending.
 * Suitable for development and testing — no external dependencies.
 *
 * Installed by `src/infra/storeBootstrap.ts` when no SMTP host is configured. Messages are kept in memory
 * (`sent`) for the life of the adapter; only recipient, subject, sender and id are logged, never the body.
 *
 * @module src/email/ConsoleEmailAdapter
 * @since Wave 3C (PACK 3C-02)
 */

import type { IEmailAdapter, EmailMessage, EmailResult } from './IEmailAdapter.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';

/** Email adapter that logs instead of sending and remembers every message. */
export class ConsoleEmailAdapter implements IEmailAdapter {
  private readonly _sent: EmailMessage[] = [];

  /**
   * Logs the message metadata and records the message.
   *
   * @param msg - Message to "send" (kept by reference).
   * @returns Always `ok: true` with a random `console-…` message id.
   */
  async send(msg: EmailMessage): Promise<EmailResult> {
    const log = getLogger();
    const messageId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    log.info('email sent (console adapter)', {
      to: msg.to,
      subject: msg.subject,
      from: msg.from ?? 'noreply@otk.io',
      messageId,
    });

    this._sent.push(msg);

    return { ok: true, messageId };
  }

  /**
   * Get all sent messages (for testing).
   *
   * @returns The recorded messages, oldest first.
   */
  get sent(): readonly EmailMessage[] {
    return this._sent;
  }

  /** Clear sent messages (for testing). */
  clear(): void {
    this._sent.length = 0;
  }
}
