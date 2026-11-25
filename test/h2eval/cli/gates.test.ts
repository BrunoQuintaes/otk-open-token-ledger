/**
 * Tests that the two split gates of a campaign (training frozen, validation selected) are revalidated in full on
 * every use, so forged or later-edited gate files are refused.
 *
 * Module under test: `scripts/h2eval/cli/campaign.ts` (`gateFor`, `validateTrainFrozen`,
 * `validateValidationSelected`).
 *
 * Strategy / partitions: a valid training-frozen file gives a digest; refused variants: wrong schema, another
 * protocol hash, a tampered batch list (recomputed sha256), a batch outside the plan, terminal rows that do not
 * match the operations, a forecast table that read the holdout. A valid validation-selected file gives a digest and
 * the selection; refused variants: unsigned, a parameters hash that does not match the parameters, a training-frozen
 * file changed after the selection, and a missing or invalid training-frozen file.
 *
 * Needs: a writable temporary directory for synthetic gate files. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/gates.test.ts`
 *
 * @module test/h2eval/cli/gates.test
 */
// SYNTHETIC — OFFLINE. R15-D-1 / R15-D-2 (G15 delta on 26854a80): the split gates are revalidated WHOLE at every use. Forged or later-edited
// TRAIN_FROZEN / VALIDATION_SELECTED artifacts are refused: wrong schema, other protocolHash, tampered batch list (recomputed sha256),
// rows outside the plan, forecast table that read holdout, unsigned selection, paramsSha256 != sha256(params), TRAIN_FROZEN changed after
// the select (trainFrozenSha256), missing TRAIN_FROZEN under a VALIDATION_SELECTED. A valid pair passes and yields the gate digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gateFor, validateTrainFrozen, validateValidationSelected, type TrainFrozen, type ValidationSelected } from '../../../scripts/h2eval/cli/campaign.js';
import { sha256File, sha256Text } from '../../../scripts/h2eval/cli/common.js';
import type { BatchPlan, PlannedBatch } from '../../../scripts/h2eval/cli/plan.js';

const PH = 'p'.repeat(64); const H = (c: string) => c.repeat(64);
const mk = (block: PlannedBatch['block'], id: string, locked = false) => ({ batchId: id, block, branchLocked: locked, provider: locked ? 'google' : 'openai', model: 'm', calls: 1, operations: [] }) as unknown as PlannedBatch;
const plan = { protocolHash: PH, phase: 'CONFIRMATORY', batches: [mk('train', 'campaign-train-m-b1'), mk('comparative', 'campaign-comparative-m-b1'), mk('train', 'campaign-train-g-b1', true), mk('validation', 'campaign-validation-m-b1'), mk('holdout', 'campaign-holdout-m-b1')] } as unknown as BatchPlan;
const VAL = plan.batches[3]!; const HOLD = plan.batches[4]!;
const rows: TrainFrozen['batches'] = [{ batchId: 'campaign-train-m-b1', batchDir: 'x', operations: 3, terminal: 3, datasetSha256: H('a'), summarySha256: H('b') }, { batchId: 'campaign-comparative-m-b1', batchDir: 'y', operations: 2, terminal: 2, datasetSha256: H('c'), summarySha256: H('d') }];
const goodFrozen = (over: Partial<TrainFrozen> = {}): TrainFrozen => { const b = over.batches ?? rows; return { schema: 'h2eval.gate.train_frozen.v0', protocolHash: PH, frozenUtc: 'x', batches: b, sha256OfBatchList: sha256Text(JSON.stringify(b)), forecastFrozen: null, ...over }; };
const params = { m: { a: 1, b: 1.1, out: 40 } };
const goodSel = (tfSha: string, over: Partial<ValidationSelected> = {}): ValidationSelected => ({ schema: 'h2eval.gate.validation_selected.v0', protocolHash: PH, selectedUtc: 'x', trainFrozenSha256: tfSha, validationBatches: [{ batchId: 'campaign-validation-m-b1', datasetSha256: H('e') }], profile: { method: 'M1', profileId: 'p', paramsSha256: sha256Text(JSON.stringify(params)), trainedOn: 'SYNTHETIC', params }, selectedBy: 'human:SYNTHETIC', forecastFrozen: null, ...over });
function study(tf: unknown, sel?: unknown): { dir: string; tfFile: string; selFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'h2eval-gates-')); mkdirSync(path.join(dir, 'gates'));
  const tfFile = path.join(dir, 'gates', 'TRAIN_FROZEN.json'); const selFile = path.join(dir, 'gates', 'VALIDATION_SELECTED.json');
  if (tf !== undefined) writeFileSync(tfFile, typeof tf === 'string' ? tf : JSON.stringify(tf));
  if (sel !== undefined) writeFileSync(selFile, typeof sel === 'string' ? sel : JSON.stringify(sel));
  return { dir, tfFile, selFile };
}

