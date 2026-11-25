/**
 * NotificationService — event-to-channel routing backbone (NEW-3.08)
 *
 * Subscribes to EventDispatcher and routes events to notification channels
 * (email, log) based on configurable rules.
 *
 * Created at startup by `src/infra/storeBootstrap.ts` and stored as a process-wide singleton. Email goes
 * through the adapter registered in `src/email/IEmailAdapter.ts`; when none is registered, email rules are
 * skipped with a warning. Sending is fire-and-forget: a failed send is counted and logged, never thrown.
 * Every enabled rule whose event kind matches is applied (not only the first match).
 *
 * @module src/notifications/NotificationService
 * @since Wave 3C (PACK 3C-02)
 */

import type { EventEnvelope } from '../publisher/deliveryTypes.js';
import type { EventDispatcher } from '../publisher/EventDispatcher.js';
import { getEmailAdapter } from '../email/IEmailAdapter.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import { keyCreatedTemplate, keyRevokedTemplate, keyRotatedTemplate } from '../email/templates.js';
import { DEFAULT_RULES, type NotificationRule } from './notificationRules.js';

/**
 * Routes dispatcher events to the log or to email, according to a list of rules.
 *
 * Subscribes to the dispatcher in the constructor; call {@link NotificationService.destroy} to stop.
 */
export class NotificationService {
  private readonly _rules: NotificationRule[];
  private readonly _unsubscribe: () => void;
  private _processed = 0;
  private _emailsSent = 0;
  private _emailErrors = 0;
  private _logsEmitted = 0;

  /**
   * Subscribes to the dispatcher immediately (side effect).
   *
   * @param dispatcher - Event source to subscribe to.
   * @param rules - Routing rules; defaults to {@link DEFAULT_RULES} when omitted.
   */
  constructor(dispatcher: EventDispatcher, rules?: NotificationRule[]) {
    this._rules = rules ?? DEFAULT_RULES;
    this._unsubscribe = dispatcher.subscribe((e) => this._handle(e));
  }

  private _handle(event: EventEnvelope): void {
    const matchingRules = this._rules.filter(r => r.enabled && r.eventKind === event.eventKind);
    for (const rule of matchingRules) {
      this._processed++;
      if (rule.channel === 'log') {
        this._handleLog(event, rule);
      } else if (rule.channel === 'email') {
        this._handleEmail(event, rule);
      }
    }
  }

  private _handleLog(event: EventEnvelope, _rule: NotificationRule): void {
    const log = getLogger();
    log.info('notification', {
      eventKind: event.eventKind,
      eventId: event.eventId,
      source: event.source,
      channel: 'log',
      payload: event.payload,
    });
    this._logsEmitted++;
  }

  private _handleEmail(event: EventEnvelope, rule: NotificationRule): void {
    const adapter = getEmailAdapter();
    if (!adapter) {
      getLogger().warn('email notification skipped — no adapter configured', {
        eventKind: event.eventKind,
        template: rule.template,
      });
      return;
    }

    const template = this._resolveTemplate(rule.template, event);
    if (!template) return;

    const to = this._resolveRecipient(event);
    if (!to) return;

    adapter.send({
      to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    }).then(() => { this._emailsSent++; })
      .catch((err) => {
        this._emailErrors++;
        getLogger().warn('email notification failed', {
          eventKind: event.eventKind,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private _resolveTemplate(templateName: string, event: EventEnvelope) {
    const p = event.payload as Record<string, string>;
    switch (templateName) {
      case 'keyCreated':
        return keyCreatedTemplate({ keyId: p.keyId, label: p.label, tenantId: p.tenantId });
      case 'keyRevoked':
        return keyRevokedTemplate({ keyId: p.keyId, tenantId: p.tenantId });
      case 'keyRotated':
        return keyRotatedTemplate({ oldKeyId: p.oldKeyId, newKeyId: p.newKeyId, tenantId: p.tenantId });
      default:
        return null;
    }
  }

  private _resolveRecipient(event: EventEnvelope): string | null {
    // Check payload for explicit 'notifyEmail' field
    const to = (event.payload as Record<string, unknown>)?.notifyEmail;
    if (typeof to === 'string' && to.includes('@')) return to;
    // Future (Wave 3E): resolve from user model via tenantId → org owner email
    return null;
  }

  /**
   * Statistics for monitoring.
   *
   * @returns Counters since construction: rule matches processed, emails sent, email failures, log lines
   * emitted, and the number of configured rules. `emailsSent` grows only after the async send resolves.
   */
  get stats() {
    return {
      processed: this._processed,
      emailsSent: this._emailsSent,
      emailErrors: this._emailErrors,
      logsEmitted: this._logsEmitted,
      rulesCount: this._rules.length,
    };
  }

  /** Unsubscribe from dispatcher. */
  destroy(): void {
    this._unsubscribe();
  }
}

let _service: NotificationService | null = null;
/**
 * Returns the process-wide notification service.
 *
 * @returns The registered service, or `null` when none was set (notifications disabled).
 */
export function getNotificationService(): NotificationService | null { return _service; }
/**
 * Registers the process-wide notification service, replacing any previous one without destroying it.
 *
 * @param svc - The service to register.
 */
export function setNotificationService(svc: NotificationService): void { _service = svc; }
/** Test helper: unsubscribes the registered service (if any) and clears the singleton. */
export function resetNotificationServiceForTest(): void {
  _service?.destroy();
  _service = null;
}
