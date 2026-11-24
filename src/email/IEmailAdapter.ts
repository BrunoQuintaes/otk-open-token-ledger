/**
 * IEmailAdapter — email sending interface (NEW-3.07)
 *
 * Provider-agnostic email adapter. Implementations:
 *   - ConsoleEmailAdapter: dev/test (logs via StructuredLogger)
 *   - Future: SmtpEmailAdapter, SendGridAdapter, SesAdapter
 *
 * @module email/IEmailAdapter
 * @since Wave 3C (PACK 3C-02)
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

export interface EmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface IEmailAdapter {
  send(msg: EmailMessage): Promise<EmailResult>;
}

let _adapter: IEmailAdapter | null = null;
export function getEmailAdapter(): IEmailAdapter | null { return _adapter; }
export function setEmailAdapter(adapter: IEmailAdapter): void { _adapter = adapter; }
export function resetEmailAdapterForTest(): void { _adapter = null; }
