/**
 * Experiment Logger (Pre-U9)
 *
 * Captures metering experiments for benchmarking and analysis.
 * Supports JSON and CSV export for offline analysis.
 *
 * Schema:
 * - timestamp: Unix timestamp (seconds)
 * - provider: Provider identifier (openai, anthropic, etc.)
 * - model: Model identifier (gpt-4o, claude-opus-4, etc.)
 * - inputTokens: Input token count
 * - outputTokens: Output token count
 * - totalTokens: inputTokens + outputTokens
 * - latencyMs: Request latency in milliseconds
 * - costUnit: Normalized cost units (enterprise pricing)
 * - provingTimeMs: ZK proof generation time (ms) [optional]
 * - verificationTimeMs: On-chain verification time (ms) [optional]
 * - gasUsed: Gas consumed for on-chain verification [optional]
 * - success: Whether the experiment succeeded (boolean)
 * - metadata: Additional context (JSON object)
 */

export interface ExperimentRecord {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUnit: number;
  provingTimeMs?: number;
  verificationTimeMs?: number;
  gasUsed?: bigint;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export interface ExperimentLoggerOptions {
  /** Auto-flush after N records (0 = manual flush only) */
  autoFlushThreshold?: number;
  /** Include metadata in exports */
  includeMetadata?: boolean;
}

/**
 * In-memory experiment logger with export capabilities
 */
export class ExperimentLogger {
  private records: ExperimentRecord[] = [];
  private options: Required<ExperimentLoggerOptions>;

  constructor(options: ExperimentLoggerOptions = {}) {
    this.options = {
      autoFlushThreshold: options.autoFlushThreshold ?? 0,
      includeMetadata: options.includeMetadata ?? true,
    };
  }

  /**
   * Log a new experiment record
   */
  log(record: ExperimentRecord): void {
    // Calculate totalTokens if not provided
    const fullRecord = {
      ...record,
      totalTokens: record.totalTokens ?? record.inputTokens + record.outputTokens,
    };

    this.records.push(fullRecord);

    // Auto-flush if threshold reached
    if (
      this.options.autoFlushThreshold > 0 &&
      this.records.length >= this.options.autoFlushThreshold
    ) {
      this.flush();
    }
  }

  /**
   * Get all records (read-only)
   */
  getRecords(): readonly ExperimentRecord[] {
    return Object.freeze([...this.records]);
  }

  /**
   * Get record count
   */
  count(): number {
    return this.records.length;
  }

  /**
   * Clear all records (useful for test isolation)
   */
  flush(): void {
    this.records = [];
  }

  /**
   * Export records as JSON string
   */
  exportJSON(pretty = false): string {
    const data = this.options.includeMetadata
      ? this.records
      : this.records.map((r) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { metadata, ...core } = r;
          return core;
        });

    return JSON.stringify(data, this.bigIntReplacer, pretty ? 2 : 0);
  }

  /**
   * Export records as CSV string
   */
  exportCSV(): string {
    if (this.records.length === 0) {
      return this.getCSVHeader() + '\n';
    }

    const rows = this.records.map((r) => this.recordToCSVRow(r));
    return this.getCSVHeader() + '\n' + rows.join('\n') + '\n';
  }

  /**
   * Get summary statistics
   */
  getSummary(): ExperimentSummary {
    if (this.records.length === 0) {
      return {
        totalRecords: 0,
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        avgCostUnit: 0,
        avgTokens: 0,
        totalCostUnits: 0,
        totalTokens: 0,
      };
    }

    const successRecords = this.records.filter((r) => r.success);
    const failureRecords = this.records.filter((r) => !r.success);

    const totalLatency = this.records.reduce((sum, r) => sum + r.latencyMs, 0);
    const totalCost = this.records.reduce((sum, r) => sum + r.costUnit, 0);
    const totalTokens = this.records.reduce((sum, r) => sum + r.totalTokens, 0);

    return {
      totalRecords: this.records.length,
      successCount: successRecords.length,
      failureCount: failureRecords.length,
      avgLatencyMs: totalLatency / this.records.length,
      avgCostUnit: totalCost / this.records.length,
      avgTokens: totalTokens / this.records.length,
      totalCostUnits: totalCost,
      totalTokens,
    };
  }

  /**
   * Filter records by criteria
   */
  filter(predicate: (record: ExperimentRecord) => boolean): ExperimentRecord[] {
    return this.records.filter(predicate);
  }

  // === Private helpers ===

  private getCSVHeader(): string {
    const baseFields = [
      'timestamp',
      'provider',
      'model',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'latencyMs',
      'costUnit',
      'provingTimeMs',
      'verificationTimeMs',
      'gasUsed',
      'success',
    ];

    if (this.options.includeMetadata) {
      baseFields.push('metadata');
    }

    return baseFields.join(',');
  }

  private recordToCSVRow(record: ExperimentRecord): string {
    const values = [
      record.timestamp,
      this.escapeCSV(record.provider),
      this.escapeCSV(record.model),
      record.inputTokens,
      record.outputTokens,
      record.totalTokens,
      record.latencyMs,
      record.costUnit,
      record.provingTimeMs ?? '',
      record.verificationTimeMs ?? '',
      record.gasUsed?.toString() ?? '',
      record.success,
    ];

    if (this.options.includeMetadata && record.metadata) {
      values.push(this.escapeCSV(JSON.stringify(record.metadata)));
    } else if (this.options.includeMetadata) {
      values.push('');
    }

    return values.join(',');
  }

  private escapeCSV(value: string): string {
    // Escape commas and quotes for CSV
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private bigIntReplacer(_key: string, value: unknown): unknown {
    // Convert BigInt to string for JSON serialization
    return typeof value === 'bigint' ? value.toString() : value;
  }
}

export interface ExperimentSummary {
  totalRecords: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  avgCostUnit: number;
  avgTokens: number;
  totalCostUnits: number;
  totalTokens: number;
}

/**
 * Create a singleton logger instance (convenience)
 */
export function createLogger(options?: ExperimentLoggerOptions): ExperimentLogger {
  return new ExperimentLogger(options);
}
