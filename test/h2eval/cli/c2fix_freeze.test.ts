/**
 * Tests freezing the training block after a model probe: which journal endings count as terminal, which still
 * block the freeze, and that an earlier dataset export is never overwritten.
 *
 * Modules under test: `scripts/h2eval/cli/campaign.ts` (`freezeTrain`, `gateFor`, `batchTerminal`,
 * `exportDatasetForFreeze`, `validateTrainFrozen`, `NON_OPERATION_KINDS`), `scripts/h2eval/cli/status.ts`
 * (`exportDataset`) and the real hash-chained journal from `scripts/h2eval/core/journal.ts`.
 *
 * Strategy / partitions: the set of non-operation journal kinds equals the set the runner replay filters out (read
 * from the runner source text); terminal endings (settled, probe result last, acknowledged uncertain operation)
 * let the freeze pass and open the validation gate; really open operations (sent, reserved, probe started without
 * settlement, missing journal) are refused; an earlier different export is kept byte for byte, an identical one is
 * reused, and a taken version name is never replaced.
 *
 * Needs: a writable temporary directory for synthetic journals; reads `scripts/h2eval/core/runner.ts` as text. No
 * provider, no network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/c2fix_freeze.test.ts`
 *
 * @module test/h2eval/cli/c2fix_freeze.test
 */
// SYNTHETIC — C2-FIX (E1″): freeze-train after a model probe; an operation really open is still refused; an earlier dataset export is never overwritten.
// Journals are written with the real journal (hash chain); no provider, no network, no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJournal } from '../../../scripts/h2eval/core/journal.js';
import { batchTerminal, exportDatasetForFreeze, freezeTrain, gateFor, NON_OPERATION_KINDS, validateTrainFrozen } from '../../../scripts/h2eval/cli/campaign.js';
import { CliError, EXIT, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { exportDataset } from '../../../scripts/h2eval/cli/status.js';
import type { BatchPlan, PlannedBatch } from '../../../scripts/h2eval/cli/plan.js';
import type { JournalKind } from '../../../scripts/h2eval/types.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-c2fix-${p}-`));
const hex = (n: number) => n.toString(16).padStart(64, '0');
const SETTLED_PATH: JournalKind[] = ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'SENT', 'RESPONSE_RECEIVED', 'USAGE_PARSED', 'COST_COMPUTED', 'SETTLED'];
const PROBE_PATH: JournalKind[] = ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'MODEL_PROBE_STARTED', 'RESERVED', 'SENT', 'RESPONSE_RECEIVED', 'USAGE_PARSED', 'COST_COMPUTED', 'SETTLED', 'MODEL_PROBE_RESULT'];
const ACKED_UNCERTAIN: JournalKind[] = ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'SENT', 'TIMEOUT_UNCERTAIN', 'UNCERTAIN_ISOLATED', 'UNCERTAIN_ACKNOWLEDGED'];
const block = (id: string, b: 'train' | 'validation', ops: number): PlannedBatch => ({ batchId: id, block: b, branchLocked: false, operations: Array.from({ length: ops }, (_, k) => ({ operationId: hex(Number.parseInt(id.replace(/\D/g, '') || '0', 10) * 100 + k + 1) })) }) as unknown as PlannedBatch;
const planOf = (batches: PlannedBatch[]): BatchPlan => ({ protocolHash: 'a'.repeat(64), phase: 'CONFIRMATORY', batches }) as unknown as BatchPlan;
const writeOps = (camp: string, b: PlannedBatch, paths: JournalKind[][]) => {
  const dir = path.join(camp, 'batches', b.batchId); mkdirSync(dir, { recursive: true });
  const j = openJournal(path.join(dir, 'journal.jsonl'), () => '2026-11-14T00:00:00.000Z');
  paths.forEach((kinds, k) => { for (const kind of kinds) j.append(kind, b.operations[k]!.operationId, { synthetic: true }); });
  return dir;
};

test('C2-FIX: NON_OPERATION_KINDS is exactly the set the runner replay filters out (runner.ts replayDecision)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/h2eval/core/runner.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('const lines = journal.of(id).filter((l) =>'));
  assert.ok(line, 'linha do replay do runner encontrada');
  const runnerKinds = [...line!.matchAll(/l\.kind !== '([A-Z_]+)'/g)].map((m) => m[1]!).sort();
  assert.deepEqual([...NON_OPERATION_KINDS].sort(), runnerKinds);
});

test('C2-FIX: probe (MODEL_PROBE_RESULT last) and acknowledged uncertain operation count as terminal; freeze-train passes and the gate opens validation', () => {
  const camp = tmp('probe'); const b1 = block('t1', 'train', 3); const b2 = block('t2', 'train', 1); const v = block('v9', 'validation', 1); const plan = planOf([b1, b2, v]);
  writeOps(camp, b1, [PROBE_PATH, SETTLED_PATH, ACKED_UNCERTAIN]);
  writeOps(camp, b2, [[...SETTLED_PATH, 'REPLAY_SKIPPED']]);
  assert.deepEqual(batchTerminal(camp, b1), { operations: 3, terminal: 3, openReservations: false });
  const fr = freezeTrain(plan, camp, () => '2026-11-14T01:00:00.000Z');
  assert.equal(fr.batches.length, 2); assert.ok(fr.batches.every((r) => r.terminal === r.operations && r.datasetFile === 'dataset.jsonl'));
  const gate = path.join(camp, 'gates', 'TRAIN_FROZEN.json');
  assert.equal(validateTrainFrozen(plan, gate).code, null);
  assert.equal(gateFor(plan, v, camp).code, null);
});

