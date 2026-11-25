/**
 * RB-062 — REST API Server (Minimum)
 *
 * Stateless HTTP server exposing metering integration endpoints.
 * Uses node:http natively — no external framework dependencies.
 * H1.7: Graceful shutdown on SIGTERM/SIGINT.
 *
 * Usage:
 *   API_PORT=8787 npx tsx src/api/server.ts
 *
 * Startup when run directly: load secrets, refuse to start on an unsafe production configuration
 * (`src/api/productionGuard.ts`) or non-durable money-relevant stores, bootstrap the stores, load the CU weights,
 * start the HTTP server and the proof recovery loop, and optionally the durable proxy. Importing the module (tests)
 * does none of this.
 *
 * Environment variables read here: API_PORT (default 8787), OTK_SHUTDOWN_TIMEOUT_MS (default 10 000 ms),
 * OTK_PROXY_ENABLED, OTK_DB_URL, OTK_PG_RECONNECT_MS, OTK_PROXY_PORT (default 8788). The bootstrap modules read
 * their own.
 *
 * @module src/api/server
 * @since RB-062
 */

import { createServer, type Server } from 'node:http';
import { handleRequest } from './routes.js';
import { sendError } from './errors.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import { bootstrapStores, shutdownStores, deployedStoreProblems } from '../infra/storeBootstrap.js';
import { bootstrapSecrets } from '../infra/secretsBootstrap.js';
import { productionAuthProblems, isProductionEnv } from './productionGuard.js';
import { initCWRuntime } from '../economics/cwRuntime.js';
import { startProofRecovery, stopProofRecovery, proofRecoveryRunning, circuitBreakerStatus } from './receiptStore.js';

/** Options of `startServer`. */
export type ApiServerOpts = {
  /** TCP port; defaults to API_PORT, then 8787. */
  port?: number;
};

let _shuttingDown = false;

/**
 * H1.7: Check if server is shutting down (used by routes to reject new work).
 *
 * @returns `true` once `gracefulShutdown` has started (until `resetShutdownForTest`).
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Creates the HTTP server, starts listening and routes every request to `handleRequest`.
 *
 * During shutdown new requests get 503; an error escaping the router gets 500.
 *
 * @param opts - Server options.
 * @returns The listening server (listening starts asynchronously).
 */
export function startServer(opts: ApiServerOpts = {}): Server {
  const port = opts.port ?? Number(process.env['API_PORT'] ?? 8787);
  const server = createServer((req, res) => {
    // H1.7: Reject new requests during shutdown
    if (_shuttingDown) {
      sendError(res, 'OTK-5030', { legacyError: 'shutting_down' });
      return;
    }
    handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 'OTK-5000', { legacyError: msg });
    });
  });
  server.listen(port, () => {
    getLogger().info('api server listening', { port, url: `http://127.0.0.1:${port}` });
  });
  return server;
}

/**
 * H1.7: Graceful shutdown — stops accepting connections, waits for in-flight,
 * then exits. Called on SIGTERM/SIGINT.
 *
 * @param server - The server to close.
 * @returns Resolves when connections are drained and stores are closed, or after OTK_SHUTDOWN_TIMEOUT_MS; it does
 *   not call `process.exit` itself.
 */
export function gracefulShutdown(server: Server): Promise<void> {
  const timeoutMs = Number(process.env['OTK_SHUTDOWN_TIMEOUT_MS'] ?? 10_000);
  _shuttingDown = true;
  const log = getLogger();
  log.info('shutting down gracefully', { timeoutMs });

  return new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      log.warn('shutdown timeout — forcing exit');
      resolve();
    }, timeoutMs);
    forceTimer.unref?.();

    server.close(async () => {
      clearTimeout(forceTimer);
      await stopProofRecovery(); // RV05: waits for a retry tick in progress
      await shutdownStores();
      log.info('all connections drained — shutdown complete');
      resolve();
    });
  });
}

/**
 * Start the durable proxy profile when OTK_PROXY_ENABLED=1. Exits the process when the profile is
 * requested without OTK_DB_URL (a proxy that cannot record operations durably must not relay).
 * While PostgreSQL is unreachable the proxy port stays closed and creation is retried.
 *
 * @returns The proxy server and its operations runtime, or `null` when OTK_PROXY_ENABLED is not `1`. The promise does
 *   not resolve while the operations store stays unreachable (it retries every OTK_PG_RECONNECT_MS).
 */
