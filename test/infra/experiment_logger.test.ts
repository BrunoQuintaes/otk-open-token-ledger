/**
 * ExperimentLogger Tests (Pre-U9)
 *
 * Behaviour tested: the in-memory experiment record logger meant for benchmarking, which collects one record per
 * metered call (tokens, latency in ms, cost units, success) and exports them for offline analysis.
 *
 * Module under test: `src/infra/logging/ExperimentLogger.ts` (`ExperimentLogger`, `ExperimentRecord`).
 *
 * Strategy / partitions: zero, one and many records; `totalTokens` given or derived from input + output; frozen
 * read-only views; flush and auto-flush (threshold reached, threshold 0 = never); JSON export (compact, pretty,
 * bigint `gasUsed`, metadata on and off); CSV export (header only when empty, escaping of special characters,
 * optional fields, metadata column on and off); summary statistics on an empty and a filled logger; filters by
 * provider, success and latency threshold; and one end-to-end experiment workflow.
 *
 * Needs: nothing external (in memory, no file I/O, no network).
 *
 * Run just this file: `npx tsx --test test/infra/experiment_logger.test.ts`
 *
 * @module test/infra/experiment_logger.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ExperimentLogger, type ExperimentRecord } from '../../src/infra/logging/ExperimentLogger.js';

describe('ExperimentLogger', () => {
  const sampleRecord: ExperimentRecord = {
    timestamp: 1700000000,
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    latencyMs: 500,
    costUnit: 150,
    success: true,
  };

  describe('Basic logging', () => {
    it('should log records', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);

      assert.strictEqual(logger.count(), 1, 'Should have 1 record');
      const records = logger.getRecords();
      assert.strictEqual(records[0].provider, 'openai');
    });

    it('should calculate totalTokens if not provided', () => {
      const logger = new ExperimentLogger();
      const recordWithoutTotal = {
        ...sampleRecord,
        totalTokens: undefined as unknown as number,
      };
      delete (recordWithoutTotal as Partial<ExperimentRecord>).totalTokens;

      logger.log(recordWithoutTotal);

      const records = logger.getRecords();
      assert.strictEqual(records[0].totalTokens, 150, 'Should calculate totalTokens');
    });

    it('should support multiple records', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);
      logger.log({ ...sampleRecord, provider: 'anthropic' });
      logger.log({ ...sampleRecord, provider: 'gemini' });

      assert.strictEqual(logger.count(), 3, 'Should have 3 records');
    });

    it('should return read-only records', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);

      const records = logger.getRecords();
      assert.ok(Object.isFrozen(records), 'Records should be frozen');
    });
  });

  describe('Flush', () => {
    it('should clear all records on flush', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);
      logger.log(sampleRecord);

      assert.strictEqual(logger.count(), 2);

      logger.flush();

      assert.strictEqual(logger.count(), 0, 'Should clear records after flush');
    });
  });

  describe('Auto-flush', () => {
    it('should auto-flush when threshold reached', () => {
      const logger = new ExperimentLogger({ autoFlushThreshold: 2 });

      logger.log(sampleRecord);
      assert.strictEqual(logger.count(), 1);

      logger.log(sampleRecord);
      assert.strictEqual(logger.count(), 0, 'Should auto-flush after 2 records');
    });

    it('should not auto-flush if threshold is 0', () => {
      const logger = new ExperimentLogger({ autoFlushThreshold: 0 });

      logger.log(sampleRecord);
      logger.log(sampleRecord);
      logger.log(sampleRecord);

      assert.strictEqual(logger.count(), 3, 'Should not auto-flush');
    });
  });

  describe('JSON export', () => {
    it('should export as JSON', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);

      const json = logger.exportJSON();
      const parsed = JSON.parse(json);

      assert.ok(Array.isArray(parsed), 'Should export array');
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].provider, 'openai');
    });

    it('should export pretty JSON', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);

      const json = logger.exportJSON(true);
      assert.ok(json.includes('\n'), 'Should include newlines for pretty format');
    });

    it('should handle BigInt gasUsed', () => {
      const logger = new ExperimentLogger();
      logger.log({
        ...sampleRecord,
        gasUsed: 50000n,
      });

      const json = logger.exportJSON();
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed[0].gasUsed, '50000', 'BigInt should serialize as string');
    });

    it('should exclude metadata if option is false', () => {
      const logger = new ExperimentLogger({ includeMetadata: false });
      logger.log({
        ...sampleRecord,
        metadata: { foo: 'bar' },
      });

      const json = logger.exportJSON();
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed[0].metadata, undefined, 'Should exclude metadata');
    });
  });

  describe('CSV export', () => {
    it('should export as CSV with header', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);

      const csv = logger.exportCSV();
      const lines = csv.trim().split('\n');

      assert.strictEqual(lines.length, 2, 'Should have header + 1 row');
      assert.ok(lines[0].includes('timestamp'), 'Header should include timestamp');
      assert.ok(lines[0].includes('provider'), 'Header should include provider');
      assert.ok(lines[1].includes('openai'), 'Row should include provider value');
    });

    it('should export empty CSV with header only if no records', () => {
      const logger = new ExperimentLogger();

      const csv = logger.exportCSV();
      const lines = csv.trim().split('\n');

      assert.strictEqual(lines.length, 1, 'Should have header only');
    });

    it('should escape CSV special characters', () => {
      const logger = new ExperimentLogger();
      logger.log({
        ...sampleRecord,
        provider: 'test, provider',
        model: 'test"model',
      });

      const csv = logger.exportCSV();
      assert.ok(csv.includes('"test, provider"'), 'Should escape commas');
      assert.ok(csv.includes('"test""model"'), 'Should escape quotes');
    });

    it('should handle optional fields', () => {
      const logger = new ExperimentLogger();
      logger.log(sampleRecord);
      logger.log({
        ...sampleRecord,
        provingTimeMs: 1500,
        verificationTimeMs: 200,
        gasUsed: 45000n,
      });

      const csv = logger.exportCSV();
      const lines = csv.trim().split('\n');

      assert.strictEqual(lines.length, 3, 'Should have header + 2 rows');
      // First row should have empty optional fields
      assert.ok(lines[1].includes(',,'), 'Should have empty fields');
      // Second row should have filled optional fields
      assert.ok(lines[2].includes('1500'), 'Should include provingTimeMs');
      assert.ok(lines[2].includes('200'), 'Should include verificationTimeMs');
      assert.ok(lines[2].includes('45000'), 'Should include gasUsed');
    });
  });

  describe('Summary statistics', () => {
    it('should return zero summary for empty logger', () => {
      const logger = new ExperimentLogger();
      const summary = logger.getSummary();

      assert.strictEqual(summary.totalRecords, 0);
      assert.strictEqual(summary.successCount, 0);
      assert.strictEqual(summary.failureCount, 0);
      assert.strictEqual(summary.avgLatencyMs, 0);
      assert.strictEqual(summary.avgCostUnit, 0);
    });

    it('should calculate summary statistics', () => {
      const logger = new ExperimentLogger();
      logger.log({ ...sampleRecord, latencyMs: 500, costUnit: 150, success: true });
      logger.log({ ...sampleRecord, latencyMs: 700, costUnit: 200, success: true });
      logger.log({ ...sampleRecord, latencyMs: 300, costUnit: 100, success: false });

      const summary = logger.getSummary();

      assert.strictEqual(summary.totalRecords, 3);
      assert.strictEqual(summary.successCount, 2);
      assert.strictEqual(summary.failureCount, 1);
      assert.strictEqual(summary.avgLatencyMs, 500, 'Avg latency should be (500+700+300)/3');
      assert.strictEqual(summary.avgCostUnit, 150, 'Avg cost should be (150+200+100)/3');
      assert.strictEqual(summary.totalCostUnits, 450);
      assert.strictEqual(summary.totalTokens, 450, 'Total tokens should be 3 × 150');
    });
  });

  describe('Filtering', () => {
    it('should filter records by provider', () => {
      const logger = new ExperimentLogger();
      logger.log({ ...sampleRecord, provider: 'openai' });
      logger.log({ ...sampleRecord, provider: 'anthropic' });
      logger.log({ ...sampleRecord, provider: 'openai' });

      const openaiRecords = logger.filter((r) => r.provider === 'openai');
      assert.strictEqual(openaiRecords.length, 2);
    });

    it('should filter records by success', () => {
      const logger = new ExperimentLogger();
      logger.log({ ...sampleRecord, success: true });
      logger.log({ ...sampleRecord, success: false });
      logger.log({ ...sampleRecord, success: true });

      const successRecords = logger.filter((r) => r.success);
      assert.strictEqual(successRecords.length, 2);
    });

    it('should filter records by latency threshold', () => {
      const logger = new ExperimentLogger();
      logger.log({ ...sampleRecord, latencyMs: 100 });
      logger.log({ ...sampleRecord, latencyMs: 500 });
      logger.log({ ...sampleRecord, latencyMs: 1000 });

      const fastRecords = logger.filter((r) => r.latencyMs < 600);
      assert.strictEqual(fastRecords.length, 2);
    });
  });

  describe('Metadata handling', () => {
    it('should preserve metadata when included', () => {
      const logger = new ExperimentLogger({ includeMetadata: true });
      logger.log({
        ...sampleRecord,
        metadata: { experiment: 'A/B test', variant: 'control' },
      });

      const json = logger.exportJSON();
      const parsed = JSON.parse(json);
      assert.deepStrictEqual(parsed[0].metadata, {
        experiment: 'A/B test',
        variant: 'control',
      });
    });

    it('should exclude metadata from CSV if disabled', () => {
      const logger = new ExperimentLogger({ includeMetadata: false });
      logger.log({
        ...sampleRecord,
        metadata: { foo: 'bar' },
      });

      const csv = logger.exportCSV();
      const header = csv.split('\n')[0];
      assert.ok(!header.includes('metadata'), 'CSV header should not include metadata');
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle typical experiment workflow', () => {
      const logger = new ExperimentLogger();

      // Log successful experiment
      logger.log({
        timestamp: Date.now(),
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 500,
        outputTokens: 300,
        totalTokens: 800,
        latencyMs: 1200,
        costUnit: 800,
        provingTimeMs: 2500,
        verificationTimeMs: 150,
        gasUsed: 42000n,
        success: true,
        metadata: { experiment: 'baseline' },
      });

      // Log failed experiment
      logger.log({
        timestamp: Date.now(),
        provider: 'anthropic',
        model: 'claude-opus-4',
        inputTokens: 1000,
        outputTokens: 0,
        totalTokens: 1000,
        latencyMs: 0,
        costUnit: 0,
        success: false,
        metadata: { experiment: 'baseline', error: 'timeout' },
      });

      const summary = logger.getSummary();
      assert.strictEqual(summary.totalRecords, 2);
      assert.strictEqual(summary.successCount, 1);
      assert.strictEqual(summary.failureCount, 1);

      // Export for analysis
      const json = logger.exportJSON();
      assert.ok(json.length > 0, 'Should export JSON');

      const csv = logger.exportCSV();
      assert.ok(csv.includes('gpt-4o'), 'Should include model in CSV');
      assert.ok(csv.includes('claude-opus-4'), 'Should include second model');
    });
  });
});