test('R15-D-1 TRAIN_FROZEN: valido => digest; forjado/alterado => recusado (esquema, lista adulterada, lote fora do plano, terminal != operations, forecast leu holdout, ilegivel); R15-D-2 outro protocolHash', () => {
  const ok = study(goodFrozen()); const g = gateFor(plan, VAL, ok.dir);
  assert.deepEqual([g.code, g.gateUsed?.file, g.gateUsed?.sha256], [null, 'TRAIN_FROZEN.json', sha256File(ok.tfFile)]);
  const cases: Array<[string, string, unknown]> = [
    ['R15-D-2 outro protocolHash', 'GATE_PROTOCOL_MISMATCH', goodFrozen({ protocolHash: H('9') })],
    ['esquema', 'GATE_ARTIFACT_SCHEMA', { ...goodFrozen(), schema: 'h2eval.gate.train_frozen.v1' }],
    ['lista adulterada apos o freeze (sha256 recalculado)', 'GATE_BATCH_LIST_SHA_MISMATCH', { ...goodFrozen(), batches: [{ ...rows[0]!, datasetSha256: H('f') }, rows[1]!] }],
    ['lista vazia', 'GATE_BATCH_LIST_INVALID', goodFrozen({ batches: [] })],
    ['terminal != operations', 'GATE_BATCH_LIST_INVALID', goodFrozen({ batches: [{ ...rows[0]!, terminal: 2 }, rows[1]!] })],
    ['digest nao hex64', 'GATE_BATCH_LIST_INVALID', goodFrozen({ batches: [{ ...rows[0]!, datasetSha256: 'abc' }, rows[1]!] })],
    ['lote fora do plano (lista re-hasheada)', 'GATE_BATCH_LIST_NOT_PLAN', goodFrozen({ batches: [rows[0]!, { ...rows[1]!, batchId: 'campaign-train-other-b1' }] })],
    ['lote de treino faltando', 'GATE_BATCH_LIST_NOT_PLAN', goodFrozen({ batches: [rows[0]!] })],
    ['forecast leu holdout', 'GATE_FORECAST_READ_HOLDOUT', goodFrozen({ forecastFrozen: { schema: 'h2eval.forecast_frozen.v0', freezeSha256: H('1'), perModel: {}, holdoutRead: true } as never })],
    ['forecast invalido', 'GATE_FORECAST_INVALID', goodFrozen({ forecastFrozen: { schema: 'nope' } as never })],
    ['ilegivel', 'GATE_ARTIFACT_UNREADABLE', '{not json'],
  ];
  for (const [name, code, art] of cases) { const s = study(art); const r = gateFor(plan, VAL, s.dir); assert.equal(r.code, code, name); assert.equal(r.gateUsed, null, name); assert.equal(validateTrainFrozen(plan, s.tfFile).code, code, name); }
  assert.equal(gateFor(plan, VAL, study(undefined).dir).code, 'GATE_TRAIN_NOT_FROZEN');
});

