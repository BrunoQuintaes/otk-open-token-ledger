/**
 * PI-04 — PriceScheduler
 *
 * 24h interval scheduler for price scraping.
 * Runs scrapeAllProviders(), writes results to PriceStore,
 * and emits a `price.updated` webhook event.
 *
 * Enable via OTK_PRICE_SCRAPE_ENABLED=true.
 * First run fires immediately on start, then every 24h.
 *
 * Side effects of a run: outbound HTTPS requests to provider pricing pages (see `PriceScraper.ts`), writes
 * through `PriceStore.ts`, and a `price.updated` webhook dispatch to registered subscribers. Scheduler state is
 * per process and in memory.
 *
 * @module src/pricing/PriceScheduler
 * @since W7 (PI-04)
 */

import { scrapeAllProviders } from './PriceScraper.js';
import { setProviderPrices } from './PriceStore.js';
import { getWebhookStore } from '../webhooks/WebhookRegistry.js';
import { WebhookRetryQueue } from '../webhooks/WebhookRetryQueue.js';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let _timer: ReturnType<typeof setInterval> | null = null;
let _lastRunAt: string | null = null;
let _lastResult: { updated: string[]; failed: string[]; } | null = null;

/**
 * Run one price scrape cycle.
 * Writes successful scrapes to PriceStore and emits webhook.
 *
 * Runs regardless of OTK_PRICE_SCRAPE_ENABLED (only the scheduler checks it). Webhook failures are ignored.
 *
 * @returns Providers whose prices were stored and providers whose store write failed. Providers whose scrape
 *   failed are in neither list.
 */
export async function runPriceScrape(): Promise<{ updated: string[]; failed: string[] }> {
  const results = await scrapeAllProviders();
  const updated: string[] = [];
  const failed: string[] = [];

  for (const result of results) {
    try {
      await setProviderPrices(result.provider, result.models);
      updated.push(result.provider);
    } catch {
      failed.push(result.provider);
    }
  }

  _lastRunAt = new Date().toISOString();
  _lastResult = { updated, failed };

  // Emit price.updated webhook event if any prices were updated
  if (updated.length > 0) {
    try {
      const wStore = getWebhookStore();
      const queue = new WebhookRetryQueue(wStore);
      await queue.dispatch('price.updated', {
        updatedProviders: updated,
        failedProviders: failed,
        updatedAt: _lastRunAt,
      });
    } catch { /* non-fatal */ }
  }

  return { updated, failed };
}

/**
 * Start the 24h price scrape scheduler.
 * No-op if OTK_PRICE_SCRAPE_ENABLED is not 'true'.
 * No-op if already running.
 *
 * In this version no code under `src/` calls this function, so the scheduler only runs when an embedding
 * caller starts it.
 */
export function startPriceScheduler(): void {
  if (process.env['OTK_PRICE_SCRAPE_ENABLED'] !== 'true') return;
  if (_timer) return; // already running

  // First run immediately (async, non-blocking)
  void runPriceScrape();

  _timer = setInterval(() => {
    void runPriceScrape();
  }, INTERVAL_MS);

  // Allow process to exit even if timer is active
  if (_timer.unref) _timer.unref();
}

/**
 * Stop the scheduler. Primarily for testing.
 */
export function stopPriceScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Get scheduler status (for health/status endpoints).
 *
 * @returns Whether the timer runs, whether it is enabled by the environment, and the last run's time and result.
 */
export function getPriceSchedulerStatus(): {
  running: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: { updated: string[]; failed: string[] } | null;
} {
  return {
    running: _timer !== null,
    enabled: process.env['OTK_PRICE_SCRAPE_ENABLED'] === 'true',
    lastRunAt: _lastRunAt,
    lastResult: _lastResult,
  };
}
