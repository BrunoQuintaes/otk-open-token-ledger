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

export interface SseConnection {
  id: string;
  tenantId: string;
  res: ServerResponse;
  lastEventId: string | null;
  connectedAt: number;
  pingInterval: ReturnType<typeof setInterval> | null;
}

export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

// ──────────────────────────────────────────────────────────
// StreamManager
// ──────────────────────────────────────────────────────────

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

  get connectionCount(): number { return this._byId.size; }
  get tenantCount(): number { return this._connections.size; }

  getConnectionsForTenant(tenantId: string): SseConnection[] {
    return [...(this._connections.get(tenantId) ?? [])];
  }
}

// ──────────────────────────────────────────────────────────
// Module-level singleton
// ──────────────────────────────────────────────────────────

let _manager: StreamManager | null = null;

export function getStreamManager(): StreamManager {
  if (!_manager) _manager = new StreamManager();
  return _manager;
}

export function setStreamManager(mgr: StreamManager): void {
  _manager = mgr;
}
