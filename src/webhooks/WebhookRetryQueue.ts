/**
 * WebhookRetryQueue — exponential backoff retry + dead-letter queue (E6.6 / NEW-4.05)
 *
 * Retry policy:
 *   Attempt 1: immediate
 *   Attempt 2: 1 second delay
 *   Attempt 3: 5 second delay
 *   Attempt 4: 30 second delay
 *   Attempt 5: 5 minute delay
 *   After 5 failed attempts: move to dead-letter queue
 *
 * @module webhooks/WebhookRetryQueue
 * @since Wave 4 (4E-PACK-4E01 / E6.6)
 */

import crypto from 'node:crypto';
import type { WebhookEndpoint, IWebhookStore, WebhookDeadLetter } from './WebhookRegistry.js';
import { WebhookDelivery, type HttpPostFn } from './WebhookDelivery.js';

// ──────────────────────────────────────────────────────────
// Retry delays (ms)
// ──────────────────────────────────────────────────────────

export const RETRY_DELAYS_MS = [0, 1_000, 5_000, 30_000, 300_000]; // attempt 1-5

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

// ──────────────────────────────────────────────────────────
// WebhookRetryQueue
// ──────────────────────────────────────────────────────────

export interface RetryJob {
  endpoint: WebhookEndpoint;
  eventKind: string;
  data: unknown;
  attempt: number;
}

export class WebhookRetryQueue {
  private _delivery: WebhookDelivery;
  private _store: IWebhookStore;
  private _timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(store: IWebhookStore, httpPost?: HttpPostFn) {
    this._store = store;
    this._delivery = new WebhookDelivery(httpPost);
  }

  /**
   * Enqueue delivery for an endpoint. Schedules attempt 1 immediately.
   */
  enqueue(endpoint: WebhookEndpoint, eventKind: string, data: unknown): void {
    this._scheduleAttempt({ endpoint, eventKind, data, attempt: 1 }, 0);
  }

  /**
   * Dispatch an event to all matching active endpoints.
   */
  async dispatch(eventKind: string, data: unknown, tenantId?: string): Promise<void> {
    const endpoints = await this._store.listEndpoints(tenantId);
    for (const ep of endpoints) {
      if (!ep.active) continue;
      if (!ep.events.includes('*') && !ep.events.includes(eventKind)) continue;
      this.enqueue(ep, eventKind, data);
    }
  }

  private _scheduleAttempt(job: RetryJob, delayMs: number): void {
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      void this._executeAttempt(job);
    }, delayMs);
    this._timers.add(timer);
  }

  private async _executeAttempt(job: RetryJob): Promise<void> {
    const { endpoint, eventKind, data, attempt } = job;
    const body = JSON.stringify({ event: eventKind, timestamp: Math.floor(Date.now() / 1000), data });
    const result = await this._delivery.deliver(endpoint, eventKind, data);
    const log = this._delivery.buildDeliveryLog(endpoint.id, eventKind, body, attempt, result);
    await this._store.logDelivery(log);

    if (result.ok) return; // success — done

    if (attempt < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
      this._scheduleAttempt({ ...job, attempt: attempt + 1 }, delay);
    } else {
      // Exhausted retries — move to dead-letter queue
      const dl: WebhookDeadLetter = {
        id: crypto.randomUUID(),
        endpointId: endpoint.id,
        eventKind,
        payload: body,
        attempts: attempt,
        lastError: result.error ?? `HTTP ${result.statusCode}`,
        createdAt: new Date().toISOString(),
      };
      await this._store.addDeadLetter(dl);
    }
  }

  /** Cancel all pending timers (for test cleanup). */
  drain(): void {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  get pendingCount(): number { return this._timers.size; }
}
