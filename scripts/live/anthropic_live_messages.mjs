#!/usr/bin/env node
/**
 * U7.6 — Anthropic Live Messages (REAL API CALL)
 * Updated U7.9 — key resolved via ProviderGateway (no direct process.env access)
 *
 * Sends a minimal Messages API request to Anthropic, then parses the
 * response through the U7.5 AnthropicAdapter to produce a NormalizedUsageEvent.
 *
 * Only SAFE telemetry is persisted (no API key, no prompt content).
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY must be injected in the shell (never print or log it)
 *   export ANTHROPIC_MODEL=claude-sonnet-4  (optional)
 *
 * Usage:
 *   node scripts/live/anthropic_live_messages.mjs [output_dir]
 *
 * @since U7.6
 * @updated U7.9
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseAnthropicResponse } from '../../src/providers/adapters/AnthropicAdapter.js';
import { ProviderGateway } from '../../src/providers/gateway/ProviderGateway.js';
import { GlobalKeyStrategy } from '../../src/providers/strategies/GlobalKeyStrategy.js';

const MODEL = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514').toLowerCase();

// ProviderGateway is the single authorized path for key resolution (U7.7/U7.9)
const key = await new ProviderGateway(new GlobalKeyStrategy()).resolveKey('anthropic').catch((err) => {
  console.error('Key resolution failed:', err.message);
  process.exit(1);
});

const outDir = process.argv[2] || 'docs/_ops/u7/U7_6_live';
fs.mkdirSync(outDir, { recursive: true });

const url = 'https://api.anthropic.com/v1/messages';

const body = {
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
};

const t0 = performance.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});
const t1 = performance.now();
const latencyMs = Math.round(t1 - t0);

const json = await res.json();

if (!res.ok) {
  // Save error response (no secrets — only API error message)
  fs.writeFileSync(path.join(outDir, 'anthropic_error.json'), JSON.stringify(json, null, 2));
  console.error('Anthropic API error:', json.error?.message || 'unknown');
  process.exit(1);
}

// Anthropic doesn't include created timestamp → use current time
const nowTs = Math.floor(Date.now() / 1000);

// Parse via U7.5 adapter
const event = parseAnthropicResponse(json, latencyMs, nowTs);

// Persist safe telemetry only (no prompt content, no API key)
const safe = {
  provider: event.provider,
  model: event.model,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  totalTokens: event.totalTokens,
  latencyMs: event.latencyMs,
  costUnits: event.costUnits,
  timestamp: event.timestamp,
  requestId: event.requestId,
};

fs.writeFileSync(path.join(outDir, 'anthropic_normalized_usage.json'), JSON.stringify(safe, null, 2));
console.log('OK: wrote anthropic_normalized_usage.json');
console.log(JSON.stringify(safe, null, 2));
