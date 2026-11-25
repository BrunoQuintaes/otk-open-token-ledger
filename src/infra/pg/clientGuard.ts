/**
 * OVERNIGHT 20261005 / Phase 2 (F-P2-01) — keep a lost PostgreSQL connection from crashing the process.
 *
 * node-postgres attaches an error listener only to IDLE pool clients. A client that is checked out (inside a
 * transaction, between two awaits) and loses its connection emits 'error' on itself; with no listener that is an
 * unhandled 'error' event and the whole process exits. Observed in the Phase 2 load probe: a 6 s PostgreSQL cut through
 * a TCP relay killed the gateway process ("Connection terminated unexpectedly", Unhandled 'error' event).
 *
 * The guard listens for the whole checkout, remembers the error (the next query/COMMIT still fails, so callers keep
 * answering persistence_unavailable or spooling as before) and hands it to release(), which makes the pool destroy the
 * broken client instead of reusing it.
 *
 * @module src/infra/pg/clientGuard
 */
interface GuardableClient {
  on?: (event: 'error', listener: (err: Error) => void) => unknown;
  off?: (event: 'error', listener: (err: Error) => void) => unknown;
  removeListener?: (event: 'error', listener: (err: Error) => void) => unknown;
  release(err?: Error | boolean): void;
}

/** Handle returned by `guardClient` for one pool checkout. */
export interface ClientGuard {
  /** The connection error seen during the checkout, if any. */
  readonly error: Error | null;
  /** Remove the listener and release the client (destroying it when the connection failed). */
  release(extra?: Error | boolean): void;
}

/**
 * Starts guarding a checked-out pool client against connection errors.
 *
 * @param c - Pool client (anything with an optional `on`/`off` and a `release`).
 * @param onError - Optional callback for the connection error (called for each one).
 * @returns The guard; call its `release()` instead of the client's.
 */
export function guardClient(c: GuardableClient, onError?: (err: Error) => void): ClientGuard {
  let seen: Error | null = null;
  const listener = (err: Error) => { seen = err; onError?.(err); };
  c.on?.('error', listener);
  return {
    get error() { return seen; },
    release(extra?: Error | boolean) {
      (c.off ?? c.removeListener)?.call(c, 'error', listener);
      c.release(seen ?? extra);
    },
  };
}
