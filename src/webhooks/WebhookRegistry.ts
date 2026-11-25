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

/**
 * A tenant's webhook destination; `secret` must never be returned by list endpoints.
 */
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

/**
 * Status of one delivery attempt in the log.
 */
export type DeliveryStatus = 'success' | 'failed' | 'pending';

/**
 * Log entry of one delivery attempt.
 */
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

/**
 * An event that failed every attempt and was moved to the dead-letter list.
 */
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

/**
 * Storage backend for endpoints, delivery logs and dead letters.
 */
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

/**
 * In-memory webhook store (default and tests); records are stored by reference and lost on restart.
 */
export class MemoryWebhookStore implements IWebhookStore {
  private _endpoints = new Map<string, WebhookEndpoint>();
  private _deliveries: WebhookDeliveryLog[] = [];
  private _deadLetters = new Map<string, WebhookDeadLetter>();

  /**
   * Stores an endpoint (replaces one with the same ID).
   *
   * @param ep - Endpoint to store.
   */
  async createEndpoint(ep: WebhookEndpoint): Promise<void> {
    this._endpoints.set(ep.id, ep);
  }

  /**
   * Reads an endpoint.
   *
   * @param id - Endpoint ID.
   * @returns The endpoint, or `null`.
   */
  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return this._endpoints.get(id) ?? null;
  }

  /**
   * Lists endpoints.
   *
   * @param tenantId - Tenant filter; when absent or empty, endpoints of ALL tenants are returned.
   * @returns The endpoints, secrets included.
   */
  async listEndpoints(tenantId?: string): Promise<WebhookEndpoint[]> {
    const all = [...this._endpoints.values()];
    return tenantId ? all.filter(e => e.tenantId === tenantId) : all;
  }

  /**
   * Deletes an endpoint.
   *
   * @param id - Endpoint ID.
   * @returns `true` when it existed.
   */
  async deleteEndpoint(id: string): Promise<boolean> {
    return this._endpoints.delete(id);
  }

  /**
   * Appends a delivery log entry.
   *
   * @param delivery - Entry to append.
   */
  async logDelivery(delivery: WebhookDeliveryLog): Promise<void> {
    this._deliveries.push(delivery);
  }

  /**
   * Lists the delivery log of an endpoint.
   *
   * @param endpointId - Endpoint ID.
   * @returns The entries, oldest first.
   */
  async listDeliveries(endpointId: string): Promise<WebhookDeliveryLog[]> {
    return this._deliveries.filter(d => d.endpointId === endpointId);
  }

  /**
   * Stores a dead letter.
   *
   * @param entry - Dead letter to store.
   */
  async addDeadLetter(entry: WebhookDeadLetter): Promise<void> {
    this._deadLetters.set(entry.id, entry);
  }

  /**
   * Lists dead letters.
   *
   * @param endpointId - Endpoint filter; all when absent.
   * @returns The dead letters.
   */
  async listDeadLetters(endpointId?: string): Promise<WebhookDeadLetter[]> {
    const all = [...this._deadLetters.values()];
    return endpointId ? all.filter(d => d.endpointId === endpointId) : all;
  }

  /**
   * Marks a dead letter as replayed now (it does not resend anything).
   *
   * @param id - Dead letter ID.
   * @returns `true` when it existed.
   */
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

/**
 * Returns the process-wide webhook store.
 *
 * @returns The current store (in-memory unless replaced).
 */
export function getWebhookStore(): IWebhookStore { return _store; }
/**
 * Replaces the process-wide webhook store.
 *
 * @param store - New backend.
 */
export function setWebhookStore(store: IWebhookStore): void { _store = store; }

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

/**
 * Builds a new active endpoint record (not stored; no URL validation here).
 *
 * @param tenantId - Owner tenant.
 * @param url - Destination URL.
 * @param events - Event names; an empty list means all (`*`).
 * @param secret - Signing secret; a random 32-byte hex secret when absent.
 * @returns The new endpoint with a random UUID.
 */
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
