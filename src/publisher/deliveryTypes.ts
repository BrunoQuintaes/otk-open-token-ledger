/**
 * Event Delivery Types — canonical contract for event envelopes (F3.1)
 *
 * Defines the minimal delivery vocabulary:
 *   EventKind:      classification of what kind of event occurred
 *   DeliveryStatus: tracking state of the envelope through the dispatcher
 *   EventEnvelope:  canonical, export-safe wrapper around any delivery event
 *
 * Scope (in-scope for F3):
 *   - canonical event envelope for all delivery surfaces
 *   - buildEnvelope() helper for producing export-safe envelopes
 *   - EventKind classification (usage / policy / health)
 *
 * Scope (out-of-scope for F3):
 *   - Kafka / RabbitMQ / NATS broker integration
 *   - distributed retries / backoff / dead-letter queues
 *   - webhook external delivery with signature verification
 *   - WebSocket / SSE server-push (long-lived connections)
 *   - durable event persistence
 *
 * @module publisher/deliveryTypes
 * @since F3.1
 */

/** Classification of what kind of event occurred. */
export type EventKind =
  | 'usage_metered'   // provider usage event was recorded
  | 'policy_denied'   // policy engine denied a request
  | 'health_check'    // health / liveness probe event
  | 'key_created'     // API key was created (NEW-3.06)
  | 'key_revoked'     // API key was revoked (NEW-3.06)
  | 'key_rotated';    // API key was rotated (NEW-3.06)

/** Lifecycle state of an EventEnvelope through the dispatcher. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/**
 * Canonical event envelope — export-safe, no secrets.
 *
 * All fields are required except `payload` contents.
 * Payload MUST NOT contain raw prompts, API keys, or other secrets.
 */
export type EventEnvelope = {
  /** Unique identifier for this event (auto-generated if not provided). */
  eventId: string;
  /** Classification of the event. */
  eventKind: EventKind;
  /** Source identifier (e.g., 'provider:openai', 'policy_engine', 'health'). */
  source: string;
  /** Unix timestamp in seconds. */
  timestamp: number;
  /** Export-safe payload. No raw prompts, no secrets. */
  payload: Record<string, unknown>;
  /** Delivery lifecycle state (set to 'delivered' by EventDispatcher.emit()). */
  deliveryStatus: DeliveryStatus;
};

/**
 * Build a canonical EventEnvelope.
 *
 * @param kind          Event classification
 * @param source        Source identifier
 * @param payload       Export-safe payload (no secrets)
 * @param timestampSecs Unix timestamp in seconds (defaults to current time)
 * @param eventId       Event identifier (auto-generated if omitted)
 */
export function buildEnvelope(
  kind: EventKind,
  source: string,
  payload: Record<string, unknown>,
  timestampSecs?: number,
  eventId?: string,
): EventEnvelope {
  return {
    eventId:        eventId ?? `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    eventKind:      kind,
    source,
    timestamp:      timestampSecs ?? Math.floor(Date.now() / 1000),
    payload,
    deliveryStatus: 'pending',
  };
}
