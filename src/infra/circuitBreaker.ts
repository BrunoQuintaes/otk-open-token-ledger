/**
 * H4.2/H4.3 — Generic Circuit Breaker
 *
 * States: CLOSED (normal) → OPEN (fast-fail) → HALF_OPEN (probe)
 *
 * In HALF_OPEN a success closes the circuit; failures reopen it only after `halfOpenMaxAttempts` probes. State is
 * per instance and in memory.
 *
 * @module src/infra/circuitBreaker
 * @since Wave 2H (H4.2)
 */

/** State of a circuit breaker. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Thresholds and callback of a circuit breaker. */
export interface CircuitBreakerConfig {
  failureThreshold: number;       // consecutive failures to open (default 5)
  resetTimeoutMs: number;         // ms in OPEN before trying HALF_OPEN (default 30000)
  halfOpenMaxAttempts: number;    // probes in HALF_OPEN before re-opening (default 2)
  /** Called on every state change, synchronously. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULTS: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

/** Wraps async calls and fails fast while the protected dependency keeps failing. */
export class CircuitBreaker<T> {
  private _state: CircuitState = 'CLOSED';
  private _failCount = 0;
  private _lastFailTime = 0;
  private _halfOpenAttempts = 0;
  private readonly _config: CircuitBreakerConfig;

  /**
   * Creates a closed breaker.
   *
   * @param config - Overrides of the defaults (5 failures, 30000 ms, 2 probes).
   */
  constructor(config?: Partial<CircuitBreakerConfig>) {
    this._config = { ...DEFAULTS, ...config };
  }

  /**
   * Current state.
   *
   * @returns `CLOSED`, `OPEN` or `HALF_OPEN`.
   */
  get state(): CircuitState { return this._state; }
  /**
   * Consecutive failures counted so far.
   *
   * @returns The failure count.
   */
  get failCount(): number { return this._failCount; }

  /**
   * Runs `fn` unless the circuit is open.
   *
   * @param fn - The protected call.
   * @returns What `fn` returns.
   * @throws {@link CircuitOpenError} When the circuit is OPEN and the reset timeout has not passed.
   * @throws {Error} Whatever `fn` throws (after counting the failure).
   */
  async execute(fn: () => Promise<T>): Promise<T> {
    if (this._state === 'OPEN') {
      if (Date.now() - this._lastFailTime >= this._config.resetTimeoutMs) {
        this._transition('HALF_OPEN');
      } else {
        throw new CircuitOpenError(this._config.resetTimeoutMs - (Date.now() - this._lastFailTime));
      }
    }

    if (this._state === 'HALF_OPEN') {
      this._halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  private _onSuccess(): void {
    if (this._state === 'HALF_OPEN') {
      this._transition('CLOSED');
    }
    this._failCount = 0;
    this._halfOpenAttempts = 0;
  }

  private _onFailure(): void {
    this._failCount++;
    this._lastFailTime = Date.now();

    if (this._state === 'HALF_OPEN') {
      if (this._halfOpenAttempts >= this._config.halfOpenMaxAttempts) {
        this._transition('OPEN');
      }
    } else if (this._state === 'CLOSED') {
      if (this._failCount >= this._config.failureThreshold) {
        this._transition('OPEN');
      }
    }
  }

  private _transition(to: CircuitState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    if (to === 'HALF_OPEN') this._halfOpenAttempts = 0;
    if (to === 'CLOSED') this._failCount = 0;
    this._config.onStateChange?.(from, to);
  }

  /** Returns to CLOSED and clears every counter (no callback is called). */
  reset(): void {
    this._state = 'CLOSED';
    this._failCount = 0;
    this._halfOpenAttempts = 0;
    this._lastFailTime = 0;
  }
}

/** Thrown by `CircuitBreaker.execute` while the circuit is open. */
export class CircuitOpenError extends Error {
  /** Milliseconds until the breaker will try a probe. */
  public readonly retryAfterMs: number;
  /**
   * Creates the error.
   *
   * @param retryAfterMs - Milliseconds until a probe is allowed.
   */
  constructor(retryAfterMs: number) {
    super(`Circuit breaker is OPEN — retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}
