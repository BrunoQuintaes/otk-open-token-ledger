/**
 * Publisher public API (F3)
 *
 * Lateral event delivery layer — does not alter CU/ZK/Registry/Economic semantics.
 *
 * Usage:
 *   import { buildEnvelope, getDispatcher } from '../publisher/index.js';
 *   const env = buildEnvelope('usage_metered', 'provider:openai', { ... });
 *   getDispatcher().emit(env);
 *
 * Barrel module: it only re-exports the envelope types and helpers, the dispatcher class and the
 * process-wide dispatcher accessor.
 *
 * @module src/publisher/index
 *
 * @since F3
 */

export type { EventKind, DeliveryStatus, EventEnvelope } from './deliveryTypes.js';
export { buildEnvelope } from './deliveryTypes.js';

export { EventDispatcher } from './EventDispatcher.js';
export { getDispatcher } from './runtime.js';
