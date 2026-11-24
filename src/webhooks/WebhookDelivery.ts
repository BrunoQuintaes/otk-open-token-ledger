/**
 * WebhookDelivery — HTTP POST delivery + HMAC-SHA256 signing (E6.6 / NEW-4.05)
 *
 * Delivery format:
 *   POST <endpoint_url>
 *   Headers:
 *     X-OTK-Signature: sha256=<hmac>
 *     X-OTK-Event: <eventKind>
 *     X-OTK-Timestamp: <unix seconds>
 *   Body: { event, timestamp, data }
 *
 * @module webhooks/WebhookDelivery
 * @since Wave 4 (4E-PACK-4E01 / E6.6)
 */

import crypto from 'node:crypto';
import type { WebhookEndpoint, WebhookDeliveryLog } from './WebhookRegistry.js';
import { createSafeWebhookHttpPost } from './destinationPolicy.js';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface WebhookPayload {
  event: string;
  timestamp: number;
  data: unknown;
}

export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  durationMs?: number;
}

/** Injectable HTTP POST function for testability */
export type HttpPostFn = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number }>;

// ──────────────────────────────────────────────────────────
// HMAC signing
// ──────────────────────────────────────────────────────────

export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const signingKey = `${timestamp}.${body}`;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(signingKey).digest('hex');
}

export function verifyWebhookSignature(secret: string, body: string, timestamp: number, signature: string): boolean {
  const expected = signWebhookPayload(secret, body, timestamp);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────
// Default HTTP POST: SSRF-guarded transport
// ──────────────────────────────────────────────────────────

// H1R2 S21-F01: the default transport validates the destination on every delivery (https only, every resolved address
// public, connection pinned to the validated address, no redirect followed, timeout, body not read). The previous
// transport posted to any URL, loopback and cloud metadata included.
const defaultHttpPost: HttpPostFn = createSafeWebhookHttpPost();

// ──────────────────────────────────────────────────────────
// WebhookDelivery
// ──────────────────────────────────────────────────────────

export class WebhookDelivery {
  private _httpPost: HttpPostFn;

  constructor(httpPost?: HttpPostFn) {
    this._httpPost = httpPost ?? defaultHttpPost;
  }

  /**
   * Deliver an event to a single endpoint.
   */
  async deliver(endpoint: WebhookEndpoint, eventKind: string, data: unknown): Promise<DeliveryResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload: WebhookPayload = { event: eventKind, timestamp, data };
    const body = JSON.stringify(payload);
    const signature = signWebhookPayload(endpoint.secret, body, timestamp);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-OTK-Signature': signature,
      'X-OTK-Event': eventKind,
      'X-OTK-Timestamp': String(timestamp),
    };

    const start = Date.now();
    try {
      const result = await this._httpPost(endpoint.url, headers, body);
      const durationMs = Date.now() - start;
      const ok = result.status >= 200 && result.status < 300;
      return { ok, statusCode: result.status, durationMs };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Build a delivery log entry from a delivery result.
   */
  buildDeliveryLog(
    endpointId: string,
    eventKind: string,
    body: string,
    attempt: number,
    result: DeliveryResult,
  ): WebhookDeliveryLog {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      endpointId,
      eventKind,
      payload: body,
      attempt,
      status: result.ok ? 'success' : 'failed',
      statusCode: result.statusCode,
      error: result.error,
      deliveredAt: result.ok ? now : undefined,
      createdAt: now,
    };
  }
}
