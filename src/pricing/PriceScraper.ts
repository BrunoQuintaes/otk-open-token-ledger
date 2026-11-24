/**
 * PI-03 — PriceScraper
 *
 * HTTP scraper for provider pricing pages.
 * Parses OpenAI, Anthropic, and Gemini pricing pages to extract current model prices.
 *
 * Design:
 * - Each scraper is independent; failures are per-provider, not global
 * - Returns null on failure (falls back to seed via PriceStore)
 * - Uses native fetch (Node 18+)
 * - In production, run behind OTK_PRICE_SCRAPE_ENABLED=true guard
 *
 * @module pricing/PriceScraper
 * @since W7 (PI-03)
 */

import type { ModelPrice } from './economics/ProviderPriceTable.js';

export type ScrapeResult = {
  provider: string;
  models: Record<string, ModelPrice>;
  scrapedAt: string;
  source: string;
};

/**
 * Scrape OpenAI pricing page.
 * Returns null on fetch/parse failure.
 */
export async function scrapeOpenAI(): Promise<ScrapeResult | null> {
  try {
    const res = await fetch('https://openai.com/api/pricing', {
      headers: { 'User-Agent': 'OTK-PriceScraper/1.0 (price-monitoring; +https://otk.dev)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Pattern: look for price rows with model names and USD values
    // This is a heuristic parser — adjust regex if OpenAI changes their page structure
    const models: Record<string, ModelPrice> = {};
    const patterns: Array<[string, RegExp, RegExp]> = [
      ['gpt-4o',        /gpt-4o[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i, /gpt-4o/i],
      ['gpt-4-turbo',   /gpt-4-turbo[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i, /gpt-4-turbo/i],
      ['gpt-3.5-turbo', /gpt-3\.5-turbo[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i, /gpt-3\.5-turbo/i],
      ['o1-preview',    /o1-preview[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i, /o1-preview/i],
      ['o1-mini',       /o1-mini[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i, /o1-mini/i],
    ];

    for (const [model, pattern] of patterns) {
      const m = html.match(pattern);
      if (m && m[1] && m[2]) {
        const input = parseFloat(m[1]);
        const output = parseFloat(m[2]);
        if (!isNaN(input) && !isNaN(output) && input > 0 && output > 0) {
          models[model] = { inputUsdPer1K: input, outputUsdPer1K: output };
        }
      }
    }

    if (Object.keys(models).length === 0) return null;
    return { provider: 'openai', models, scrapedAt: new Date().toISOString(), source: 'https://openai.com/api/pricing' };
  } catch {
    return null;
  }
}

/**
 * Scrape Anthropic pricing page.
 * Returns null on fetch/parse failure.
 */
export async function scrapeAnthropic(): Promise<ScrapeResult | null> {
  try {
    const res = await fetch('https://www.anthropic.com/pricing', {
      headers: { 'User-Agent': 'OTK-PriceScraper/1.0 (price-monitoring; +https://otk.dev)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const models: Record<string, ModelPrice> = {};
    const patterns: Array<[string, RegExp]> = [
      ['claude-opus-4',    /claude-opus[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
      ['claude-sonnet-4',  /claude-sonnet[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
      ['claude-haiku-4',   /claude-haiku[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
    ];

    for (const [model, pattern] of patterns) {
      const m = html.match(pattern);
      if (m && m[1] && m[2]) {
        const input = parseFloat(m[1]);
        const output = parseFloat(m[2]);
        if (!isNaN(input) && !isNaN(output) && input > 0 && output > 0) {
          models[model] = { inputUsdPer1K: input, outputUsdPer1K: output };
        }
      }
    }

    if (Object.keys(models).length === 0) return null;
    return { provider: 'anthropic', models, scrapedAt: new Date().toISOString(), source: 'https://www.anthropic.com/pricing' };
  } catch {
    return null;
  }
}

/**
 * Scrape Gemini pricing page.
 * Returns null on fetch/parse failure.
 */
export async function scrapeGemini(): Promise<ScrapeResult | null> {
  try {
    const res = await fetch('https://ai.google.dev/pricing', {
      headers: { 'User-Agent': 'OTK-PriceScraper/1.0 (price-monitoring; +https://otk.dev)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const models: Record<string, ModelPrice> = {};
    const patterns: Array<[string, RegExp]> = [
      ['gemini-2.0-flash', /gemini[- ]2\.0[- ]flash[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
      ['gemini-pro',       /gemini[- ]pro[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
      ['gemini-ultra',     /gemini[- ]ultra[\s\S]{0,200}?\$([\d.]+)[\s\S]{0,50}?\$([\d.]+)/i],
    ];

    for (const [model, pattern] of patterns) {
      const m = html.match(pattern);
      if (m && m[1] && m[2]) {
        const input = parseFloat(m[1]);
        const output = parseFloat(m[2]);
        if (!isNaN(input) && !isNaN(output) && input > 0 && output > 0) {
          models[model] = { inputUsdPer1K: input, outputUsdPer1K: output };
        }
      }
    }

    if (Object.keys(models).length === 0) return null;
    return { provider: 'gemini', models, scrapedAt: new Date().toISOString(), source: 'https://ai.google.dev/pricing' };
  } catch {
    return null;
  }
}

/**
 * Run all scrapers and return results per provider.
 * Failures are isolated — a failed provider doesn't affect others.
 */
export async function scrapeAllProviders(): Promise<ScrapeResult[]> {
  const results = await Promise.allSettled([
    scrapeOpenAI(),
    scrapeAnthropic(),
    scrapeGemini(),
  ]);

  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => (r as PromiseFulfilledResult<ScrapeResult>).value);
}
