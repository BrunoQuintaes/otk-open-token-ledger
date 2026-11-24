/**
 * ReceiptIndexer — unit tests for IndexedReceipt schema and state persistence.
 * Uses no live RPC; tests the data model only.
 * @since U10.1
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexedReceipt } from '../../scripts/indexer/receipt_indexer.js';

// ---------------------------------------------------------------------------
// IndexedReceipt schema validation
// ---------------------------------------------------------------------------
describe('IndexedReceipt schema', () => {
  const sample: IndexedReceipt = {
    blockNumber: 42,
    blockTimestamp: 1714000000,
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
    commitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
    userId: '12345678901234567890',
    costUnits: '1500',
    epoch: '1',
    submitter: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    indexedAt: new Date().toISOString(),
  };

  it('has all required fields', () => {
    const required = ['blockNumber', 'blockTimestamp', 'txHash', 'commitment',
                      'userId', 'costUnits', 'epoch', 'submitter', 'indexedAt'];
    for (const f of required) {
      assert.ok(f in sample, `missing field: ${f}`);
    }
  });

  it('blockNumber is number', () => {
    assert.ok(typeof sample.blockNumber === 'number');
  });

  it('costUnits serializes as string (bigint-safe)', () => {
    assert.ok(typeof sample.costUnits === 'string');
  });

  it('userId serializes as string (bigint-safe)', () => {
    assert.ok(typeof sample.userId === 'string');
  });

  it('indexedAt is ISO 8601', () => {
    assert.doesNotThrow(() => new Date(sample.indexedAt));
    assert.ok(!isNaN(new Date(sample.indexedAt).getTime()));
  });

  it('JSON serializes and parses round-trip', () => {
    const serialized = JSON.stringify(sample);
    const parsed = JSON.parse(serialized) as IndexedReceipt;
    assert.strictEqual(parsed.blockNumber, sample.blockNumber);
    assert.strictEqual(parsed.costUnits, sample.costUnits);
    assert.strictEqual(parsed.userId, sample.userId);
  });
});

// ---------------------------------------------------------------------------
// JSONL output format
// ---------------------------------------------------------------------------
describe('JSONL output format', () => {
  let tmpDir: string;
  let jsonlPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-indexer-test-'));
    jsonlPath = path.join(tmpDir, 'receipts.jsonl');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes one JSON object per line', () => {
    const receipts: IndexedReceipt[] = [
      {
        blockNumber: 1, blockTimestamp: 1000, txHash: '0xaaa', commitment: '0xbbb',
        userId: '111', costUnits: '1000', epoch: '1', submitter: '0xccc', indexedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        blockNumber: 2, blockTimestamp: 2000, txHash: '0xddd', commitment: '0xeee',
        userId: '222', costUnits: '2000', epoch: '1', submitter: '0xfff', indexedAt: '2026-01-01T00:00:01.000Z',
      },
    ];

    // Use synchronous writes to avoid async activity after test ends
    for (const r of receipts) {
      fs.appendFileSync(jsonlPath, JSON.stringify(r) + '\n');
    }

    // Read and verify
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);

    const parsed0 = JSON.parse(lines[0]) as IndexedReceipt;
    assert.strictEqual(parsed0.blockNumber, 1);
    assert.strictEqual(parsed0.costUnits, '1000');

    const parsed1 = JSON.parse(lines[1]) as IndexedReceipt;
    assert.strictEqual(parsed1.blockNumber, 2);
    assert.strictEqual(parsed1.userId, '222');
  });

  it('appends without overwriting existing data', () => {
    const appendPath = path.join(tmpDir, 'receipts_append.jsonl');
    fs.writeFileSync(appendPath, JSON.stringify({ blockNumber: 0, note: 'genesis' }) + '\n');
    fs.appendFileSync(appendPath, JSON.stringify({ blockNumber: 1, note: 'second' }) + '\n');

    const lines = fs.readFileSync(appendPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('genesis'));
    assert.ok(lines[1].includes('second'));
  });
});

// ---------------------------------------------------------------------------
// State file format
// ---------------------------------------------------------------------------
describe('Indexer state persistence', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-indexer-state-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('state JSON has lastIndexedBlock and totalIndexed', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const state = { lastIndexedBlock: 42, totalIndexed: 10 };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const read = JSON.parse(fs.readFileSync(statePath, 'utf8')) as typeof state;
    assert.strictEqual(read.lastIndexedBlock, 42);
    assert.strictEqual(read.totalIndexed, 10);
  });
});
