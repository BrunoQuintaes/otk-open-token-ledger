// SYNTHETIC — OFFLINE. C158 ciclo 3: the ratified US$ 32 Anthropic ceiling as a NAMED, frozen caps profile (ciclo3_c158 = campaign 32, anthropic 32, openai 0, google 0). The executor used to pin
// the caps to 11/5/3/3 in three places; now it accepts exactly ONE other combination, as a whole, and only when plan, ledger and GO carry the same numbers. Anything else is still GO_CAPS_MISMATCH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, capsOfProfile, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { validateGoMultiV1 } from '../../../scripts/h2eval/core/egress.js';
import { CAPS_PROFILES, capsAreAllowedFor, capsAreAllowedProfile, usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { SYNTHETIC_IDENTITY_SHA, syntheticMultiGo } from '../support/gomulti.js';

const SHA = 'c'.repeat(40);
const WORK = mkdtempSync(path.join(tmpdir(), 'h2eval-caps-')); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg');
const P = (s: string) => usdToPico(s);
const prov = (a: string, o: string, g: string) => ({ anthropic: P(a), openai: P(o), google: P(g) });
let plan: BatchPlan;

test('perfis: o padrao 11/5/3/3 e o ciclo3 32/32/0/0 passam; qualquer mistura ou outro numero e recusado', () => {
  assert.equal(capsAreAllowedProfile(P('11'), prov('5', '3', '3')), true); assert.equal(capsAreAllowedProfile(P('32'), prov('32', '0', '0')), true);
  for (const [c, a, o, g] of [['32', '5', '3', '3'], ['11', '32', '0', '0'], ['32', '32', '1', '0'], ['32', '32', '0', '1'], ['32', '31', '0', '0'], ['32', '33', '0', '0'], ['33', '32', '0', '0'], ['100', '100', '0', '0'], ['11', '5', '3', '4'], ['0', '0', '0', '0'], ['32', '32', '3', '3']] as const) assert.equal(capsAreAllowedProfile(P(c), prov(a, o, g)), false, [c, a, o, g].join('/'));
  assert.equal(capsAreAllowedFor(P('11'), 'anthropic', P('5')), true); assert.equal(capsAreAllowedFor(P('32'), 'anthropic', P('32')), true); assert.equal(capsAreAllowedFor(P('11'), 'anthropic', P('32')), false); assert.equal(capsAreAllowedFor(P('32'), 'anthropic', P('5')), false); assert.equal(capsAreAllowedFor(P('32'), 'openai', P('3')), false);
  assert.deepEqual(Object.keys(CAPS_PROFILES), ['default', 'ciclo3_c158'], 'so dois perfis nomeados');
});

test('openLedger (achado do ensaio): aceita o perfil ciclo3 so inteiro; qualquer mistura acima do padrao continua CapsAboveDefault; o padrao e tetos menores continuam validos', async () => {
  const { openLedger, CapsAboveDefault } = await import('../../../scripts/h2eval/core/ledger.js');
  const open = (c: string, a: string, o: string, g: string) => openLedger(path.join(mkdtempSync(path.join(tmpdir(), 'h2eval-capsled-')), 'ledger.jsonl'), { campaignUsd: c, providersUsd: { anthropic: a, openai: o, google: g } });
  assert.doesNotThrow(() => open('32', '32', '0', '0'), 'perfil ciclo3'); assert.doesNotThrow(() => open('11', '5', '3', '3'), 'padrao'); assert.doesNotThrow(() => open('4', '2', '1', '1'), 'tetos menores');
  for (const [c, a, o, g] of [['32', '5', '3', '3'], ['33', '33', '0', '0'], ['32', '32', '1', '0'], ['100', '100', '0', '0'], ['32', '33', '0', '0'], ['12', '32', '0', '0']] as const) assert.throws(() => open(c, a, o, g), (e: unknown) => e instanceof CapsAboveDefault, [c, a, o, g].join('/'));
});

test('CLI: --caps-profile ausente/default = sem mudanca; ciclo3_c158 = 32/32/0/0; nome desconhecido recusado', () => {
  assert.equal(capsOfProfile(undefined), undefined); assert.equal(capsOfProfile('default'), undefined);
  assert.deepEqual(capsOfProfile('ciclo3_c158'), { campaign: '32', providers: { anthropic: '32', openai: '0', google: '0' } });
  for (const bad of ['ciclo3', 'CICLO3_C158', '32', '', 'custom']) assert.throws(() => capsOfProfile(bad), (e: { code?: string }) => e.code === 'CAPS_PROFILE_UNKNOWN', bad);
});

test('setup + GO multilote: plano e GO com o perfil ciclo3 passam; GO e ledger precisam concordar; mistura e GO "frouxo" continuam GO_CAPS_MISMATCH', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 424242, s2: 2, s3: 3, noRepoScan: true });
  plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-CAPS', capsUsd: capsOfProfile('ciclo3_c158'), models: ['claude-haiku-5-5'] });
  assert.deepEqual(plan.policy.capsUsd, { campaign: '32', providers: { anthropic: '32', openai: '0', google: '0' } }, 'o plano carrega o perfil explicitamente');
  const ids = plan.batches.filter((b) => !b.branchLocked).map((b) => b.batchId);
  const ctx = { campaignDirCanonical: null as string | null, campaignIdentitySha256: SYNTHETIC_IDENTITY_SHA as string | null, campaign: plan.studyId, preregistrationSha256: plan.preregistration.sha256, executorCodeSha: SHA, treeClean: true as boolean | null, planProtocolHash: plan.protocolHash, planBatchIds: plan.batches.map((b) => b.batchId), plannedOpsInScope: (x: readonly string[]) => plan.batches.filter((b) => x.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), nowMs: Date.now() };
  const C3 = { campaignUsd: '32', providersUsd: { anthropic: '32', openai: '0', google: '0' } }; const DEF = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
  const goCaps = (c: number, a: number, o: number, g: number) => ({ caps: { perProviderSubLedgerUsd: { anthropic: a, openai: o, google: g }, globalCampaignUsd: c, pauseAtFractionOfSubLedger: 0.8 } });
  const go = (over?: ReturnType<typeof goCaps>) => syntheticMultiGo(plan, ids, { executorCodeSha: SHA, ...(over ? { over } : {}) });
  assert.equal(validateGoMultiV1(go(goCaps(32, 32, 0, 0)), { ...ctx, ledgerCaps: C3 }), null, 'perfil ciclo3 de ponta a ponta');
  assert.equal(validateGoMultiV1(go(), { ...ctx, ledgerCaps: DEF }), null, 'o padrao segue valido');
  const rows: Array<[string, ReturnType<typeof go>, typeof C3]> = [
    ['GO padrao + ledger ciclo3', go(), C3], ['GO ciclo3 + ledger padrao', go(goCaps(32, 32, 0, 0)), DEF],
    ['GO ciclo3 + ledger com sub-ledger 33', go(goCaps(32, 32, 0, 0)), { campaignUsd: '32', providersUsd: { anthropic: '33', openai: '0', google: '0' } }],
    ['GO e ledger mistos 32/5/3/3', go(goCaps(32, 5, 3, 3)), { campaignUsd: '32', providersUsd: { anthropic: '5', openai: '3', google: '3' } }],
    ['GO e ledger 11/32/0/0', go(goCaps(11, 32, 0, 0)), { campaignUsd: '11', providersUsd: { anthropic: '32', openai: '0', google: '0' } }],
    ['GO e ledger 100/100/0/0', go(goCaps(100, 100, 0, 0)), { campaignUsd: '100', providersUsd: { anthropic: '100', openai: '0', google: '0' } }],
    ['ciclo3 com openai aberto (32/32/3/0)', go(goCaps(32, 32, 3, 0)), { campaignUsd: '32', providersUsd: { anthropic: '32', openai: '3', google: '0' } }],
  ];
  for (const [name, g, led] of rows) assert.equal(validateGoMultiV1(g, { ...ctx, ledgerCaps: led }), 'GO_CAPS_MISMATCH', name);
});
