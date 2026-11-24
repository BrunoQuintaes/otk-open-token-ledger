#!/usr/bin/env node
/**
 * U7.8 — Safe Live Runner: OpenAI → NormalizedUsageEvent → UsageLedger
 *
 * Calls the OpenAI Chat Completions API, normalizes the response via the
 * U7.5 OpenAIAdapter (proper CU calculation), and appends to the JSONL ledger.
 *
 * SECURITY:
 *   - Key resolved via ProviderGateway + GlobalKeyStrategy ONLY
 *   - Key is NEVER logged, printed, or persisted
 *   - Only normalized telemetry is written to ledger (no prompt, no raw response)
 *
 * Prerequisites:
 *   OPENAI_API_KEY must be injected in the shell before running
 *
 * Usage:
 *   node scripts/live/run_and_record_openai.mjs [model] [sessionTag]
 *
 * Model must be present in src/pricing/CostUnits.ts MODEL_WEIGHTS_INT table.
 * Safe defaults: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
 *
 * @since U7.8
 */

import { performance } from "node:perf_hooks";
import { ProviderGateway } from "../../src/providers/gateway/ProviderGateway.js";
import { GlobalKeyStrategy } from "../../src/providers/strategies/GlobalKeyStrategy.js";
import { parseOpenAIResponse } from "../../src/providers/adapters/OpenAIAdapter.js";
import { UsageLedger } from "../../src/metering/ledger/UsageLedger.js";

const model = (process.argv[2] || "gpt-4o").toLowerCase();
const sessionTag = process.argv[3] || "otk_live";

const ledger = new UsageLedger("docs/_ops/_usage_ledger/usage_events.jsonl");

// ProviderGateway is the single authorized path for key resolution (U7.7)
const gateway = new ProviderGateway(new GlobalKeyStrategy());
const key = await gateway.resolveKey("openai");

const t0 = performance.now();
const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Say 'ok'." }],
    temperature: 0,
  }),
});
const t1 = performance.now();

const json = await res.json().catch(() => ({}));

if (!res.ok) {
  // Surface only the safe error message (no headers, no key)
  const msg = json?.error?.message ?? `HTTP ${res.status}`;
  console.error(`OpenAI call failed: ${msg}`);
  process.exit(1);
}

// Normalize via U7.5 adapter — applies proper CU calculation from CostUnits engine
const event = parseOpenAIResponse(json, Math.round(t1 - t0));

// Append to ledger (JSONL) — forbidden fields guard runs inside append()
ledger.append({
  tsUnix: Math.floor(Date.now() / 1000),
  iso: new Date().toISOString(),
  provider: event.provider,
  model: event.model,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  totalTokens: event.totalTokens,
  latencyMs: event.latencyMs,
  costUnits: event.costUnits,
  requestId: event.requestId,
  sessionTag,
});

console.log("OK: appended to ledger");
console.log(JSON.stringify({
  provider: event.provider,
  model: event.model,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  latencyMs: event.latencyMs,
  costUnits: event.costUnits,
  sessionTag,
}, null, 2));
