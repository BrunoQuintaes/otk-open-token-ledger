/**
 * H4.2/H4.3 — Generic Circuit Breaker
 *
 * States: CLOSED (normal) → OPEN (fast-fail) → HALF_OPEN (probe)
 *
 * @module infra/circuitBreaker
 * @since Wave 2H (H4.2)
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;       // consecutive failures to open (default 5)
  resetTimeoutMs: number;         // ms in OPEN before trying HALF_OPEN (default 30000)
  halfOpenMaxAttempts: number;    // probes in HALF_OPEN before re-opening (default 2)
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULTS: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

export class CircuitBreaker<T> {
  private _state: CircuitState = 'CLOSED';
  private _failCount = 0;
  private _lastFailTime = 0;
  private _halfOpenAttempts = 0;
  private readonly _config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this._config = { ...DEFAULTS, ...config };
  }

  get state(): CircuitState { return this._state; }
  get failCount(): number { return this._failCount; }

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

  reset(): void {
    this._state = 'CLOSED';
    this._failCount = 0;
    this._halfOpenAttempts = 0;
    this._lastFailTime = 0;
  }
}

export class CircuitOpenError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Circuit breaker is OPEN — retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}
