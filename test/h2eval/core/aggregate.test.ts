/**
 * Tests that the aggregated spending cap of pilot plus campaign is enforced by code through one authoritative
 * study ledger.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`) and `scripts/h2eval/core/ledger.ts`
 * (`openLedger`, `usdToPico`), driven by the doubles in `../support/double.ts`.
 *
 * Strategy / scenarios: (1) spend recorded by a "pilot" batch reduces what a "campaign" batch in another directory
 * may still reserve on the same ledger; (2) a reservation that would overflow a provider sub-ledger is refused even
 * with a signed 80% acknowledgement and a signed pre-approval to 100%; (3) a reservation that would overflow the
 * global cap is refused while the provider sub-ledger is still open; (4) opening a ledger with caps above the
 * defaults (11 / 5 / 3 / 3 USD) is refused.
 *
 * Needs: a writable temporary directory. No network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/aggregate.test.ts`
 *
 * @module test/h2eval/core/aggregate.test
 */
// SYNTHETIC — OFFLINE. C144 D144-04 (author's request, 01:33 UTC): the AGGREGATED cap pilot + campaign is applied BY CODE through ONE
// authoritative study ledger: (1) the pilot's spend reduces what the campaign may still reserve (same sub-ledger, other batch directory);
// (2) a reservation that would overflow 5/3/3 is refused (STOP_BUDGET_PROVIDER) even with a signed pauseAck AND a signed
// preAuthorizeTo100pct — the pre-authorisation never passes the absolute cap; (3) a reservation that would overflow the global 11 is
// refused (STOP_BUDGET_CAMPAIGN) with the provider sub-ledger still open; (4) the ledger refuses caps above the defaults (assertCapsWithinDefaults).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { openLedger, usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, OFFICIAL_HOST } from '../support/double.js';

const STUDY = tmp('aggregate-study'); const LEDGER = path.join(STUDY, 'ledger.jsonl');
const SIGNED = [{ provider: 'anthropic' as const, acknowledgedBy: 'human:SYNTHETIC', source: 'go' as const, reference: 'test' }];
function setup(name: string, caps: { anthropic: string; campaign?: string }, steps: number, extra: Partial<ExecutorConfig> = {}) {
  const dir = path.join(STUDY, 'batches', name); mkdirSync(dir, { recursive: true });
  const store = memoryContentStore({ p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.' });
  const sd = scriptedDouble(Array.from({ length: steps }, () => ({ kind: 'ok' as const })));
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir),
    ledger: { campaignUsd: caps.campaign ?? '11', providersUsd: { anthropic: caps.anthropic, openai: '3', google: '3' } }, ledgerPath: LEDGER,
    reconcileJournalPaths: readdirSync(path.join(STUDY, 'batches')).map((b) => path.join(STUDY, 'batches', b, 'journal.jsonl')).filter((p) => existsSync(p)),
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), ...extra,
  };
  return { dir, store, sd, ex: createExecutor(cfg) };
}
const SPENT_PILOT = usdToPico('0.008'); const OP_CAP = usdToPico('0.00157');

test('(1) o gasto do "piloto" (lote A) e visto pela "campanha" (lote B) no MESMO ledger autoritativo: disponivel = teto - gasto do piloto', async () => {
  const a = setup('pilot-A', { anthropic: '5' }, 20);
  for (let i = 1; i <= 20; i += 1) assert.equal((await a.ex.run(plan({ promptSha256: a.store.sha['p1']!, promptId: `P${i}`, batchId: 'pilot-A' }))).state, 'COST_COMPUTED');
  a.ex.close();
  const b = setup('campaign-B', { anthropic: '5' }, 1);
  const st = b.ex.ledger.state().providers.anthropic;
  assert.deepEqual([st.spentUsd, st.operations], [SPENT_PILOT.toString(), 20], 'antes de qualquer envio da campanha, o ledger ja carrega as 20 operacoes do piloto');
  assert.equal((await b.ex.run(plan({ promptSha256: b.store.sha['p1']!, promptId: 'C1', batchId: 'campaign-B' }))).state, 'COST_COMPUTED');
  assert.equal(b.ex.ledger.state().providers.anthropic.operations, 21); b.ex.close();
});

test('(2) reserva que estouraria o sub-ledger e recusada (STOP_BUDGET_PROVIDER) mesmo com pauseAck E preAuthorizeTo100pct assinados: a pre-autorizacao nunca passa do teto absoluto', async () => {
  // committed 0.0084 after (1); cap 0.0095 => 88 % (checkpoint passes with the pre-authorisation) but 0.0084 + 0.00157 = 0.00997 > 0.0095
  const c = setup('campaign-C', { anthropic: '0.0095' }, 1, { pauseAck: SIGNED, preAuthorizedTo100: SIGNED, remainingScopeCapPico: () => 0n });
  const r = await c.ex.run(plan({ promptSha256: c.store.sha['p1']!, promptId: 'C1', batchId: 'campaign-C' }));
  assert.deepEqual([r.state, r.stop, c.sd.seen.length], ['STOP_BUDGET', 'STOP_BUDGET_PROVIDER', 0]);
  const st = c.ex.ledger.state().providers.anthropic; assert.equal(st.reservedUsd, '0'); assert.ok(BigInt(st.spentUsd) + OP_CAP > BigInt(st.capUsd)); c.ex.close();
});

test('(3) reserva que estouraria o teto GLOBAL (11 => aqui 0.0090) e recusada (STOP_BUDGET_CAMPAIGN) com o sub-ledger do provedor ainda aberto', async () => {
  const d = setup('campaign-D', { anthropic: '5', campaign: '0.0090' }, 1, { pauseAck: SIGNED, preAuthorizedTo100: SIGNED, remainingScopeCapPico: () => 0n });
  const r = await d.ex.run(plan({ promptSha256: d.store.sha['p1']!, promptId: 'C1', batchId: 'campaign-D' }));
  assert.deepEqual([r.state, r.stop, d.sd.seen.length], ['STOP_BUDGET', 'STOP_BUDGET_CAMPAIGN', 0]); d.ex.close();
});

test('(4) tetos acima dos padroes (11 / 5 / 3 / 3) sao recusados na abertura do ledger', () => {
  assert.throws(() => openLedger(path.join(STUDY, 'ledger-E.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '5.01', openai: '3', google: '3' } }), /anthropic 5.01 > 5/);
  assert.throws(() => openLedger(path.join(STUDY, 'ledger-F.jsonl'), { campaignUsd: '11.5', providersUsd: { anthropic: '5', openai: '3', google: '3' } }), /campaign 11.5 > 11/);
});
