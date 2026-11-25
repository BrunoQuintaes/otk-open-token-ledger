/**
 * PAY-02 — ProviderBillingImporter
 * Imports usage records from provider billing APIs for reconciliation.
 *
 * Fetches actual spend data from OpenAI / Anthropic dashboards so OTK
 * can cross-reference its computed costs against provider-side totals.
 *
 * Non-fatal: on any error (missing key, network failure, unexpected
 * response shape) the function returns an empty ImportResult so that
 * the reconciliation pipeline is never blocked.
 *
 * Side effect: one outbound HTTPS request per call, using the provider key passed in by the caller (this module
 * reads no environment variable). No caller in `src/` at the evaluated version. The record fields are read from
 * the response by name (`date`, `cost`, `n_requests` / `request_count`); a missing field becomes the start date
 * or 0, so a total of 0 can mean "no data" as well as "no spend".
 *
 * @module src/billing/ProviderBillingImporter
 * @since W9-A (PAY-02)
 */

/** One day of provider-reported usage. */
export interface ProviderUsageRecord {
  provider: string;
  date: string;       // YYYY-MM-DD
  /** Spend reported by the provider for that day, in USD (0 when the field is missing). */
  totalUsd: number;
  /** Requests reported for that day (0 when the field is missing). */
  requestCount: number;
}

/** Result of one import call; empty (`records: []`, `totalUsd: 0`) on any failure. */
export interface ImportResult {
  provider: string;
  /** Daily records as returned by the provider. */
  records: ProviderUsageRecord[];
  /** Sum of the records' `totalUsd`, in USD. */
  totalUsd: number;
  /** Time of the import, ISO 8601. */
  importedAt: string;
}

function emptyResult(provider: string): ImportResult {
  return {
    provider,
    records: [],
    totalUsd: 0,
    importedAt: new Date().toISOString(),
  };
}

/**
 * Import daily usage records from the OpenAI billing API.
 * Returns an empty ImportResult when apiKey is missing or the request fails.
 *
 * @param apiKey - OpenAI admin key; an empty string skips the request.
 * @param startDate - First day, `YYYY-MM-DD`.
 * @param endDate - Last day, `YYYY-MM-DD`.
 * @returns The imported records (never rejects).
 */
export async function importOpenAIUsage(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<ImportResult> {
  if (!apiKey) return emptyResult('openai');
  try {
    const url = `https://api.openai.com/v1/usage?start_date=${startDate}&end_date=${endDate}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return emptyResult('openai');
    const data = await response.json() as Record<string, unknown>;
    // OpenAI usage response: { data: [{ aggregation_timestamp, n_requests, n_generated_tokens_total, ... }] }
    const raw = Array.isArray(data['data']) ? (data['data'] as Record<string, unknown>[]) : [];
    const records: ProviderUsageRecord[] = raw.map(entry => ({
      provider: 'openai',
      date: entry['date'] as string ?? startDate,
      totalUsd: typeof entry['cost'] === 'number' ? (entry['cost'] as number) : 0,
      requestCount: typeof entry['n_requests'] === 'number' ? (entry['n_requests'] as number) : 0,
    }));
    const totalUsd = records.reduce((s, r) => s + r.totalUsd, 0);
    return { provider: 'openai', records, totalUsd, importedAt: new Date().toISOString() };
  } catch {
    return emptyResult('openai');
  }
}

/**
 * Import daily usage records from the Anthropic billing API.
 * Returns an empty ImportResult when apiKey is missing or the request fails.
 *
 * @param apiKey - Anthropic admin key; an empty string skips the request.
 * @param startDate - First day, `YYYY-MM-DD`.
 * @param endDate - Last day, `YYYY-MM-DD`.
 * @returns The imported records (never rejects).
 */
export async function importAnthropicUsage(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<ImportResult> {
  if (!apiKey) return emptyResult('anthropic');
  try {
    const url = `https://api.anthropic.com/v1/usage?start_date=${startDate}&end_date=${endDate}`;
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return emptyResult('anthropic');
    const data = await response.json() as Record<string, unknown>;
    const raw = Array.isArray(data['data']) ? (data['data'] as Record<string, unknown>[]) : [];
    const records: ProviderUsageRecord[] = raw.map(entry => ({
      provider: 'anthropic',
      date: entry['date'] as string ?? startDate,
      totalUsd: typeof entry['cost'] === 'number' ? (entry['cost'] as number) : 0,
      requestCount: typeof entry['request_count'] === 'number' ? (entry['request_count'] as number) : 0,
    }));
    const totalUsd = records.reduce((s, r) => s + r.totalUsd, 0);
    return { provider: 'anthropic', records, totalUsd, importedAt: new Date().toISOString() };
  } catch {
    return emptyResult('anthropic');
  }
}
