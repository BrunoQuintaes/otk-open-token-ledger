/**
 * Tests that the executor opens and runs under the named caps profile, and that sub-ledgers set to 0 block their
 * providers.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`) and `scripts/h2eval/core/ledger.ts`
 * (`BudgetStop`, `CapsAboveDefault`), driven by the doubles in `../support/double.ts`.
 *
 * Strategy / partitions: the profile opens, reserves, sends and settles one Anthropic operation; OpenAI and Google
 * with a 0 sub-ledger are blocked by a budget stop while Anthropic still reserves; the profile branch requires
 * exactly the three providers (an extra or a missing provider is not covered); and ledgers above or mixed with the
 * profile are refused when the executor is created.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value, the variable name the
 * offline egress is configured with. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/capsProfileExecutor.test.ts`
 *
 * @module test/h2eval/core/capsProfileExecutor.test
 */
// SYNTHETIC — OFFLINE. C158 ciclo 3 (pedido da BOT-01 no G15 do E2): o EXECUTOR abre e roda com o perfil de tetos ciclo3_c158 (32/32/0/0); um ledger acima do perfil continua recusado ao criar o executor;
// com sub-ledger 0 o OpenAI e o Google ficam bloqueados por BudgetStop (nada do programa pode ser gasto la) e o Anthropic reserva e liquida normalmente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { BudgetStop, CapsAboveDefault } from '../../../scripts/h2eval/core/ledger.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-caps-canary';
const TEXTS = { a: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.' };
function build(caps: { campaignUsd: string; providersUsd: { anthropic: string; openai: string; google: string } }) {
  const dir = tmp('capsx'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = [];
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir), ledger: caps,
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' }, double: async (req: BuiltRequest) => { sent.push(req); const r = rawBodyOf({ kind: 'ok', input: 10, output: 5 }); return { httpStatus: r.status, body: r.body }; } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40),
  };
  return { dir, store, sent, cfg };
}

test('createExecutor com o perfil ciclo3 (32/32/0/0): abre, reserva, envia e liquida uma operacao Anthropic', async () => {
  const b = build({ campaignUsd: '32', providersUsd: { anthropic: '32', openai: '0', google: '0' } }); const ex = createExecutor(b.cfg);
  const r = await ex.run(plan({ promptSha256: b.store.sha['a']! })); assert.equal(r.stop, null); assert.equal(b.sent.length, 1);
  const st = ex.ledger.state(); assert.equal(st.providers['anthropic']!.reservedUsd, '0'); assert.ok(BigInt(st.providers['anthropic']!.spentUsd) > 0n); ex.close();
});

test('sub-ledger 0: OpenAI e Google bloqueados por BudgetStop; o Anthropic continua reservando', () => {
  const b = build({ campaignUsd: '32', providersUsd: { anthropic: '32', openai: '0', google: '0' } }); const ex = createExecutor(b.cfg);
  for (const p of ['openai', 'google'] as const) assert.throws(() => ex.ledger.reserve('1'.repeat(64), p, 'b', 1n), (e: unknown) => e instanceof BudgetStop, p);
  assert.doesNotThrow(() => ex.ledger.reserve('2'.repeat(64), 'anthropic', 'b', 1_000_000n)); ex.close();
});

test('E2-2 (BOT-01): o ramo do perfil exige EXATAMENTE os tres provedores: um provedor extra (mesmo com teto enorme), ou a falta de um, nao e coberto', () => {
  const mk = (providers: Record<string, string>) => build({ campaignUsd: '32', providersUsd: providers as never });
  const provs: Array<Record<string, string>> = [{ anthropic: '32', openai: '0', google: '0', xai: '1000' }, { anthropic: '32', openai: '0', google: '0', xai: '0' }, { anthropic: '32', openai: '0' }, { anthropic: '32' }, { anthropic: '32', openai: '0', gemini: '0' }];
  for (const prov of provs) {
    const b = mk(prov); assert.throws(() => createExecutor(b.cfg), (e: unknown) => e instanceof CapsAboveDefault || e instanceof TypeError, JSON.stringify(prov));
  }
  const ok = mk({ anthropic: '32', openai: '0', google: '0' }); assert.doesNotThrow(() => createExecutor(ok.cfg).close());
});

test('createExecutor recusa ledger acima do perfil ou misturado (CapsAboveDefault): 33/33/0/0, 32/32/1/0, 32/5/3/3, 100/100/0/0', () => {
  for (const [c, a, o, g] of [['33', '33', '0', '0'], ['32', '32', '1', '0'], ['32', '5', '3', '3'], ['100', '100', '0', '0']] as const) {
    const b = build({ campaignUsd: c, providersUsd: { anthropic: a, openai: o, google: g } });
    assert.throws(() => createExecutor(b.cfg), (e: unknown) => e instanceof CapsAboveDefault, [c, a, o, g].join('/'));
  }
});
