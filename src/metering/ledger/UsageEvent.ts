/**
 * UsageEvent — append-only telemetry record for dissertation / live evidence (U7.8)
 *
 * SECURITY: MUST NOT include prompts, raw responses, headers, authorization, or secrets.
 * Only normalized, non-sensitive metering fields are permitted.
 *
 * Written by {@link UsageLedger} (`src/metering/ledger/UsageLedger.ts`), which rejects forbidden keys at
 * append time; read back by the economics reports under `src/pricing/economics/`.
 *
 * @module src/metering/ledger/UsageEvent
 */

/**
 * One metered provider call, as stored in one line of the usage JSONL ledger.
 *
 * Token fields are counts in tokens; `latencyMs` is wall-clock milliseconds. Optional fields absent means
 * "not recorded", never zero.
 */
export type UsageEvent = {
  tsUnix: number;                         // Unix timestamp (seconds)
  iso: string;                            // ISO 8601 datetime string
  provider: "openai" | "anthropic" | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUnits: number;                      // project-internal CU (from CostUnits engine)
  currency?: string;                      // optional (e.g., "USD")
  cost?: number;                          // optional monetary cost
  requestId?: string;                     // provider-assigned request ID (safe, not a secret)
  sessionTag?: string;                    // optional grouping label (e.g., "thesis_week1")
};
