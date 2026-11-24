/**
 * SseRouter — SSE endpoint handler (P5.2)
 *
 * Handles GET /v1/stream:
 *   - Auth via JWT or API key (authMiddleware)
 *   - Registers connection in StreamManager
 *   - Supports Last-Event-ID header for reconnection
 *   - Sends keepalive ping every 30s (managed by StreamManager)
 *
 * @module streaming/SseRouter
 * @since Wave 4 (4F-PACK-4F01 / P5.2)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getStreamManager } from './StreamManager.js';

export const SSE_EVENTS = ['receipt_submitted', 'proof_ready', 'chain_anchored'] as const;
export type SseEventKind = typeof SSE_EVENTS[number];

/**
 * Handle GET /v1/stream — upgrades connection to SSE.
 * Auth must already be validated by the caller (routes.ts).
 * tenantId is extracted from the validated token context.
 */
export function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
): void {
  const lastEventId = req.headers['last-event-id'] as string | undefined ?? null;
  const manager = getStreamManager();
  manager.connect(tenantId, res, lastEventId);
  // Connection stays open; cleanup handled by StreamManager on 'close' event
}

/**
 * Publish an event to all SSE connections for a tenant.
 * Called by route handlers after significant events occur.
 */
export function publishSseEvent(tenantId: string, event: SseEventKind, data: unknown): void {
  getStreamManager().send(tenantId, { event, data });
}

/**
 * Broadcast an event to all connected SSE clients (all tenants).
 */
export function broadcastSseEvent(event: SseEventKind, data: unknown): void {
  getStreamManager().send('*', { event, data });
}
