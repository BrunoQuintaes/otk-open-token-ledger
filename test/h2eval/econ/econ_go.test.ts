/**
 * EXEC-ECON C160 delta 2 (R2 do G15): contrato do GO do estudo (h2eval.go.econ.v1). Offline, US$ 0.
 * Aceita SÓ o perfil ECON; recusa vencido, teto e escopo; os validadores de GO existentes não mudam e continuam recusando o ECON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { validateGoV1, validateGoMultiV1 } from '../../../scripts/h2eval/core/egress.js';
import { CAPS_PROFILE_ECON_DR277, DEFAULT_CAPS_USD, CAPS_PROFILE_CICLO3 } from '../../../scripts/h2eval/core/ledger.js';
import { validateGoEconV1, goEconCoversAttempt, GO_ECON_REQUIRED_STOPS, GO_ECON_MAX_WINDOW_MS, type GoEconContext, type GoEconV1 } from '../../../scripts/h2eval/econ/goEcon.js';
import { runEcon, ECON_TIMEOUT_MS } from '../../../scripts/h2eval/econ/econ.js';
import { ambiente } from './econ_fixture.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const PREREG = '9'.repeat(64);
const ctx = (o: Partial<GoEconContext> = {}): GoEconContext => ({ campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), treeClean: true, cronogramaSha256: 'f'.repeat(64), cronogramaLength: 10, timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO', ledgerCaps: { campaignUsd: CAPS_PROFILE_ECON_DR277.campaign, providersUsd: { ...CAPS_PROFILE_ECON_DR277.providers } }, nowMs: NOW, ...o });
type Over = { [K in keyof GoEconV1]?: unknown } & Record<string, unknown>;
function goText(over: Over = {}, o: { tamper?: (g: Record<string, unknown>) => void } = {}): string {
  const g: Record<string, unknown> = {
    schema: 'h2eval.go.econ.v1', campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), cronogramaSha256: 'f'.repeat(64), timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO',
    capsProfile: 'econ_dr277', caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 },
    scope: { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 },
    window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: '2026-11-21T00:00:00Z' },
    stops: [...GO_ECON_REQUIRED_STOPS], signedBy: 'human:TESTE', signatureStatement: 'GO de TESTE do estudo econômico (fixture)', ...over,
  };
  delete g['goDigestSha256']; g['goDigestSha256'] = sha256Canon(g); o.tamper?.(g);
  return JSON.stringify(g);
}

test('[R2] GO ECON válido é aceito', () => { assert.equal(validateGoEconV1(goText(), ctx()), null); });
test('[R2/7b] tetos do GO dentro do envelope ECON (<= 95/11/28/132, > 0) e iguais ao ledger efetivo: aceitos; fora do envelope ou diferente do ledger: recusados', () => {
  // delta 7b (X1 v3.5 R2): os tetos do autor vêm do GO; antes só o perfil exato 95/11/28/132 passava
  const L = (c: string, a: string, o: string, g: string) => ({ ledgerCaps: { campaignUsd: c, providersUsd: { anthropic: a, openai: o, google: g } } });
  const C = (c: string, a: string, o: string, g: string) => ({ caps: { perProviderSubLedgerUsd: { anthropic: a, openai: o, google: g }, globalCampaignUsd: c, pauseAtFractionOfSubLedger: 0.8 } });
  assert.equal(validateGoEconV1(goText(C('97', '76', '11', '10')), ctx(L('97', '76', '11', '10'))), null, 'tetos da página MVP5-9');
  assert.equal(validateGoEconV1(goText(C('98.5', '76', '11', '11.5')), ctx(L('98.5', '76', '11', '11.5'))), null);
  assert.equal(validateGoEconV1(goText(C('132', '95', '11', '28')), ctx()), null, 'o limite do protocolo continua aceito');
  assert.equal(validateGoEconV1(goText(C('97', '76', '11', '10')), ctx()), 'GO_CAPS_MISMATCH', 'GO diferente do ledger efetivo');
  assert.equal(validateGoEconV1(goText(C('132', '95', '11', '28')), ctx(L('97', '76', '11', '10'))), 'GO_CAPS_MISMATCH', 'ledger diferente do GO');
  // fora do envelope (para cima), mesmo coerente com o ledger
  for (const [c, a, o, g] of [['133', '95', '11', '28'], ['132', '96', '11', '28'], ['132', '95', '12', '28'], ['132', '95', '11', '28.01'], ['132', '95', '11', '43.08']] as const)
    assert.equal(validateGoEconV1(goText(C(c, a, o, g)), ctx(L(c, a, o, g))), 'GO_CAPS_MISMATCH', `${c}/${a}/${o}/${g}`);
  // sub-teto zero ou agregado zero (o ciclo3 32/32/0/0 tem providers 0): recusado
  for (const pr of [CAPS_PROFILE_CICLO3]) { const x = C(pr.campaign, pr.providers.anthropic, pr.providers.openai, pr.providers.google); assert.equal(validateGoEconV1(goText(x), ctx(L(pr.campaign, pr.providers.anthropic, pr.providers.openai, pr.providers.google))), 'GO_CAPS_MISMATCH'); }
  assert.equal(validateGoEconV1(goText(C('0', '76', '11', '10')), ctx(L('0', '76', '11', '10'))), 'GO_CAPS_MISMATCH');
  void DEFAULT_CAPS_USD;
  assert.equal(validateGoEconV1(goText({ capsProfile: 'default' }), ctx()), 'GO_CAPS');
  assert.equal(validateGoEconV1(goText({ caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.9 } }), ctx()), 'GO_CAPS');
});
test('[R2] teto: sub-teto ou agregado do GO diferente do ledger efetivo (aqui 95/11/28/132) é recusado, para cima e para baixo', () => {
  for (const [p, v] of [['anthropic', '96'], ['anthropic', '94'], ['openai', '12'], ['google', '43.08'], ['google', '27']] as const) {
    const per = { anthropic: '95', openai: '11', google: '28', [p]: v };
    assert.equal(validateGoEconV1(goText({ caps: { perProviderSubLedgerUsd: per, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 } }), ctx()), 'GO_CAPS_MISMATCH', `${p}=${v}`);
  }
  assert.equal(validateGoEconV1(goText({ caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '144.18', pauseAtFractionOfSubLedger: 0.8 } }), ctx()), 'GO_CAPS_MISMATCH');
});
test('[R2] validade: vencido, ainda não válido e janela longa demais são recusados', () => {
  assert.equal(validateGoEconV1(goText(), ctx({ nowMs: Date.parse('2026-11-21T00:00:00Z') })), 'GO_EXPIRED');
  assert.equal(validateGoEconV1(goText(), ctx({ nowMs: Date.parse('2026-11-19T23:59:59Z') })), 'GO_NOT_YET_VALID');
  assert.equal(validateGoEconV1(goText({ window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: new Date(Date.parse('2026-11-20T00:00:00Z') + GO_ECON_MAX_WINDOW_MS + 1000).toISOString() } }), ctx()), 'GO_WINDOW_TOO_LONG');
  assert.equal(validateGoEconV1(goText({ window: { notBeforeUtc: 'x', notAfterUtc: '2026-11-21T00:00:00Z' } }), ctx()), 'GO_NOT_YET_VALID');
});
test('[R2] escopo: modelo fora do ECON, curinga, provedor incoerente, faixa de seq fora do cronograma, maxAttempts acima da faixa', () => {
  const sc = (o: Record<string, unknown>) => ({ scope: { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10, ...o } });
  assert.equal(validateGoEconV1(goText(sc({ modelIds: ['claude-sonnet-5-5'], providers: ['anthropic'] })), ctx()), 'GO_MODEL_NOT_ECON');
  assert.equal(validateGoEconV1(goText(sc({ modelIds: ['*'], providers: ['anthropic'] })), ctx()), 'GO_MODEL_NOT_ECON');
  assert.equal(validateGoEconV1(goText(sc({ modelIds: ['gpt-6-luna'], providers: ['anthropic'] })), ctx()), 'GO_SCOPE_INVALID');
  assert.equal(validateGoEconV1(goText(sc({ modelIds: ['gpt-6-luna'], providers: ['openai', 'google'] })), ctx()), 'GO_SCOPE_INVALID');
  assert.equal(validateGoEconV1(goText(sc({ modelIds: [] })), ctx()), 'GO_SCOPE_INVALID');
  assert.equal(validateGoEconV1(goText(sc({ seqTo: 10, maxAttempts: 11 })), ctx()), 'GO_SEQ_RANGE');
  assert.equal(validateGoEconV1(goText(sc({ seqFrom: 5, seqTo: 4 })), ctx()), 'GO_SEQ_RANGE');
  assert.equal(validateGoEconV1(goText(sc({ seqFrom: -1 })), ctx()), 'GO_SEQ_RANGE');
  assert.equal(validateGoEconV1(goText(sc({ seqFrom: 2, seqTo: 4, maxAttempts: 4 })), ctx()), 'GO_MAX_ATTEMPTS');
  assert.equal(validateGoEconV1(goText(sc({ maxAttempts: 0 })), ctx()), 'GO_MAX_ATTEMPTS');
  assert.equal(validateGoEconV1(goText(sc({ seqFrom: 2, seqTo: 4, maxAttempts: 3, modelIds: ['gpt-6-luna'], providers: ['openai'] })), ctx()), null);
});
test('[R2] identidade: executor, árvore suja, pré-registro, cronograma, timeout, G-7b, campanha', () => {
  assert.equal(validateGoEconV1(goText(), ctx({ executorCodeSha: 'd'.repeat(40) })), 'GO_EXECUTOR_MISMATCH');
  assert.equal(validateGoEconV1(goText(), ctx({ treeClean: false })), 'GO_EXECUTOR_TREE_DIRTY');
  assert.equal(validateGoEconV1(goText(), ctx({ treeClean: null })), 'GO_EXECUTOR_TREE_DIRTY');
  assert.equal(validateGoEconV1(goText(), ctx({ preregistrationSha256: '8'.repeat(64) })), 'GO_PREREG_MISMATCH');
  assert.equal(validateGoEconV1(goText(), ctx({ preregistrationSha256: undefined })), 'GO_PREREG_UNCONFIGURED');
  assert.equal(validateGoEconV1(goText(), ctx({ cronogramaSha256: 'e'.repeat(64) })), 'GO_CRONOGRAMA_MISMATCH');
  assert.equal(validateGoEconV1(goText({ timeoutMs: 120_000 }), ctx()), 'GO_TIMEOUT_MISMATCH');
  assert.equal(validateGoEconV1(goText(), ctx({ g7bEstado: 'LIMITA' })), 'GO_G7B_MISMATCH');
  assert.equal(validateGoEconV1(goText(), ctx({ campaign: 'outra' })), 'GO_CAMPAIGN_MISMATCH');
});
test('[R2] assinatura, digest, paradas, placeholder e schema', () => {
  assert.equal(validateGoEconV1(goText({ signedBy: 'agente' }), ctx()), 'GO_UNSIGNED');
  assert.equal(validateGoEconV1(goText({ signatureStatement: 'curto' }), ctx()), 'GO_UNSIGNED');
  assert.equal(validateGoEconV1(goText({}, { tamper: (g) => { (g['scope'] as { maxAttempts: number }).maxAttempts = 9; } }), ctx()), 'GO_DIGEST_MISMATCH');
  assert.equal(validateGoEconV1(goText({ stops: GO_ECON_REQUIRED_STOPS.filter((s) => s !== 'STOP_ECON_ORDER') }), ctx()), 'GO_STOPS_INCOMPLETE');
  assert.equal(validateGoEconV1(goText({ signatureStatement: 'assinado por <nome do autor> em data' }), ctx()), 'GO_PLACEHOLDER_LEFT');
  assert.equal(validateGoEconV1(goText({ schema: 'h2eval.go.multi.v1' }), ctx()), 'GO_SCHEMA');
  assert.equal(validateGoEconV1(goText({ pauseAck80pct: { openai: { acknowledgedBy: 'agente', atUtc: 'x' } } }), ctx()), 'GO_PAUSE_ACK_INVALID');
});
test('[R2] os validadores existentes não mudam: GO ECON recusado por validateGoV1 e validateGoMultiV1 (GO_SCHEMA)', () => {
  const t = goText();
  assert.equal(validateGoV1(t, { provider: 'openai', phase: 'COMPARATIVE_PAIRED', modelRequested: 'gpt-6-luna', batchId: 'econ-b0000', executorVersion: 'x', executorCodeSha: 'c'.repeat(40), preregistrationSha256: PREREG, campaign: 'econ-teste', nowMs: NOW, ledgerCaps: { campaignUsd: '132', providerUsd: '11' } }), 'GO_SCHEMA');
  assert.equal(validateGoMultiV1(t, { campaign: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), treeClean: true, planProtocolHash: 'a'.repeat(64), planBatchIds: ['econ-b0000'], plannedOpsInScope: () => 10, ledgerCaps: { campaignUsd: '132', providersUsd: { anthropic: '95', openai: '11', google: '28' } }, nowMs: NOW, campaignIdentitySha256: null, campaignDirCanonical: null }), 'GO_SCHEMA');
});
test('[R2] por tentativa: seq fora da faixa, modelo/provedor fora do escopo e maxAttempts esgotado', () => {
  const go = JSON.parse(goText({ scope: { providers: ['openai'], modelIds: ['gpt-6-luna'], seqFrom: 2, seqTo: 6, maxAttempts: 3 } })) as GoEconV1;
  assert.equal(goEconCoversAttempt(go, { seq: 2, provider: 'openai', model: 'gpt-6-luna', attemptsSentInScope: 0 }), null);
  assert.equal(goEconCoversAttempt(go, { seq: 1, provider: 'openai', model: 'gpt-6-luna', attemptsSentInScope: 0 }), 'GO_SEQ_NOT_IN_SCOPE');
  assert.equal(goEconCoversAttempt(go, { seq: 7, provider: 'openai', model: 'gpt-6-luna', attemptsSentInScope: 0 }), 'GO_SEQ_NOT_IN_SCOPE');
  assert.equal(goEconCoversAttempt(go, { seq: 3, provider: 'google', model: 'gemini-3.1-flash-lite', attemptsSentInScope: 0 }), 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE');
  assert.equal(goEconCoversAttempt(go, { seq: 4, provider: 'openai', model: 'gpt-6-luna', attemptsSentInScope: 3 }), 'GO_MAX_ATTEMPTS_REACHED');
  // provedor no escopo, modelo não (mutante G15 do delta 2)
  const go2 = JSON.parse(goText({ scope: { providers: ['openai', 'anthropic'], modelIds: ['gpt-6-luna', 'claude-haiku-5-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 } })) as GoEconV1;
  assert.equal(goEconCoversAttempt(go2, { seq: 3, provider: 'anthropic', model: 'claude-opus-5-5', attemptsSentInScope: 0 }), 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE');
  assert.equal(goEconCoversAttempt(go2, { seq: 3, provider: 'anthropic', model: 'claude-haiku-5-5', attemptsSentInScope: 0 }), null);
});

// ------------------------------------------------------------------ ponta a ponta (OFFLINE) com o GO no consumidor
function envGo(goOver: Over, nowMs: () => number = () => NOW, extra: { mode?: 'REAL' } = {}) {
  const a = ambiente({ blocks: 2 });
  const f = path.join(a.dir, 'GO_ECON.json');
  writeFileSync(f, goText({ cronogramaSha256: a.cfg.cronogramaSha256, studyId: a.cfg.studyId, ...goOver }));
  a.cfg.go = { file: f, preregistrationSha256: PREREG, treeClean: true, nowMs };
  if (extra.mode) a.cfg.egress = { ...a.cfg.egress, mode: 'REAL' };
  return { a, f };
}
test('[R2] GO cobre seq 0..4: executa 5, PAUSA na 5 sem reservar; com um GO novo para 5..9 retoma na MESMA tentativa (prefixo)', async () => {
  const { a, f } = envGo({ scope: { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 4, maxAttempts: 5 } });
  const s1 = await runEcon(a.cfg);
  assert.equal(s1.executadasPrefixo, 5); assert.equal(s1.parada!.seq, 5); assert.equal(s1.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(a.sent.length, 5);
  const j = readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8');
  assert.ok(j.includes('PAUSE_REVIEW')); assert.equal(j.split('\n').filter((l) => l.includes('"RESERVED"')).length, 5);
  writeFileSync(f, goText({ cronogramaSha256: a.cfg.cronogramaSha256, studyId: a.cfg.studyId, scope: { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 5, seqTo: 9, maxAttempts: 5 } }));
  const s2 = await runEcon(a.cfg); assert.equal(s2.parada, null); assert.equal(s2.executadasPrefixo, 10); assert.equal(a.sent.length, 10);
});
test('[R2] maxAttempts menor que a faixa: pausa quando o orçamento de tentativas acaba', async () => {
  const { a } = envGo({ scope: { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 3 } });
  const s = await runEcon(a.cfg); assert.equal(a.sent.length, 3); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s.parada!.seq, 3);
});
test('[R2] GO que vence no meio da coleta: pausa na primeira tentativa depois do vencimento; nada reservado para ela', async () => {
  let t = NOW; const { a } = envGo({}, () => (t += 3 * 3600 * 1000)); // cada consulta avança 3 h; vence em 24 h
  const s = await runEcon(a.cfg);
  assert.equal(s.parada!.stop, 'PAUSE_ECON_GO'); assert.ok(a.sent.length >= 1 && a.sent.length < 10); assert.equal(s.executadasPrefixo, a.sent.length);
});
test('[R2] GO alterado durante a coleta: pausa (GO_CHANGED_DURING_RUN)', async () => {
  const { a, f } = envGo({});
  const orig = a.cfg.egress.double!; let n = 0;
  a.cfg.egress = { ...a.cfg.egress, double: async (req) => { if (++n === 2) writeFileSync(f, readFileSync(f, 'utf8') + ' '); return orig(req); } };
  const s = await runEcon(a.cfg); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s.parada!.seq, 2);
  assert.ok(readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8').includes('GO_CHANGED_DURING_RUN'));
});
test('[R2] REAL: sem GO não começa; GO inválido não começa; nada é criado', async () => {
  const a = ambiente({ blocks: 1 }); a.cfg.egress = { ...a.cfg.egress, mode: 'REAL' };
  await assert.rejects(runEcon(a.cfg), /ECON_GO_MISSING/);
  const { a: b } = envGo({}, () => Date.parse('2026-12-01T00:00:00Z'), { mode: 'REAL' });
  await assert.rejects(runEcon(b.cfg), /ECON_GO_INVALID: GO_EXPIRED/);
  for (const x of [a, b]) { assert.equal(existsSync(path.join(x.cfg.batchDir, 'ledger.jsonl')), false); assert.equal(existsSync(path.join(x.cfg.batchDir, 'journal.jsonl')), false); assert.equal(x.sent.length, 0); }
});
test('[R2] OFFLINE: GO inválido também impede o início (teto fora do perfil ECON)', async () => {
  const { a } = envGo({ caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '43.08' }, globalCampaignUsd: '149.08', pauseAtFractionOfSubLedger: 0.8 } });
  await assert.rejects(runEcon(a.cfg), /ECON_GO_INVALID: GO_CAPS_MISMATCH/); assert.equal(a.sent.length, 0);
});
