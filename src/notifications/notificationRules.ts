/**
 * Notification Rules — default event-to-channel routing (NEW-3.08)
 *
 * Each rule maps an EventKind to a notification channel and template.
 * Rules are evaluated in order; first match wins.
 *
 * Note: `NotificationService` applies EVERY enabled rule whose event kind matches, not only the first.
 * All default rules use the `log` channel; email requires a caller-supplied rule list.
 *
 * @module src/notifications/notificationRules
 * @since Wave 3C (PACK 3C-02)
 */

import type { EventKind } from '../publisher/deliveryTypes.js';

/** Where a notification goes: the structured log or an email through the registered adapter. */
export type NotificationChannel = 'email' | 'log';

/** One routing rule: events of `eventKind` go to `channel` using `template`. */
export interface NotificationRule {
  eventKind: EventKind;
  channel: NotificationChannel;
  /** Email template name (`keyCreated`, `keyRevoked`, `keyRotated`); unknown names send no email. Ignored by the log channel. */
  template: string;
  /** When false the rule is ignored. */
  enabled: boolean;
}

/** Default notification rules. */
export const DEFAULT_RULES: NotificationRule[] = [
  { eventKind: 'key_created', channel: 'log', template: 'keyCreated', enabled: true },
  { eventKind: 'key_revoked', channel: 'log', template: 'keyRevoked', enabled: true },
  { eventKind: 'key_rotated', channel: 'log', template: 'keyRotated', enabled: true },
  { eventKind: 'usage_metered', channel: 'log', template: 'usageMetered', enabled: false },
  { eventKind: 'policy_denied', channel: 'log', template: 'policyDenied', enabled: true },
];
