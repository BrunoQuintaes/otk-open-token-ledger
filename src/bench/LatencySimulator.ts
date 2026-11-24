/**
 * LatencySimulator — configurable network latency injection for IBFT experiments.
 *
 * Simulates WAN latency between nodes by wrapping async operations with
 * a configurable delay. Used in benchmark harnesses to model the impact
 * of inter-node latency on IBFT consensus throughput.
 *
 * Configuration (env vars or constructor options):
 *   NET_LATENCY_MS     — one-way latency in ms (default: 0)
 *   NET_LATENCY_JITTER — jitter fraction 0–1 (default: 0 = deterministic)
 *
 * Latency model:
 *   actual_delay = base_ms × (1 + jitter × U(-1, 1))
 *   where U(-1,1) is uniform random in [-1, 1]
 *
 * In IBFT 2.0, consensus requires 3 message rounds (PREPREPARE, PREPARE, COMMIT).
 * Each round incurs one-way latency. For RTT simulation, use 2 × NET_LATENCY_MS.
 *
 * Reference: Saltini 2019 — IBFT block time = f(latency, validator count)
 *
 * @module LatencySimulator
 * @since U9.5
 */

export interface LatencyConfig {
  /** One-way latency in milliseconds (0 = no simulation) */
  baseMs: number;
  /** Jitter fraction [0, 1] — adds ±jitter×baseMs random variation */
  jitter: number;
  /** IBFT rounds per consensus (default: 3 — PREPREPARE + PREPARE + COMMIT) */
  ibftRounds: number;
}

const DEFAULT_CONFIG: LatencyConfig = {
  baseMs: 0,
  jitter: 0,
  ibftRounds: 3,
};

/**
 * Read latency config from environment variables.
 */
export function latencyConfigFromEnv(): LatencyConfig {
  const baseMs   = parseFloat(process.env['NET_LATENCY_MS']     ?? '0');
  const jitter   = parseFloat(process.env['NET_LATENCY_JITTER'] ?? '0');
  const ibftRounds = parseInt(process.env['IBFT_ROUNDS']        ?? '3', 10);
  return {
    baseMs:   isNaN(baseMs)   ? 0 : Math.max(0, baseMs),
    jitter:   isNaN(jitter)   ? 0 : Math.min(1, Math.max(0, jitter)),
    ibftRounds: isNaN(ibftRounds) ? 3 : ibftRounds,
  };
}

export class LatencySimulator {
  private readonly config: LatencyConfig;

  constructor(config: Partial<LatencyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** True if latency simulation is active */
  get isActive(): boolean {
    return this.config.baseMs > 0;
  }

  get baseMs(): number { return this.config.baseMs; }
  get jitter(): number { return this.config.jitter; }
  get ibftRounds(): number { return this.config.ibftRounds; }

  /**
   * Compute the actual delay to inject for one network hop.
   */
  computeHopDelay(): number {
    if (this.config.baseMs <= 0) return 0;
    const j = this.config.jitter;
    const noise = j > 0 ? (Math.random() * 2 - 1) * j : 0;
    return Math.max(0, this.config.baseMs * (1 + noise));
  }

  /**
   * Simulate one-way network hop delay.
   */
  async simulateHop(): Promise<void> {
    const delay = this.computeHopDelay();
    if (delay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Simulate full IBFT consensus round-trip (ibftRounds hops).
   * Models the delay for a transaction to reach finality under IBFT 2.0.
   *
   * IBFT 2.0 consensus phases (each = 1 network round trip between validators):
   *   Round 1: PREPREPARE (leader → validators)
   *   Round 2: PREPARE    (validators → validators)
   *   Round 3: COMMIT     (validators → validators)
   */
  async simulateIBFTConsensus(): Promise<void> {
    if (!this.isActive) return;
    const totalDelay = this.computeHopDelay() * this.config.ibftRounds;
    if (totalDelay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, totalDelay));
    }
  }

  /**
   * Wrap an async operation with simulated IBFT consensus latency.
   * Returns both the result and the simulated delay applied.
   */
  async withConsensusDelay<T>(fn: () => Promise<T>): Promise<{ result: T; simulatedDelayMs: number }> {
    const delay = this.isActive ? this.computeHopDelay() * this.config.ibftRounds : 0;
    if (delay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
    const result = await fn();
    return { result, simulatedDelayMs: delay };
  }

  /**
   * Estimate expected IBFT block time given validator count.
   *
   * Simplified model from Saltini 2019:
   *   block_time ≈ (ibftRounds × 2 × latency) + processing_overhead_ms
   *
   * This is a theoretical lower bound for loopback networks.
   */
  estimatedBlockTimeMs(
    processingOverheadMs = 500,
    validatorCount = 4,
  ): number {
    if (!this.isActive) return processingOverheadMs;
    // Latency component: 3 rounds × one-way × 2 (for each validator to hear from others)
    const latencyComponent = this.config.ibftRounds * this.config.baseMs * 2;
    // O(n) complexity: each validator must hear from f+1 = (n-1)/3+1 validators
    const quorumFactor = Math.ceil((validatorCount - 1) / 3) + 1;
    return processingOverheadMs + latencyComponent * quorumFactor;
  }

  /**
   * Estimate on-chain throughput (receipts/s) given simulated latency.
   *
   * Formula: throughput = receiptsPerBlock / blockTimeSeconds
   * where receiptsPerBlock = floor(blockGasLimit / gasPerReceipt)
   */
  estimatedThroughput(
    blockGasLimit = 12_000_000,
    gasPerReceipt = 290_620,
    processingOverheadMs = 500,
    validatorCount = 4,
  ): number {
    const receiptsPerBlock = Math.floor(blockGasLimit / gasPerReceipt);
    const blockTimeMs = this.estimatedBlockTimeMs(processingOverheadMs, validatorCount);
    return receiptsPerBlock / (blockTimeMs / 1000);
  }

  toString(): string {
    if (!this.isActive) return 'LatencySimulator(disabled)';
    return `LatencySimulator(base=${this.config.baseMs}ms, jitter=${this.config.jitter}, rounds=${this.config.ibftRounds})`;
  }
}

/** Singleton configured from environment */
export const defaultLatencySimulator = new LatencySimulator(latencyConfigFromEnv());
