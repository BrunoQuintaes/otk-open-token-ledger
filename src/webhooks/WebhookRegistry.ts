/**
 * WebhookRegistry — webhook endpoint store + delivery log types (E6.6 / NEW-4.05)
 *
 * Provides:
 *   - WebhookEndpoint type + in-memory IWebhookStore implementation
 *   - Delivery log and dead-letter types
 *   - Module-level singleton accessors
 *
 * @module webhooks/WebhookRegistry
 * @since Wave 4 (4E-PACK-4E01 / E6.6)
 */

import crypto from 'node:crypto';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  events: string[];    // event kinds to subscribe to, or ['*'] for all
  active: boolean;
  secret: string;      // per-endpoint HMAC signing secret
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'success' | 'failed' | 'pending';

export interface WebhookDeliveryLog {
  id: string;
  endpointId: string;
  eventKind: string;
  payload: string;     // JSON string
  attempt: number;
  status: DeliveryStatus;
  statusCode?: number;
  error?: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface WebhookDeadLetter {
  id: string;
  endpointId: string;
  eventKind: string;
  payload: string;     // JSON string
  attempts: number;
  lastError: string;
  createdAt: string;
  replayedAt?: string;
}

// ──────────────────────────────────────────────────────────
// IWebhookStore interface
// ──────────────────────────────────────────────────────────

export interface IWebhookStore {
  createEndpoint(ep: WebhookEndpoint): Promise<void>;
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;
  listEndpoints(tenantId?: string): Promise<WebhookEndpoint[]>;
  deleteEndpoint(id: string): Promise<boolean>;
  logDelivery(delivery: WebhookDeliveryLog): Promise<void>;
  listDeliveries(endpointId: string): Promise<WebhookDeliveryLog[]>;
  addDeadLetter(entry: WebhookDeadLetter): Promise<void>;
  listDeadLetters(endpointId?: string): Promise<WebhookDeadLetter[]>;
  updateDeadLetterReplay(id: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────
// MemoryWebhookStore (default / test implementation)
// ──────────────────────────────────────────────────────────

export class MemoryWebhookStore implements IWebhookStore {
  private _endpoints = new Map<string, WebhookEndpoint>();
  private _deliveries: WebhookDeliveryLog[] = [];
  private _deadLetters = new Map<string, WebhookDeadLetter>();

  async createEndpoint(ep: WebhookEndpoint): Promise<void> {
    this._endpoints.set(ep.id, ep);
  }

  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return this._endpoints.get(id) ?? null;
  }

  async listEndpoints(tenantId?: string): Promise<WebhookEndpoint[]> {
    const all = [...this._endpoints.values()];
    return tenantId ? all.filter(e => e.tenantId === tenantId) : all;
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    return this._endpoints.delete(id);
  }

  async logDelivery(delivery: WebhookDeliveryLog): Promise<void> {
    this._deliveries.push(delivery);
  }

  async listDeliveries(endpointId: string): Promise<WebhookDeliveryLog[]> {
    return this._deliveries.filter(d => d.endpointId === endpointId);
  }

  async addDeadLetter(entry: WebhookDeadLetter): Promise<void> {
    this._deadLetters.set(entry.id, entry);
  }

  async listDeadLetters(endpointId?: string): Promise<WebhookDeadLetter[]> {
    const all = [...this._deadLetters.values()];
    return endpointId ? all.filter(d => d.endpointId === endpointId) : all;
  }

  async updateDeadLetterReplay(id: string): Promise<boolean> {
    const entry = this._deadLetters.get(id);
    if (!entry) return false;
    this._deadLetters.set(id, { ...entry, replayedAt: new Date().toISOString() });
    return true;
  }
}

// ──────────────────────────────────────────────────────────
// Module-level singleton
// ──────────────────────────────────────────────────────────

let _store: IWebhookStore = new MemoryWebhookStore();

export function getWebhookStore(): IWebhookStore { return _store; }
export function setWebhookStore(store: IWebhookStore): void { _store = store; }

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

export function createWebhookEndpoint(
  tenantId: string,
  url: string,
  events: string[],
  secret?: string,
): WebhookEndpoint {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId,
    url,
    events: events.length > 0 ? events : ['*'],
    active: true,
    secret: secret ?? crypto.randomBytes(32).toString('hex'),
    createdAt: now,
    updatedAt: now,
  };
}
