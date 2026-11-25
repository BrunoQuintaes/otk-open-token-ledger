#!/usr/bin/env node
/**
 * U7.6 — OpenAI Live Chat (REAL API CALL)
 * Updated U7.9 — key resolved via ProviderGateway (no direct process.env access)
 *
 * Sends a minimal Chat Completions request to OpenAI, then parses the
 * response through the U7.5 OpenAIAdapter to produce a NormalizedUsageEvent.
 *
 * Only SAFE telemetry is persisted (no API key, no prompt content).
 *
 * Prerequisites:
 *   OPENAI_API_KEY must be injected in the shell (never print or log it)
 *   export OPENAI_MODEL=gpt-4o  (optional, defaults to gpt-4o)
 *
 * Usage:
 *   node scripts/live/openai_live_chat.mjs [output_dir]
 *
 * COSTS MONEY: one real, paid request per run. Run it with a TypeScript loader (for example `node --import tsx`),
 * since it imports `.ts` sources. The key is obtained through `ProviderGateway` with `GlobalKeyStrategy` (which reads
 * `OPENAI_API_KEY`); `OPENAI_MODEL` picks the model. Writes `openai_normalized_usage.json` (or `openai_error.json`
 * on a non-2xx answer, exit code 1) into `output_dir`, default `docs/_ops/u7/U7_6_live`. Exit code 1 also when the
 * key cannot be resolved.
 *
 * @module scripts/live/openai_live_chat
 * @since U7.6
 * Updated: U7.9
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseOpenAIResponse } from '../../src/providers/adapters/OpenAIAdapter.js';
import { ProviderGateway } from '../../src/providers/gateway/ProviderGateway.js';
import { GlobalKeyStrategy } from '../../src/providers/strategies/GlobalKeyStrategy.js';

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').toLowerCase();

// ProviderGateway is the single authorized path for key resolution (U7.7/U7.9)
const key = await new ProviderGateway(new GlobalKeyStrategy()).resolveKey('openai').catch((err) => {
  console.error('Key resolution failed:', err.message);
  process.exit(1);
});

const outDir = process.argv[2] || 'docs/_ops/u7/U7_6_live';
fs.mkdirSync(outDir, { recursive: true });

const url = 'https://api.openai.com/v1/chat/completions';

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'Say hello in 5 words.' },
  ],
  temperature: 0,
};

const t0 = performance.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
const t1 = performance.now();
const latencyMs = Math.round(t1 - t0);

const json = await res.json();

if (!res.ok) {
  // Save error response (no secrets — only API error message)
  fs.writeFileSync(path.join(outDir, 'openai_error.json'), JSON.stringify(json, null, 2));
  console.error('OpenAI API error:', json.error?.message || 'unknown');
  process.exit(1);
}

// Parse via U7.5 adapter
const event = parseOpenAIResponse(json, latencyMs);

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

fs.writeFileSync(path.join(outDir, 'openai_normalized_usage.json'), JSON.stringify(safe, null, 2));
console.log('OK: wrote openai_normalized_usage.json');
console.log(JSON.stringify(safe, null, 2));