test('R15-D-1 VALIDATION_SELECTED: valido => digest + selecao; nao assinado, paramsSha256 errado, TRAIN_FROZEN alterado apos o select, TRAIN_FROZEN ausente ou invalido, lote de validacao fora do plano, outro protocolHash => recusado', () => {
  const tf = goodFrozen(); const base = study(tf); const tfSha = sha256File(base.tfFile);
  writeFileSync(base.selFile, JSON.stringify(goodSel(tfSha)));
  const g = gateFor(plan, HOLD, base.dir);
  assert.deepEqual([g.code, g.gateUsed?.file, g.gateUsed?.sha256, g.selection?.profile.profileId], [null, 'VALIDATION_SELECTED.json', sha256File(base.selFile), 'p']);
  const cases: Array<[string, string, unknown, unknown?]> = [
    ['R15-D-2 outro protocolHash', 'GATE_PROTOCOL_MISMATCH', goodSel(tfSha, { protocolHash: H('9') })],
    ['esquema', 'GATE_ARTIFACT_SCHEMA', { ...goodSel(tfSha), schema: 'x' }],
    ['nao assinado', 'GATE_UNSIGNED', goodSel(tfSha, { selectedBy: 'agent:bot' })],
    ['paramsSha256 != sha256(params) (params editados apos o select)', 'GATE_PROFILE_SHA_MISMATCH', goodSel(tfSha, { profile: { ...goodSel(tfSha).profile, params: { m: { a: 2, b: 1.1, out: 40 } } } })],
    ['perfil sem metodo valido', 'GATE_PROFILE_INVALID', goodSel(tfSha, { profile: { ...goodSel(tfSha).profile, method: 'M9' as never } })],
    ['TRAIN_FROZEN alterado apos o select (mesma lista, outro frozenUtc)', 'GATE_TRAIN_FROZEN_CHANGED', goodSel(tfSha), goodFrozen({ frozenUtc: 'later' })],
    ['TRAIN_FROZEN forjado sob a selecao', 'GATE_BATCH_LIST_SHA_MISMATCH', goodSel(tfSha), { ...goodFrozen(), batches: [{ ...rows[0]!, datasetSha256: H('f') }, rows[1]!] }],
    ['TRAIN_FROZEN de outro protocolo', 'GATE_PROTOCOL_MISMATCH', goodSel(tfSha), goodFrozen({ protocolHash: H('8') })],
    ['lote de validacao fora do plano', 'GATE_BATCH_LIST_NOT_PLAN', goodSel(tfSha, { validationBatches: [{ batchId: 'campaign-validation-other-b1', datasetSha256: H('e') }] })],
    ['lista de validacao vazia', 'GATE_BATCH_LIST_INVALID', goodSel(tfSha, { validationBatches: [] })],
    ['forecast da selecao leu holdout', 'GATE_FORECAST_READ_HOLDOUT', goodSel(tfSha, { forecastFrozen: { schema: 'h2eval.forecast_frozen.v0', freezeSha256: H('1'), perModel: {}, holdoutRead: true } as never })],
    ['ilegivel', 'GATE_ARTIFACT_UNREADABLE', '{'],
  ];
  for (const [name, code, sel, tfOver] of cases) { const s = study(tfOver ?? tf, sel); const r = gateFor(plan, HOLD, s.dir); assert.equal(r.code, code, name); assert.deepEqual([r.gateUsed, r.selection], [null, null], name); assert.equal(validateValidationSelected(plan, s.selFile, s.tfFile).code, code, name); }
  // TRAIN_FROZEN missing under a selection: refused (the selection points at a file that no longer exists)
  const noTf = study(undefined, goodSel(tfSha)); assert.equal(gateFor(plan, HOLD, noTf.dir).code, 'GATE_TRAIN_NOT_FROZEN');
  assert.equal(gateFor(plan, HOLD, study(tf).dir).code, 'GATE_VALIDATION_NOT_SELECTED');
});
