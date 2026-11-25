/**
 * Two checks added by an independent audit of the economic-study executor: a schedule with a gap in the sequence
 * numbers is refused, and the study's caps profile is not accepted by any older GO path.
 *
 * Modules under test: `scripts/h2eval/econ/econ.ts` (`validateCronograma`) and `scripts/h2eval/core/ledger.ts`
 * (`capsAreAllowedProfile`, `capsAreAllowedFor`, `CAPS_PROFILE_ECON_DR277`), using the fixture in
 * `./econ_fixture.ts`.
 *
 * Needs: a writable temporary directory (through the fixture). No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/econ/g15_lacuna_seq.test.ts`
 *
 * @module test/h2eval/econ/g15_lacuna_seq.test
 */
// Incorporado do G15 EXEC-ECON (auditor-independente C160, replica/g15tests/g15_extra.test.ts, R3: mutante M09), sem mudanca de conteudo alem deste cabecalho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCronograma, ECON_TIMEOUT_MS } from '../../../scripts/h2eval/econ/econ.js';
import { capsAreAllowedProfile, capsAreAllowedFor, usdToPico, CAPS_PROFILE_ECON_DR277 } from '../../../scripts/h2eval/core/ledger.js';
import { tmp, writeCorpus, writeCronograma } from './econ_fixture.js';
test('[G15] cronograma com LACUNA em seq (0,1,3,...) é recusado', () => {
  const dir = tmp('g15gap'); const { prompts } = writeCorpus(dir); const ok = writeCronograma(dir, prompts).lines;
  const gap = ok.map((l, i) => (i >= 2 ? { ...l, seq: l.seq + 1 } : l));
  assert.throws(() => validateCronograma(gap, ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_SEQ/);
  const start1 = ok.map((l) => ({ ...l, seq: l.seq + 1 }));
  assert.throws(() => validateCronograma(start1, ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_SEQ/);
});
test('[G15] perfil ECON 132/95/11/28 NÃO é aceito por nenhum caminho de GO (single ou multi)', () => {
  const c = usdToPico(CAPS_PROFILE_ECON_DR277.campaign);
  const pv = { anthropic: usdToPico('95'), openai: usdToPico('11'), google: usdToPico('28') };
  assert.equal(capsAreAllowedProfile(c, pv), false);
  for (const p of ['anthropic', 'openai', 'google'] as const) assert.equal(capsAreAllowedFor(c, p, pv[p]), false, p);
});