export async function startDurableProxyIfEnabled(): Promise<{ server: Server; runtime: import('../operations/runtime.js').OperationsRuntime } | null> {
  if (process.env['OTK_PROXY_ENABLED'] !== '1') return null;
  const log = getLogger();
  const dbUrl = process.env['OTK_DB_URL'];
  if (!dbUrl) {
    log.error('OTK_PROXY_ENABLED=1 requires OTK_DB_URL (durable operations); refusing to start the proxy');
    process.exit(1);
  }
  const { OperationsRuntime } = await import('../operations/runtime.js');
  const { d1d8ProfileFromEnv, D1D8ConfigError } = await import('../operations/bootstrapD1D8.js');
  const { startProxyGateway } = await import('../proxy/ProxyGateway.js');
  // S4: the profile composes the real A/B/C modules; missing essential configuration stops here
  let profile: Awaited<ReturnType<typeof d1d8ProfileFromEnv>>;
  try {
    profile = await d1d8ProfileFromEnv(dbUrl);
  } catch (err) {
    log.error('durable proxy profile invalid; refusing to start the proxy', { error: err instanceof Error ? err.message : String(err), missing: err instanceof D1D8ConfigError ? err.missing : undefined });
    process.exit(1);
  }
  if (!profile.weights.active()) log.error('no valid CU weights table: admissions that depend on measurement are refused (cu_config_unavailable)', { weights: profile.weights.label });
  const retryMs = Math.max(100, Number(process.env['OTK_PG_RECONNECT_MS'] ?? 2_000) || 2_000);
  for (;;) {
    try {
      const runtime = await OperationsRuntime.create(profile.options);
      runtime.start();
      const server = startProxyGateway({ port: Number(process.env['OTK_PROXY_PORT'] ?? 8788), operations: runtime });
      log.info('durable proxy started', { port: process.env['OTK_PROXY_PORT'] ?? '8788', instance: runtime.instanceId, spool: runtime.spool ? 'on' : 'off', ...profile.summary });
      return { server, runtime };
    } catch (err) {
      log.warn('durable proxy not started: operations store unavailable; retrying', { error: err instanceof Error ? err.message : String(err), retryInMs: retryMs });
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

/** Reset shutdown flag (for tests). */
export function resetShutdownForTest(): void {
  _shuttingDown = false;
}

// Allow direct execution: npx tsx src/api/server.ts
const _url = new URL(import.meta.url);
if (process.argv[1] && _url.pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  await bootstrapSecrets();
  // PF-NEW-03 (RUN-S, decision D2): production never starts with authentication silently disabled
  const unsafe = productionAuthProblems();
  if (unsafe.length > 0) {
    getLogger().error('refusing to start in production: unsafe authentication configuration', { problems: unsafe });
    process.exit(1);
  }
  const stores = await bootstrapStores();
  // H1-S01 (FA-04): no silent fallback to in-memory plan assignments in a deployed environment
  const nonDurable = deployedStoreProblems(stores);
  if (nonDurable.length > 0) {
    getLogger().error('refusing to start in production: money-relevant stores are not durable', { problems: nonDurable });
    process.exit(1);
  }
  if (isProductionEnv() && stores.stores['planStore'] !== 'pg') {
    getLogger().warn('OTK_ALLOW_NON_DURABLE_STORES=1: plan assignments live only in memory (disposable demo only)');
  }
  // N2: load the signed CU weights table (OTK_CW_JSON_FILE / OTK_CW_JSON_URL) so receipts
  // are stamped with its version. Without a valid signature it keeps static weights (D4 open).
  await initCWRuntime();
  const server = startServer();
  // RV05: pending proofs (including those restored from the receipt log) are retried
  // without waiting for new client traffic.
  startProofRecovery();
  getLogger().info('proof recovery loop', { running: proofRecoveryRunning(), pendingProofs: circuitBreakerStatus().pendingProofs });

  // N9 / D7-G01: the MITM proxy in its durable profile, opt-in through the documented
  // entrypoint (OTK_PROXY_ENABLED=1, port OTK_PROXY_PORT). Operations must be durable before the
  // provider is called, so PostgreSQL (OTK_DB_URL) is required; there is no memory variant.
  // Not awaited: while PostgreSQL is unreachable the proxy keeps retrying and the API (and its
  // shutdown handlers below) are already up.
  let proxy: Awaited<ReturnType<typeof startDurableProxyIfEnabled>> = null;
  void startDurableProxyIfEnabled().then((p) => { proxy = p; });

  // H1.7: Register shutdown handlers
  const shutdown = async () => {
    const running = proxy;
    if (running) {
      await new Promise<void>((r) => running.server.close(() => r()));
      await running.runtime.stop();
    }
    await gracefulShutdown(server);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
