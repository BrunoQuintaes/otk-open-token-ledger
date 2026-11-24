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
 * @module billing/ProviderBillingImporter
 * @since W9-A (PAY-02)
 */

export interface ProviderUsageRecord {
  provider: string;
  date: string;       // YYYY-MM-DD
  totalUsd: number;
  requestCount: number;
}

export interface ImportResult {
  provider: string;
  records: ProviderUsageRecord[];
  totalUsd: number;
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
