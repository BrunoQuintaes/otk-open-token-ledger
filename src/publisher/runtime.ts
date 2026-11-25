/**
 * Publisher Runtime — process-level EventDispatcher singleton (F3.2)
 *
 * Canonical access point for event delivery wiring.
 * Callers emit events after significant operations:
 *   getDispatcher().emit(buildEnvelope('usage_metered', 'provider:openai', payload))
 *
 * The singleton is reset-safe: call getDispatcher().reset() in tests.
 *
 * The dispatcher is created when this module is first imported; nothing else runs at import.
 *
 * @module src/publisher/runtime
 *
 * @since F3.2
 */

import { EventDispatcher } from './EventDispatcher.js';

const _dispatcher = new EventDispatcher();

/**
 * Returns the process-level EventDispatcher singleton.
 * Same instance on every call — guaranteed by module scope.
 *
 * @returns The shared dispatcher (buffer of 100 envelopes).
 */
export function getDispatcher(): EventDispatcher {
  return _dispatcher;
}
