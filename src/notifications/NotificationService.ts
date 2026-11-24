/**
 * NotificationService — event-to-channel routing backbone (NEW-3.08)
 *
 * Subscribes to EventDispatcher and routes events to notification channels
 * (email, log) based on configurable rules.
 *
 * @module notifications/NotificationService
 * @since Wave 3C (PACK 3C-02)
 */

import type { EventEnvelope } from '../publisher/deliveryTypes.js';
import type { EventDispatcher } from '../publisher/EventDispatcher.js';
import { getEmailAdapter } from '../email/IEmailAdapter.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import { keyCreatedTemplate, keyRevokedTemplate, keyRotatedTemplate } from '../email/templates.js';
import { DEFAULT_RULES, type NotificationRule } from './notificationRules.js';

export class NotificationService {
  private readonly _rules: NotificationRule[];
  private readonly _unsubscribe: () => void;
  private _processed = 0;
  private _emailsSent = 0;
  private _emailErrors = 0;
  private _logsEmitted = 0;

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

  /** Statistics for monitoring. */
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
export function getNotificationService(): NotificationService | null { return _service; }
export function setNotificationService(svc: NotificationService): void { _service = svc; }
export function resetNotificationServiceForTest(): void {
  _service?.destroy();
  _service = null;
}
