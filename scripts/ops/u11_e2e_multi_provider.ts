/**
 * U11 — E2E Multi-Provider Script
 *
 * Demonstrates the complete OTK metering pipeline for 4 providers:
 *   1. ProviderRegistry resolution (openai, anthropic, gemini, deepseek)
 *   2. Mock response → NormalizedUsageEvent (via provider adapter)
 *   3. CU computation (via CostUnits.ts bigint engine)
 *   4. Canonical receipt payload (CanonicalReceiptV1 + keccak256 hash)
 *   5. Summary report (JSON) → docs/_ops/u11/U11_MULTI_PROVIDER_E2E_<TS>/
 *
 * Runs FULLY OFFLINE — no API keys or live network required.
 * On-chain registration omitted (devnet not guaranteed running); hash is the proof artifact.
 *
 * Usage:
 *   npx tsx scripts/ops/u11_e2e_multi_provider.ts
 *
 * @module scripts/ops/u11_e2e_multi_provider
 * @since U11.2
 */

import { writeFileSync, mkdirSync } from 'fs';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry.js';
import {
  hashCanonicalReceiptV1,
  type CanonicalReceiptV1,
} from '../../src/receipt/canonicalReceiptV1.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USER_ID = 'u11-demo-user';
const PROJECT_ID = 'otk-zk-metering';
const EPOCH_WINDOW_SECONDS = 86400n; // 1-day epoch (same as demo)
const RUN_TS_SEC = BigInt(Math.floor(Date.now() / 1000));
const EPOCH = RUN_TS_SEC / EPOCH_WINDOW_SECONDS;

// ---------------------------------------------------------------------------
// Mock API responses (deterministic, no live API calls)
// ---------------------------------------------------------------------------

const MOCK_RESPONSES: Record<string, { raw: unknown; latencyMs: number }> = {
  openai: {
    raw: {
      id: 'chatcmpl-u11-e2e-001',
      object: 'chat.completion',
      created: Number(RUN_TS_SEC),
      model: 'gpt-4o',
      usage: { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
    },
    latencyMs: 312,
  },
  anthropic: {
    raw: {
      id: 'msg-u11-e2e-001',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4',
      usage: { input_tokens: 500, output_tokens: 250 },
      content: [],
      stop_reason: 'end_turn',
    },
    latencyMs: 445,
  },
  gemini: {
    raw: {
      id: 'gemini-u11-e2e-001',
      model: 'gemini-pro',
      inputTokens: 500,
      outputTokens: 250,
    },
    latencyMs: 198,
  },
  deepseek: {
    raw: {
      id: 'ds-u11-e2e-001',
      model: 'deepseek-chat',
      inputTokens: 500,
      outputTokens: 250,
    },
    latencyMs: 155,
  },
};

// ---------------------------------------------------------------------------
// Receipt builder helper
// ---------------------------------------------------------------------------

function buildReceipt(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  costUnits: number,
  timestampSec: bigint,
  nonce: bigint
): CanonicalReceiptV1 {
  return {
    provider,
    model,
    input_tokens: BigInt(inputTokens),
    output_tokens: BigInt(outputTokens),
    total_tokens: BigInt(inputTokens + outputTokens),
    latency_ms: BigInt(latencyMs),
    cost_unit: BigInt(costUnits),
    user_id: USER_ID,
    project_id: PROJECT_ID,
    timestamp: timestampSec * 1000n, // unix ms
    nonce,
    epoch: EPOCH,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ProviderResult {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUnits: number;
  receiptHash: string;
  nonce: string;
  epoch: string;
}

function main() {
  console.log('='.repeat(70));
  console.log('OTK U11 — Multi-Provider E2E Demo');
  console.log('='.repeat(70));

  const registry = ProviderRegistry.createDefault();
  const providers = registry.listProviders();
  console.log(`\nRegistered providers: [${providers.join(', ')}]\n`);

  const results: ProviderResult[] = [];
  let nonce = BigInt(Math.floor(Math.random() * 1_000_000_000_000));

  for (const providerId of providers) {
    const mock = MOCK_RESPONSES[providerId];
    if (!mock) {
      console.warn(`  [SKIP] No mock response configured for '${providerId}'`);
      continue;
    }

    // 1. Parse mock response via registry adapter
    const adapter = registry.resolve(providerId);
    const event = adapter.parseResponse(mock.raw, mock.latencyMs, Number(RUN_TS_SEC));

    // 2. Build canonical receipt
    nonce++;
    const receipt = buildReceipt(
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.latencyMs,
      event.costUnits,
      RUN_TS_SEC,
      nonce
    );

    // 3. Hash receipt (keccak256 of canonical encoding)
    const receiptHash = hashCanonicalReceiptV1(receipt);

    const result: ProviderResult = {
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      latencyMs: event.latencyMs,
      costUnits: event.costUnits,
      receiptHash,
      nonce: nonce.toString(),
      epoch: EPOCH.toString(),
    };
    results.push(result);

    console.log(`[${providerId.toUpperCase()}]`);
    console.log(`  Model:       ${event.model}`);
    console.log(`  Tokens:      ${event.inputTokens} in + ${event.outputTokens} out = ${event.totalTokens}`);
    console.log(`  Latency:     ${event.latencyMs}ms`);
    console.log(`  CU:          ${event.costUnits}`);
    console.log(`  ReceiptHash: ${receiptHash}`);
    console.log(`  Nonce:       ${nonce}`);
    console.log(`  Epoch:       ${EPOCH}`);
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const totalCU = results.reduce((sum, r) => sum + r.costUnits, 0);
  const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;

  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Providers run:   ${results.length}`);
  console.log(`Total CU:        ${totalCU}`);
  console.log(`Avg latency:     ${avgLatency.toFixed(0)}ms`);
  console.log(`Run epoch:       ${EPOCH}`);
  console.log();

  // CU ranking
  const ranked = [...results].sort((a, b) => a.costUnits - b.costUnits);
  console.log('CU Ranking (ascending):');
  ranked.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.provider.padEnd(12)} ${r.model.padEnd(20)} CU=${r.costUnits}`);
  });

  // ---------------------------------------------------------------------------
  // Write JSON report
  // ---------------------------------------------------------------------------

  const tsLabel = new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 19);
  const evidenceDir = `docs/_ops/u11/U11_MULTI_PROVIDER_E2E_${tsLabel}`;
  mkdirSync(evidenceDir, { recursive: true });

  const report = {
    runTimestamp: new Date().toISOString(),
    epochDay: EPOCH.toString(),
    userId: USER_ID,
    projectId: PROJECT_ID,
    registeredProviders: providers,
    results,
    summary: {
      providersRun: results.length,
      totalCU,
      avgLatencyMs: parseFloat(avgLatency.toFixed(1)),
      cuRanking: ranked.map(r => ({ provider: r.provider, model: r.model, costUnits: r.costUnits })),
    },
  };

  writeFileSync(`${evidenceDir}/01_run_report.json`, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${evidenceDir}/01_run_report.json`);

  return report;
}

main();
