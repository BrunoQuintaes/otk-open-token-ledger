/**
 * IEmailAdapter — email sending interface (NEW-3.07)
 *
 * Provider-agnostic email adapter. Implementations:
 *   - ConsoleEmailAdapter: dev/test (logs via StructuredLogger)
 *   - Future: SmtpEmailAdapter, SendGridAdapter, SesAdapter
 *
 * At the evaluated version `SmtpEmailAdapter` also exists. The process-wide adapter is installed by
 * `src/infra/storeBootstrap.ts` with `setEmailAdapter()`; until then `getEmailAdapter()` returns null and callers
 * skip sending.
 *
 * @module src/email/IEmailAdapter
 * @since Wave 3C (PACK 3C-02)
 */

/** One outgoing e-mail. */
export interface EmailMessage {
  /** Recipient address. */
  to: string;
  subject: string;
  /** HTML body; callers escape any untrusted text. */
  html: string;
  /** Plain-text body, when provided. */
  text?: string;
  /** Sender address; the adapter's default when absent. */
  from?: string;
}

/** Outcome of one send. */
export interface EmailResult {
  ok: boolean;
  /** Id assigned by the transport, when sent. */
  messageId?: string;
  /** Failure message when `ok` is false. */
  error?: string;
}

/** Something that can send an e-mail. */
export interface IEmailAdapter {
  /**
   * Sends one message.
   *
   * @param msg - Message to send.
   * @returns The outcome; implementations report failures in it instead of rejecting.
   */
  send(msg: EmailMessage): Promise<EmailResult>;
}

let _adapter: IEmailAdapter | null = null;
/**
 * Returns the installed adapter.
 *
 * @returns The adapter, or null when none is installed.
 */
export function getEmailAdapter(): IEmailAdapter | null { return _adapter; }
/**
 * Installs the process-wide adapter.
 *
 * @param adapter - Adapter to use from now on.
 */
export function setEmailAdapter(adapter: IEmailAdapter): void { _adapter = adapter; }
/** Removes the installed adapter (tests). */
export function resetEmailAdapterForTest(): void { _adapter = null; }
