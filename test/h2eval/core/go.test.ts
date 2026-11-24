// SYNTHETIC — pure validator of the GO file (h2eval.go.v1, R17_GO_TEMPLATE.md). No egress, no fetch, no credential: a VALID GO here
// never opens REAL mode (that also needs realFlag + env + preflight in the runner, which runner.test proves is unreachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoV1, GO_REQUIRED_STOPS, H2EVAL_ENV_NAMES, type GoContext, type GoFileV1 } from '../../../scripts/h2eval/core/egress.js';
import { EXECUTOR_VERSION } from '../../../scripts/h2eval/core/runner.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';

const NOW = Date.parse('2026-11-10T23:00:00.000Z');
const PREREG = 'ab'.repeat(32);
const ctx: GoContext = { provider: 'anthropic', phase: 'PILOT', modelRequested: 'sim-haiku', batchId: 'batch1', executorVersion: EXECUTOR_VERSION, executorCodeSha: 'c'.repeat(40), preregistrationSha256: PREREG, campaign: 'H2EVAL-TEST', nowMs: NOW, ledgerCaps: { campaignUsd: '11', providerUsd: '5' } };

export function syntheticGo(over: Partial<GoFileV1> = {}): string {
  const base: Omit<GoFileV1, 'goDigestSha256'> = {
    schema: 'h2eval.go.v1', campaign: 'H2EVAL-TEST', phase: 'PILOT', provider: 'anthropic', modelIds: ['sim-haiku'], modelDeprecationAck: null,
    batch: { batchId: 'batch1', maxCalls: 25, oneModelPerBatch: true },
    caps: { perOperation: 'costCap gravado e hasheado ANTES do envio', perBatchUsd: '0.5', perProviderSubLedgerUsd: 5, globalCampaignUsd: 11, pauseAtFractionOfSubLedger: 0.8 },
    executor: { version: EXECUTOR_VERSION, codeSha: 'c'.repeat(40), adapterVersions: { anthropic: 'test-double-v1' } },
    preregistration: { file: 'R10_PREREGISTRATION_H2EVAL_R2.md', sha256: PREREG, ratifiedUtc: '2026-11-10T22:00:00.000Z' },
    accountPreflight: { g16: 'PASS', envChecker: 'check_env_names.mjs ok:true', modelAvailabilityChecked: true, consoleLimitsChecked: { providerHardLimitUsd: '5', autoReloadOff: true, tier: 'standard', inferenceGeo: 'global' }, pricesAttestedUtc: '2026-11-10T22:30:00.000Z' },
    window: { notBeforeUtc: '2026-11-10T22:50:00.000Z', expiresUtc: '2026-11-11T02:00:00.000Z' },
    stops: [...GO_REQUIRED_STOPS], signedBy: 'human:SYNTHETIC', signatureStatement: 'Declaro que li o pre-registro de hash acima, conferi contas, limites e precos, e autorizo SOMENTE o que este arquivo diz.',
  };
  const merged = { ...base, ...over } as Omit<GoFileV1, 'goDigestSha256'> & { goDigestSha256?: string };
  const digest = merged.goDigestSha256 ?? sha256Canon({ ...merged, goDigestSha256: undefined });
  return JSON.stringify({ ...merged, goDigestSha256: digest });
}

