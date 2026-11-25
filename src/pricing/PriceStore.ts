/**
 * PI-02 — PriceStore
 *
 * Redis-backed price store with TTL 25h and fallback to price_seed.json.
 * Used by CostBridge for live USD cost calculations.
 *
 * Keys: `otk:prices:<provider>:<model>` → JSON { inputUsdPer1K, outputUsdPer1K, updatedAt }
 * TTL: 25h (ensures daily scrape keeps data fresh; expired → fallback to seed)
 *
 * Read by `economics/CostBridge.ts` and by the admin prices route in `src/api/routes.ts`. Without a ready Redis
 * client every write is skipped and every read returns `null` (no error). The seed file is
 * `src/pricing/data/price_seed.json`.
 *
 * @module src/pricing/PriceStore
 * @since W7 (PI-02)
 */

import { readFileSync } from 'node:fs';
import { getRedisClient } from '../infra/redis/redisClient.js';
import type { ModelPrice } from './economics/ProviderPriceTable.js';

const PRICE_TTL_S = 25 * 60 * 60; // 25 hours
const KEY_PREFIX = 'otk:prices:';

/** A price as stored in Redis, with the time it was written. */
export interface StoredPrice extends ModelPrice {
  updatedAt: string; // ISO timestamp of last scrape
}

/**
 * Write a price entry to Redis. Non-fatal if Redis unavailable.
 *
 * Provider and model are lower-cased in the key; Redis errors are swallowed.
 *
 * @param provider - Provider id.
 * @param model - Model id.
 * @param price - Input/output prices to store (expire after 25 hours).
 */
export async function setPrice(provider: string, model: string, price: ModelPrice): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  const key = `${KEY_PREFIX}${provider.toLowerCase()}:${model.toLowerCase()}`;
  const value: StoredPrice = { ...price, updatedAt: new Date().toISOString() };
  try {
    await redis.rawClient.set(key, JSON.stringify(value), 'EX', PRICE_TTL_S);
  } catch { /* non-fatal */ }
}

/**
 * Read a price entry from Redis. Returns null if not found or Redis unavailable.
 *
 * @param provider - Provider id (case-insensitive).
 * @param model - Model id (case-insensitive).
 * @returns The stored price, or `null` (also when the stored JSON is unreadable).
 */
export async function getPrice(provider: string, model: string): Promise<StoredPrice | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) return null;
  const key = `${KEY_PREFIX}${provider.toLowerCase()}:${model.toLowerCase()}`;
  try {
    const raw = await redis.rawClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPrice;
  } catch {
    return null;
  }
}

/**
 * Write an entire provider price table to Redis.
 *
 * @param provider - Provider id.
 * @param models - Model id → price; written one by one.
 */
export async function setProviderPrices(provider: string, models: Record<string, ModelPrice>): Promise<void> {
  for (const [model, price] of Object.entries(models)) {
    await setPrice(provider, model, price);
  }
}

/**
 * List all cached price entries from Redis (for /v1/admin/prices endpoint).
 * Returns flat array with provider/model/price/updatedAt/staleness.
 *
 * Only models listed in the seed file are returned; a Redis value overrides the seed price.
 *
 * @returns One row per seed model; `staleHours` (one decimal) and `updatedAt` are `null` for seed rows.
 * @throws {Error} When the seed file cannot be read or parsed.
 */
export async function listPrices(): Promise<Array<{
  provider: string;
  model: string;
  inputUsdPer1K: number;
  outputUsdPer1K: number;
  updatedAt: string | null;
  staleHours: number | null;
  source: 'redis' | 'seed';
}>> {
  // Load seed as baseline
  const seed: unknown = JSON.parse(readFileSync(new URL('./data/price_seed.json', import.meta.url), 'utf-8'));
  const results: ReturnType<typeof listPrices> extends Promise<infer T> ? T : never = [];
  const now = Date.now();

  for (const [prov, models] of Object.entries(seed as Record<string, unknown>)) {
    if (prov.startsWith('_')) continue;
    for (const [model] of Object.entries(models as Record<string, unknown>)) {
      const live = await getPrice(prov, model);
      if (live) {
        const updatedMs = new Date(live.updatedAt).getTime();
        const staleHours = Math.round((now - updatedMs) / 3_600_000 * 10) / 10;
        results.push({
          provider: prov,
          model,
          inputUsdPer1K: live.inputUsdPer1K,
          outputUsdPer1K: live.outputUsdPer1K,
          updatedAt: live.updatedAt,
          staleHours,
          source: 'redis',
        });
      } else {
        const seedPrice = (models as Record<string, ModelPrice>)[model]!;
        results.push({
          provider: prov,
          model,
          inputUsdPer1K: seedPrice.inputUsdPer1K,
          outputUsdPer1K: seedPrice.outputUsdPer1K,
          updatedAt: null,
          staleHours: null,
          source: 'seed',
        });
      }
    }
  }
  return results;
}
