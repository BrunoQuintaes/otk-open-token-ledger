/**
 * EXEC-ECON C160 delta 2 (master; X1 v3.2 ressalva R-A): `truncated` BOOLEANO a partir do `completion` e `stopReason` sempre presente
 * na linha por tentativa, com contrato nos 3 provedores passando pela porta v3.2 REAL do kit (rubrica_econ.mjs sha 73b4f400…).
 * Offline, US$ 0. A porta é lida do kit (fora do repositório, só leitura); sem o kit nesta máquina, o teste da porta é pulado e declarado.
 *
 * English summary: tests that each per-attempt line of the economic study carries a boolean `truncated` derived from
 * the completion and always a `stopReason`, and that these lines pass the study's external grading gate.
 *
 * Modules under test: `scripts/h2eval/econ/econ.ts` (`truncatedOf`, `tentativaOf`, `runEcon`), using the fixture in
 * `./econ_fixture.ts`.
 *
 * Strategy / partitions: `truncatedOf` for complete, truncated, unknown, refused and other completions; a record that
 * has only the completion field; and the contract over three providers and five models (complete, output limit, no
 * end) checked by the real external gate module, whose file hash is verified.
 *
 * Needs: a writable temporary directory. The gate test imports a module from a fixed folder outside the repository
 * and is skipped, visibly, when that folder is absent. No network, no spending.
 *
 * Run just this file: `npx tsx --test test/h2eval/econ/econ_porta_v32.test.ts`
 *
 * @module test/h2eval/econ/econ_porta_v32.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEcon, truncatedOf, tentativaOf, ECON_TIMEOUT_MS, type CronLine } from '../../../scripts/h2eval/econ/econ.js';
import { ambiente, respostaDe, MODELOS, type Caso } from './econ_fixture.js';

const KIT_V32 = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/C160/ECON_PREP/V3_2/KIT';
const RUBRICA = path.join(KIT_V32, 'rubrica_econ.mjs');
const RUBRICA_SHA = '73b4f4000797088bfee3211d63f95129b5663c10c4b29914ebf753b731148d2a';

test('[R-A] truncatedOf: COMPLETE => false; TRUNCATED_* => true; sem informação => UNKNOWN; REFUSED/OTHER pelo stopReason', () => {
  assert.equal(truncatedOf('COMPLETE', 'end_turn'), false);
  assert.equal(truncatedOf('COMPLETE', 'UNKNOWN'), false);
  assert.equal(truncatedOf('TRUNCATED_MAX_TOKENS', 'max_tokens'), true);
  assert.equal(truncatedOf('TRUNCATED_MAX_TOKENS', 'UNKNOWN'), true);
  assert.equal(truncatedOf('UNKNOWN', 'UNKNOWN'), 'UNKNOWN');
  assert.equal(truncatedOf(undefined, 'UNKNOWN'), 'UNKNOWN');
  assert.equal(truncatedOf('REFUSED', 'refusal'), false);
  assert.equal(truncatedOf('OTHER', 'length'), true);
  assert.equal(truncatedOf('OTHER', 'pause_turn'), false);
});
test('[R-A] registro REAL só com completion (sem campo truncated): a linha traz truncated booleano e o stopReason', () => {
  const l = { seq: 0, block: 0, posNoBloco: 0, opId: 'd'.repeat(64), itemId: 'i', family: 'classificar', templateId: 't', arm: 'C2', rep: 1, model: 'claude-haiku-5-5', provider: 'anthropic', promptSha256: 'e'.repeat(64), systemSha256: 'x', maxOutputTokens: 8192, samplingParams: 'NOT_SENT', reasoningParams: 'NOT_SENT', cacheDirectives: 'NONE', tools: 'NONE', maxRetries: 0 } as CronLine;
  const base = { operationId: l.opId, outcome: 'OK', modelDeprecation: 'UNKNOWN', exclusion: 'NONE', httpStatus: 200, refusal: null, usage: null, responseSha256: 'UNKNOWN', cost: { state: 'UNKNOWN', usd: 'UNKNOWN', capCovered: 'UNKNOWN' }, tsSentUtc: 't', tsReceivedUtc: 't', latencyMs: 1, finalState: 'COST_COMPUTED' };
  for (const [completion, stopReason, want] of [['COMPLETE', 'end_turn', false], ['TRUNCATED_MAX_TOKENS', 'max_tokens', true], ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']] as const) {
    const t = tentativaOf(l, { ...base, completion, stopReason } as never, null, 1_000_000n, ECON_TIMEOUT_MS);
    assert.equal(t.truncated, want, completion); assert.equal(t.stopReason, stopReason);
    assert.ok('truncated' in t && 'stopReason' in t);
  }
});

const ESPERADO: Record<string, { truncated: boolean | 'UNKNOWN'; classe: string }> = {
  texto: { truncated: false, classe: 'OK' },
  limite: { truncated: true, classe: 'TRUNCADO' },
  nulo: { truncated: 'UNKNOWN', classe: 'FIM_DESCONHECIDO' },
};
test('[R-A] contrato nos 3 provedores (5 modelos) pela porta v3.2 REAL do kit: COMPLETE => OK, limite => TRUNCADO, sem fim => FIM_DESCONHECIDO', { skip: existsSync(RUBRICA) ? false : 'kit v3.2 ausente nesta máquina' }, async () => {
  assert.equal(createHash('sha256').update(readFileSync(RUBRICA)).digest('hex'), RUBRICA_SHA, 'porta v3.2 congelada');
  const { portaOperacional } = (await import(pathToFileURL(RUBRICA).href)) as { portaOperacional: (op: unknown, t: unknown, aceitos: unknown) => { classe: string } };
  for (const [model, provider, arm] of MODELOS) for (const caso of Object.keys(ESPERADO) as Caso[]) {
    const a = ambiente({ only: model, blocks: 1, answer: (req) => respostaDe(provider, (req.body as { model?: string }).model ?? model, caso, '{"route":"captura"}') });
    await runEcon(a.cfg);
    const t = JSON.parse(readFileSync(path.join(a.cfg.batchDir, 'TENTATIVAS.jsonl'), 'utf8').trim()) as { truncated: unknown; stopReason: unknown };
    assert.equal(t.truncated, ESPERADO[caso]!.truncated, `${model} ${caso} truncated`);
    assert.equal(typeof t.stopReason, 'string', `${model} ${caso} stopReason presente`);
    const r = portaOperacional({ opId: a.cron[0]!.opId, itemId: a.cron[0]!.itemId, arm, model }, t, { [arm]: { [model]: [model] } });
    assert.equal(r.classe, ESPERADO[caso]!.classe, `${model} ${caso} porta v3.2`);
  }
});
