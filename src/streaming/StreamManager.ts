/**
 * StreamManager — per-tenant SSE connection pool (P5.2)
 *
 * Manages active SSE connections per tenantId.
 * Handles fan-out of events to all matching tenant connections.
 * Supports Last-Event-ID for client reconnection.
 *
 * @module streaming/StreamManager
 * @since Wave 4 (4F-PACK-4F01 / P5.2)
 */

import type { ServerResponse } from 'node:http';
import crypto from 'node:crypto';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

/**
 * One open SSE connection.
 */
export interface SseConnection {
  id: string;
  tenantId: string;
  res: ServerResponse;
  /** ID of the last event written to (or announced by) this client; null when none. */
  lastEventId: string | null;
  /** When the connection was opened (epoch milliseconds). */
  connectedAt: number;
  pingInterval: ReturnType<typeof setInterval> | null;
}

/**
 * An event to write on SSE connections.
 */
export interface SseEvent {
  /** Event ID; a random UUID is used when absent. */
  id?: string;
  event: string;
  data: unknown;
}

// ──────────────────────────────────────────────────────────
// StreamManager
// ──────────────────────────────────────────────────────────

/**
 * In-memory pool of SSE connections grouped by tenant, with a keepalive ping per connection.
 *
 * State lives in this process only: connections on another instance do not receive its events.
 */
export class StreamManager {
  /** tenantId → Set of active connections */
  private _connections = new Map<string, Set<SseConnection>>();

  /** All connections by connection id (for direct access) */
  private _byId = new Map<string, SseConnection>();

  private _pingIntervalMs: number;

  constructor(opts?: { pingIntervalMs?: number }) {
    this._pingIntervalMs = opts?.pingIntervalMs ?? 30_000;
  }

  /**
   * Register an SSE response for a tenant. Sets up keepalive ping.
   * Returns the connection object (for cleanup on disconnect).
   *
   * Side effects: writes the SSE response headers, starts a ping timer, and removes the connection when the
   * response closes or errors.
   *
   * @param tenantId - Tenant of the connection (`*` is not special here).
   * @param res - Response to keep open.
   * @param lastEventId - Value of the client's `Last-Event-ID` header, if any.
   * @returns The registered connection.
   */
  connect(tenantId: string, res: ServerResponse, lastEventId?: string | null): SseConnection {
    const conn: SseConnection = {
      id: crypto.randomUUID(),
      tenantId,
      res,
      lastEventId: lastEventId ?? null,
      connectedAt: Date.now(),
      pingInterval: null,
    };

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering
    });
    res.flushHeaders?.();

    // Register connection
    if (!this._connections.has(tenantId)) {
      this._connections.set(tenantId, new Set());
    }
    this._connections.get(tenantId)!.add(conn);
    this._byId.set(conn.id, conn);

    // Keepalive ping
    conn.pingInterval = setInterval(() => {
      this._writePing(conn);
    }, this._pingIntervalMs);

    // Cleanup on close
    res.on('close', () => this.disconnect(conn.id));
    res.on('error', () => this.disconnect(conn.id));

    return conn;
  }

  /**
   * Disconnect and clean up a connection by id.
   *
   * @param connId - Connection ID; unknown IDs are ignored.
   */
  disconnect(connId: string): void {
    const conn = this._byId.get(connId);
    if (!conn) return;
    if (conn.pingInterval) clearInterval(conn.pingInterval);
    this._byId.delete(connId);
    const tenantConns = this._connections.get(conn.tenantId);
    if (tenantConns) {
      tenantConns.delete(conn);
      if (tenantConns.size === 0) this._connections.delete(conn.tenantId);
    }
  }

  /**
   * Send an event to all connections for a given tenantId.
   * If tenantId is '*', broadcast to all connections.
   *
   * A write error disconnects that client only. String data containing a newline is written unchanged, which
   * would split the SSE `data:` line.
   *
   * @param tenantId - Target tenant, or `*` for every connection.
   * @param event - Event to write.
   */
  send(tenantId: string, event: SseEvent): void {
    const targets: Set<SseConnection>[] = tenantId === '*'
      ? [...this._connections.values()]
      : this._connections.has(tenantId) ? [this._connections.get(tenantId)!] : [];

    const eventId = event.id ?? crypto.randomUUID();
    const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    const frame = `id: ${eventId}\nevent: ${event.event}\ndata: ${data}\n\n`;

    for (const set of targets) {
      for (const conn of set) {
        try {
          conn.res.write(frame);
          conn.lastEventId = eventId;
        } catch {
          this.disconnect(conn.id);
        }
      }
    }
  }

  private _writePing(conn: SseConnection): void {
    try {
      conn.res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      this.disconnect(conn.id);
    }
  }

  /**
   * Number of open connections.
   *
   * @returns Connection count.
   */
  get connectionCount(): number { return this._byId.size; }
  /**
   * Number of tenants with at least one open connection.
   *
   * @returns Tenant count.
   */
  get tenantCount(): number { return this._connections.size; }

  /**
   * Lists the open connections of a tenant.
   *
   * @param tenantId - Tenant ID.
   * @returns A new array (the connection objects themselves are shared).
   */
  getConnectionsForTenant(tenantId: string): SseConnection[] {
    return [...(this._connections.get(tenantId) ?? [])];
  }
}

// ──────────────────────────────────────────────────────────
// Module-level singleton
// ──────────────────────────────────────────────────────────

let _manager: StreamManager | null = null;

/**
 * Returns the process-wide stream manager, creating it (30 s ping) on first use.
 *
 * @returns The shared manager.
 */
export function getStreamManager(): StreamManager {
  if (!_manager) _manager = new StreamManager();
  return _manager;
}

/**
 * Replaces the process-wide stream manager (tests or custom ping interval).
 *
 * @param mgr - New manager; connections of the previous one are not moved.
 */
export function setStreamManager(mgr: StreamManager): void {
  _manager = mgr;
}
