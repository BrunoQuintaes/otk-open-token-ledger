/**
 * UsageEvent — append-only telemetry record for dissertation / live evidence (U7.8)
 *
 * SECURITY: MUST NOT include prompts, raw responses, headers, authorization, or secrets.
 * Only normalized, non-sensitive metering fields are permitted.
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
  sessionTag?: string;                    // optional grouping label (e.g., "bruno_thesis_week1")
};
