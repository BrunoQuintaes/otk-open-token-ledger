/**
 * Publisher Runtime — process-level EventDispatcher singleton (F3.2)
 *
 * Canonical access point for event delivery wiring.
 * Callers emit events after significant operations:
 *   getDispatcher().emit(buildEnvelope('usage_metered', 'provider:openai', payload))
 *
 * The singleton is reset-safe: call getDispatcher().reset() in tests.
 *
 * @since F3.2
 */

import { EventDispatcher } from './EventDispatcher.js';

const _dispatcher = new EventDispatcher();

/**
 * Returns the process-level EventDispatcher singleton.
 * Same instance on every call — guaranteed by module scope.
 */
export function getDispatcher(): EventDispatcher {
  return _dispatcher;
}