test('GO v1 sintético e completo valida; cada regra do R17 falha com código próprio; nenhum valor do GO é ecoado', () => {
  assert.equal(validateGoV1(syntheticGo(), ctx), null);
  assert.equal(validateGoV1(syntheticGo({ caps: { perOperation: 'x', perBatchUsd: '0.5', perProviderSubLedgerUsd: 5, globalCampaignUsd: 11, pauseAtFractionOfSubLedger: 0.8 } }), { ...ctx, batchCapUsd: '0.500000000000' }), null, 'teto do lote igual (comparacao em pico-USD)');
  assert.equal(validateGoV1(syntheticGo({ pauseAck80pct: { acknowledgedBy: 'human:SYNTHETIC', atUtc: '2026-11-10T22:55:00.000Z' } }), ctx), null);
  const cases: Array<[string, string, Partial<GoFileV1> | string, Partial<GoContext>?]> = [
    ['placeholder deixado', 'GO_PLACEHOLDER_LEFT', syntheticGo().replace('"H2EVAL-TEST"', '"<ID da campanha>"')],
    ['JSON inválido', 'GO_FILE_INVALID', '{'],
    ['schema v0', 'GO_SCHEMA', { schema: 'h2eval.go.v0' as 'h2eval.go.v1' }],
    ['campanha', 'GO_CAMPAIGN_MISMATCH', { campaign: 'OTHER' }],
    ['fase', 'GO_PHASE_MISMATCH', { phase: 'CONFIRMATORY' }],
    ['provedor (um GO = um provedor)', 'GO_PROVIDER_MISMATCH', { provider: 'openai' }],
    ['modelo não listado', 'GO_MODEL_NOT_LISTED', { modelIds: ['other'] }],
    ['lote', 'GO_BATCH_MISMATCH', { batch: { batchId: 'batch9', maxCalls: 25, oneModelPerBatch: true } }],
    ['lote > 60', 'GO_BATCH_RULES', { batch: { batchId: 'batch1', maxCalls: 61, oneModelPerBatch: true } }],
    ['mais de um modelo por lote', 'GO_BATCH_RULES', { batch: { batchId: 'batch1', maxCalls: 25, oneModelPerBatch: false } }],
    ['campanha != 11', 'GO_CAPS_MISMATCH', { caps: { perOperation: 'x', perBatchUsd: '0.5', perProviderSubLedgerUsd: 5, globalCampaignUsd: 12, pauseAtFractionOfSubLedger: 0.8 } }],
    ['R15-A1: ledger mais frouxo (50) que o GO (5)', 'GO_CAPS_MISMATCH', {}, { ledgerCaps: { campaignUsd: '11', providerUsd: '50' } }],
    ['R15-A1: GO declara sub-ledger 50 (acima do padrao 5) e ledger 50', 'GO_CAPS_MISMATCH', { caps: { perOperation: 'x', perBatchUsd: '0.5', perProviderSubLedgerUsd: 50, globalCampaignUsd: 11, pauseAtFractionOfSubLedger: 0.8 } }, { ledgerCaps: { campaignUsd: '11', providerUsd: '50' } }],
    ['R15-A1: teto do lote do GO != teto efetivo', 'GO_CAPS_MISMATCH', {}, { batchCapUsd: '0.6' }],
    ['R15-M4: pauseAck80pct sem assinatura humana', 'GO_PAUSE_ACK_INVALID', { pauseAck80pct: { acknowledgedBy: 'agent:bot', atUtc: '2026-11-10T22:55:00.000Z' } }],
    ['pausa 0.8 ausente', 'GO_CAPS', { caps: { perOperation: 'x', perBatchUsd: '0.5', perProviderSubLedgerUsd: 5, globalCampaignUsd: 11, pauseAtFractionOfSubLedger: 0.9 } }],
    ['codeSha diferente (versão exata do executor)', 'GO_EXECUTOR_MISMATCH', { executor: { version: EXECUTOR_VERSION, codeSha: 'd'.repeat(40), adapterVersions: {} } }],
    ['pré-registro não configurado no executor', 'GO_PREREG_UNCONFIGURED', {}, { preregistrationSha256: undefined }],
    ['hash do pré-registro diferente', 'GO_PREREG_MISMATCH', { preregistration: { file: 'x', sha256: 'cd'.repeat(32), ratifiedUtc: '2026-11-10T22:00:00.000Z' } }],
    ['ainda não válido', 'GO_NOT_YET_VALID', { window: { notBeforeUtc: '2026-11-11T00:00:00.000Z', expiresUtc: '2026-11-11T02:00:00.000Z' } }],
    ['expirado', 'GO_EXPIRED', { window: { notBeforeUtc: '2026-11-10T20:00:00.000Z', expiresUtc: '2026-11-10T22:59:00.000Z' } }],
    ['janela > 24 h', 'GO_WINDOW_TOO_LONG', { window: { notBeforeUtc: '2026-11-10T22:50:00.000Z', expiresUtc: '2026-11-12T00:00:00.000Z' } }],
    ['stops incompletos', 'GO_STOPS_INCOMPLETE', { stops: ['STOP_FILE'] }],
    ['sem assinatura humana', 'GO_UNSIGNED', { signedBy: 'agent:bot' }],
    ['digest adulterado', 'GO_DIGEST_MISMATCH', { goDigestSha256: '0'.repeat(64) } as Partial<GoFileV1>],
  ];
  for (const [name, code, over, cx] of cases) {
    const text = typeof over === 'string' ? over : syntheticGo(over);
    const got = validateGoV1(text, { ...ctx, ...(cx ?? {}) });
    assert.equal(got, code, name);
    assert.doesNotMatch(String(got), /H2EVAL-TEST|sim-haiku|SYNTHETIC/, 'código sem valores');
  }
  // editing any field after signing breaks the digest (the signature covers the canonical JSON)
  const signed = JSON.parse(syntheticGo()) as GoFileV1; signed.batch.maxCalls = 26;
  assert.equal(validateGoV1(JSON.stringify(signed), ctx), 'GO_DIGEST_MISMATCH');
});

test('nomes de ambiente alinhados ao R16 (H2EVAL_*) e a lista de variáveis proibidas', () => {
  assert.deepEqual(H2EVAL_ENV_NAMES.credentials, { anthropic: 'H2EVAL_ANTHROPIC_API_KEY', openai: 'H2EVAL_OPENAI_API_KEY', google: 'H2EVAL_GOOGLE_API_KEY' });
  assert.deepEqual([H2EVAL_ENV_NAMES.goFile, H2EVAL_ENV_NAMES.batchDir, H2EVAL_ENV_NAMES.stopFile, H2EVAL_ENV_NAMES.budgetCampaignUsd, H2EVAL_ENV_NAMES.envFile], ['H2EVAL_GO_FILE', 'H2EVAL_BATCH_DIR', 'H2EVAL_STOP_FILE', 'H2EVAL_BUDGET_CAMPAIGN_USD', 'H2EVAL_ENV_FILE']);
  assert.deepEqual([...H2EVAL_ENV_NAMES.forbidden], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED']);
});