test('C2-FIX: an operation really open (SENT, RESERVED, probe started without settlement, or absent) is still refused', () => {
  const cases: Array<[string, JournalKind[] | null, boolean]> = [
    ['sent_then_probe_result', ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'MODEL_PROBE_STARTED', 'RESERVED', 'SENT', 'MODEL_PROBE_RESULT'], true],
    ['reserved_then_pause_ack', ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'PAUSE_ACK'], true],
    ['probe_started_only', ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'MODEL_PROBE_STARTED'], false],
    ['uncertain_ack_without_isolation', ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'SENT', 'UNCERTAIN_ACKNOWLEDGED'], true],
    ['paused_for_review', ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'PAUSE_REVIEW'], false],
    ['absent', null, false],
  ];
  for (const [name, kinds, open] of cases) {
    const camp = tmp(name); const b = block('t1', 'train', 2); const plan = planOf([b, block('v9', 'validation', 1)]);
    writeOps(camp, b, kinds ? [PROBE_PATH, kinds] : [PROBE_PATH]);
    const t = batchTerminal(camp, b); assert.equal(t.terminal, 1, name); assert.equal(t.openReservations, open, name);
    assert.throws(() => freezeTrain(plan, camp), (e: CliError) => e.code === 'TRAIN_BATCH_NOT_TERMINAL' && e.exit === EXIT.REFUSED_BY_POLICY, name);
    assert.ok(!existsSync(path.join(camp, 'gates', 'TRAIN_FROZEN.json')), `${name}: nenhum gate escrito`);
    assert.ok(!existsSync(path.join(camp, 'batches', 't1', 'dataset.jsonl')), `${name}: nada exportado antes da recusa`);
  }
});

test('C2-FIX (R3): an earlier DIFFERENT dataset export is preserved byte for byte; an identical one is reused; a taken version name is never replaced', () => {
  const camp = tmp('ds'); const bOld = block('t1', 'train', 1); const bSame = block('t2', 'train', 1); const bNone = block('t3', 'train', 1); const plan = planOf([bOld, bSame, bNone, block('v9', 'validation', 1)]);
  const dOld = writeOps(camp, bOld, [PROBE_PATH]); const dSame = writeOps(camp, bSame, [SETTLED_PATH]); writeOps(camp, bNone, [SETTLED_PATH]);
  // t1: an older partial export (other content) + an occupied v2 name
  writeFileSync(path.join(dOld, 'dataset.jsonl'), '{"operationId":"older-partial-export"}\n'); writeFileSync(path.join(dOld, 'dataset_summary.json'), '{"rows":1}\n');
  writeFileSync(path.join(dOld, 'dataset.v2.jsonl'), 'occupied\n');
  const before = { ds: sha256File(path.join(dOld, 'dataset.jsonl')), sum: sha256File(path.join(dOld, 'dataset_summary.json')), v2: sha256File(path.join(dOld, 'dataset.v2.jsonl')) };
  // t2: an export identical to what the freeze would write
  exportDataset(dSame); const sameSha = sha256File(path.join(dSame, 'dataset.jsonl'));
  const fr = freezeTrain(plan, camp, () => '2026-11-14T01:00:00.000Z');
  const row = (id: string) => fr.batches.find((r) => r.batchId === id)!;
  assert.equal(sha256File(path.join(dOld, 'dataset.jsonl')), before.ds, 'dataset.jsonl anterior intacto');
  assert.equal(sha256File(path.join(dOld, 'dataset_summary.json')), before.sum, 'resumo anterior intacto');
  assert.equal(sha256File(path.join(dOld, 'dataset.v2.jsonl')), before.v2, 'nome de versao ocupado nao e substituido');
  assert.equal(row('t1').datasetFile, 'dataset.v3.jsonl'); assert.equal(row('t1').datasetSha256, sha256File(path.join(dOld, 'dataset.v3.jsonl'))); assert.equal(row('t1').summarySha256, sha256File(path.join(dOld, 'dataset.v3_summary.json')));
  assert.equal(row('t2').datasetFile, 'dataset.jsonl'); assert.equal(row('t2').datasetSha256, sameSha);
  assert.equal(row('t3').datasetFile, 'dataset.jsonl');
  for (const d of ['t1', 't2', 't3']) assert.ok(!readdirSync(path.join(camp, 'batches', d)).some((f) => f.includes('freeze_tmp')), `${d}: sem temporario`);
  assert.equal(validateTrainFrozen(plan, path.join(camp, 'gates', 'TRAIN_FROZEN.json')).code, null);
  // the helper itself, called again on the preserved batch: the v3 it wrote is identical => a new v4 is NOT created only if dataset.jsonl matched; here it does not, so v4
  const again = exportDatasetForFreeze(dOld); assert.equal(path.basename(again.file), 'dataset.v4.jsonl'); assert.equal(sha256File(again.file), row('t1').datasetSha256);
});
