/**
 * OTK zk-Metering — TypeScript basic example (G1 / RB-077)
 *
 * Demonstrates in-process usage of the core singletons:
 *   - getCollector() for observability
 *   - getLimiter() + buildRateLimitKey() for rate limiting
 *   - getDispatcher() + buildEnvelope() for event delivery
 *
 * No HTTP server needed — all calls are in-process.
 *
 * Run (from repo root):
 *   npx tsx examples/typescript/basic_metering.ts
 */

import { getCollector } from '../../src/observability/runtime.js';
import { getLimiter, buildRateLimitKey } from '../../src/security/index.js';
import { getDispatcher } from '../../src/publisher/runtime.js';
import { buildEnvelope } from '../../src/publisher/deliveryTypes.js';
import type { NormalizedUsageEvent } from '../../src/providers/types.js';

// ---------------------------------------------------------------------------
// 1. Record a metered usage event
// ---------------------------------------------------------------------------

const usageEvent: NormalizedUsageEvent = {
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  latencyMs: 320,
  costUnits: 1500,
  timestamp: Date.now(),
  requestId: 'req-example-001',
};

getCollector().record(usageEvent);
const snap = getCollector().snapshot();
console.log('[metrics] health:', snap.health);
console.log('[metrics] providers:', snap.providers.length);

// ---------------------------------------------------------------------------
// 2. Check rate limit before processing
// ---------------------------------------------------------------------------

const rlKey = buildRateLimitKey({ tenantId: 'tenant-demo', provider: 'openai' });
const rlConfig = { windowSeconds: 60, maxRequests: 100, throttleAt: 0.8 };
const decision = getLimiter().evaluate(rlKey, rlConfig);

console.log('[ratelimit] decision:', decision.decision);
console.log('[ratelimit] remaining:', decision.remaining, '/', rlConfig.maxRequests);

if (decision.decision !== 'deny') {
  getLimiter().record(rlKey);
}

// ---------------------------------------------------------------------------
// 3. Dispatch an event envelope
// ---------------------------------------------------------------------------

const envelope = buildEnvelope(
  'usage_metered',
  'example-script',
  { provider: usageEvent.provider, costUnits: usageEvent.costUnits },
);

getDispatcher().emit(envelope);
const latest = getDispatcher().latest(1);
console.log('[events] dispatched:', latest[0]?.eventKind, '—', latest[0]?.eventId);
