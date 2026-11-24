/**
 * EventDispatcher — in-memory event fan-out with bounded buffer (F3.2)
 *
 * Responsibilities:
 *   - emit(envelope): fan-out to all registered subscribers, buffer in circular queue
 *   - subscribe(handler): register a subscriber; returns an unsubscribe function
 *   - latest(n): return the last N delivered events from the buffer
 *   - reset(): clear buffer (for tests / graceful restart)
 *
 * Contract:
 *   - Buffer is bounded (default 100 entries); oldest events are dropped when full.
 *   - Subscriber errors are silently swallowed — delivery never breaks the main flow.
 *   - emit() marks the envelope deliveryStatus as 'delivered'.
 *   - No I/O, no external broker, no persistence.
 *
 * @module publisher/EventDispatcher
 * @since F3.2
 */

import type { EventEnvelope } from './deliveryTypes.js';

export class EventDispatcher {
  private readonly _buffer: EventEnvelope[];
  private readonly _maxSize: number;
  private readonly _handlers = new Set<(e: EventEnvelope) => void>();

  constructor(maxSize = 100) {
    this._buffer = [];
    this._maxSize = Math.max(1, maxSize);
  }

  /**
   * Emit an event envelope.
   *
   * - Marks deliveryStatus as 'delivered'.
   * - Appends to bounded buffer (oldest dropped when full).
   * - Fan-outs to all registered subscribers (errors silently swallowed).
   */
  emit(envelope: EventEnvelope): void {
    const delivered: EventEnvelope = { ...envelope, deliveryStatus: 'delivered' };
    if (this._buffer.length >= this._maxSize) {
      this._buffer.shift();
    }
    this._buffer.push(delivered);
    for (const h of this._handlers) {
      try { h(delivered); } catch { /* subscriber errors must never break dispatch */ }
    }
  }

  /**
   * Register a subscriber.
   * @returns unsubscribe function — call to remove this subscriber.
   */
  subscribe(handler: (e: EventEnvelope) => void): () => void {
    this._handlers.add(handler);
    return () => { this._handlers.delete(handler); };
  }

  /**
   * Return the last N delivered events from the buffer.
   * @param n Max events to return (default 10, clamped to buffer size).
   */
  latest(n = 10): EventEnvelope[] {
    return this._buffer.slice(-Math.max(0, n));
  }

  /** Number of events currently in the buffer. */
  get size(): number { return this._buffer.length; }

  /** Number of active subscribers. */
  get subscriberCount(): number { return this._handlers.size; }

  /** Clear all buffered events (does not affect subscribers). */
  reset(): void {
    this._buffer.length = 0;
  }
}
