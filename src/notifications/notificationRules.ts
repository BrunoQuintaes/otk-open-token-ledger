/**
 * Notification Rules — default event-to-channel routing (NEW-3.08)
 *
 * Each rule maps an EventKind to a notification channel and template.
 * Rules are evaluated in order; first match wins.
 *
 * @module notifications/notificationRules
 * @since Wave 3C (PACK 3C-02)
 */

import type { EventKind } from '../publisher/deliveryTypes.js';

export type NotificationChannel = 'email' | 'log';

export interface NotificationRule {
  eventKind: EventKind;
  channel: NotificationChannel;
  template: string;
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
