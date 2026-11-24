// SYNTHETIC — OFFLINE. C158 ciclo 3 (achado do ensaio sintetico): um plano de CAMPANHA para Sonnet/Opus 5.5 falhava com S1_OPERATIONS_MISSING porque o gerador do corpus so escreve a lista de operacoes dos ids originais.
// Agora Sonnet/Opus usam a lista do claude-haiku-5-5 (mesmos prompts, grupos e splits: o holdout do R6-M e lido pareado por texto). Haiku, GPT e Gemini nao mudam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, capsOfProfile } from '../../../scripts/h2eval/cli/plan.js';

const WORK = mkdtempSync(path.join(tmpdir(), 'h2eval-sonnetplan-')); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg');
const DESIGN = path.join(process.cwd(), 'scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json');

test('plano de campanha para Sonnet e Opus: mesmas operacoes e splits do Haiku 5.5 (pareado por texto), cada operacao com o modelo certo; Haiku inalterado', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 20261112, s2: 2, s3: 3, noRepoScan: true });
  const common = { corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY' as const, orderBySplit: true, unratifiedRehearsal: true, studyId: 'H2EVAL-SONNET-PLAN', designParamsFile: DESIGN, capsUsd: capsOfProfile('ciclo3_c158'), inputBoundFactor: 1.91, inputBoundExtraTokens: 37, maxCallsPerBatch: 50 };
  const h = buildPlan({ ...common, models: ['claude-haiku-5-5'] }); const s = buildPlan({ ...common, models: ['claude-sonnet-5-5'] }); const o = buildPlan({ ...common, models: ['claude-opus-5-5'] });
  const ids = (p: typeof h) => p.batches.flatMap((b) => b.operations.map((x) => `${x.plan.promptId}|${x.plan.split}|${x.plan.rep}`)).sort();
  assert.ok(ids(h).length > 0); assert.deepEqual(ids(s), ids(h), 'Sonnet: mesma lista de operacoes e splits'); assert.deepEqual(ids(o), ids(h), 'Opus: idem');
  assert.ok(s.batches.every((b) => b.model === 'claude-sonnet-5-5' && b.operations.every((x) => x.plan.modelRequested === 'claude-sonnet-5-5')));
  assert.ok(o.batches.every((b) => b.model === 'claude-opus-5-5' && b.operations.every((x) => x.plan.modelRequested === 'claude-opus-5-5')));
  assert.deepEqual([...new Set(s.batches.map((b) => b.block))].sort(), [...new Set(h.batches.map((b) => b.block))].sort(), 'mesmos blocos');
  assert.ok(s.batches.every((b) => b.calls <= 50), 'lotes ate o maximo configurado');
  const h2 = buildPlan({ ...common, models: ['claude-haiku-5-5'] }); assert.equal(h2.protocolHash, h.protocolHash, 'o plano do Haiku e deterministico e nao mudou');
});
