// SYNTHETIC — OFFLINE. VNEXT-1 (C151 item 1): the provider's stop/finish reason is parsed, normalised and PERSISTED (journal RESPONSE_RECEIVED,
// record, dataset export); completion is derived from the provider's reason only (never inferred from counts); visible, reasoning and total
// output are always separate fields. Three providers: anthropic stop_reason, openai finish_reason, gemini finishReason. Free text never passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, completionOf } from '../../../scripts/h2eval/modal/index.js';
import { parseAnthropicMessagesResponse } from '../../../scripts/h2eval/modal/adapters/anthropic_messages.js';
import { parseOpenAiChatResponse } from '../../../scripts/h2eval/modal/adapters/openai_chat.js';
import { parseGoogleGenerateContentResponse } from '../../../scripts/h2eval/modal/adapters/google_generate_content.js';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { exportDataset } from '../../../scripts/h2eval/cli/status.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, OFFICIAL_HOST, MODEL } from '../support/double.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: Record<string, unknown> }>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const T = { requestModalities: [] as never[] };

test('anthropic: stop_reason max_tokens com todo o output em thinking => truncated, completion TRUNCATED_MAX_TOKENS, visivel 0 / raciocinio 256 / total 256 separados; end_turn => COMPLETE; refusal => REFUSED; tool_use => OTHER; ausente => UNKNOWN; texto livre => UNKNOWN', () => {
  const base = fx('anthropic_messages')['ok_text_haiku55_thinking']!;
  const trunc = clone(base.body); trunc['stop_reason'] = 'max_tokens'; (trunc['usage'] as Record<string, unknown>)['output_tokens'] = 256; ((trunc['usage'] as Record<string, Record<string, unknown>>)['output_tokens_details'] ??= {})['thinking_tokens'] = 256;
  const p = parseAnthropicMessagesResponse(200, trunc, T);
  assert.deepEqual([p.stopReason, p.truncated, p.flags.includes('stop_reason_max_tokens')], ['max_tokens', true, true]);
  const h2 = ADAPTERS['anthropic.messages'].parseUsage(trunc);
  assert.deepEqual([h2.stopReason, h2.completion, h2.outputVisible, h2.reasoning, h2.outputTotal], ['max_tokens', 'TRUNCATED_MAX_TOKENS', 0, 256, 256]);
  assert.deepEqual([parseAnthropicMessagesResponse(200, base.body, T).stopReason, ADAPTERS['anthropic.messages'].parseUsage(base.body).completion], ['end_turn', 'COMPLETE']);
  const ref = fx('anthropic_messages')['refusal_stop_reason_with_usage']!; assert.deepEqual([ADAPTERS['anthropic.messages'].parseUsage(ref.body).stopReason, ADAPTERS['anthropic.messages'].parseUsage(ref.body).completion], ['refusal', 'REFUSED']);
  const tool = fx('anthropic_messages')['tool_use_unexpected']!; assert.equal(ADAPTERS['anthropic.messages'].parseUsage(tool.body).completion, 'OTHER');
  const none = clone(base.body); delete none['stop_reason']; assert.deepEqual([parseAnthropicMessagesResponse(200, none, T).stopReason, parseAnthropicMessagesResponse(200, none, T).truncated, ADAPTERS['anthropic.messages'].parseUsage(none).completion], ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  const text = clone(base.body); text['stop_reason'] = 'see https://example.test/?k=sk-SYNTHETIC not an identifier'; assert.equal(parseAnthropicMessagesResponse(200, text, T).stopReason, 'UNKNOWN', 'texto livre nunca passa');
  const err = fx('anthropic_messages')['error_429_no_usage']!; assert.deepEqual([parseAnthropicMessagesResponse(err.httpStatus, err.body, T).stopReason, parseAnthropicMessagesResponse(err.httpStatus, err.body, T).truncated], ['UNKNOWN', 'UNKNOWN']);
});

test('openai: finish_reason length => TRUNCATED_MAX_TOKENS; stop => COMPLETE; content_filter => REFUSED; gemini: MAX_TOKENS => TRUNCATED; STOP => COMPLETE; SAFETY => REFUSED', () => {
  const oa = fx('openai_chat')['ok_text']!; const choice = () => ((clone(oa.body)['choices'] as Array<Record<string, unknown>>));
  const mk = (fr: string) => { const b = clone(oa.body); (b['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason'] = fr; return b; };
  void choice;
  assert.deepEqual([parseOpenAiChatResponse(200, mk('length'), T).truncated, ADAPTERS['openai.chat_completions'].parseUsage(mk('length')).completion], [true, 'TRUNCATED_MAX_TOKENS']);
  assert.deepEqual([ADAPTERS['openai.chat_completions'].parseUsage(mk('stop')).stopReason, ADAPTERS['openai.chat_completions'].parseUsage(mk('stop')).completion], ['stop', 'COMPLETE']);
  assert.equal(ADAPTERS['openai.chat_completions'].parseUsage(mk('content_filter')).completion, 'REFUSED');
  const gg = fx('google_generate_content')['ok_text']!;
  const gk = (fr: string) => { const b = clone(gg.body); (b['candidates'] as Array<Record<string, unknown>>)[0]!['finishReason'] = fr; return b; };
  assert.deepEqual([parseGoogleGenerateContentResponse(200, gk('MAX_TOKENS'), T).truncated, ADAPTERS['gemini.generate_content'].parseUsage(gk('MAX_TOKENS')).completion], [true, 'TRUNCATED_MAX_TOKENS']);
  assert.deepEqual([ADAPTERS['gemini.generate_content'].parseUsage(gk('STOP')).stopReason, ADAPTERS['gemini.generate_content'].parseUsage(gk('STOP')).completion], ['STOP', 'COMPLETE']);
  assert.equal(ADAPTERS['gemini.generate_content'].parseUsage(gk('SAFETY')).completion, 'REFUSED');
  assert.equal(completionOf({ stopReason: 'UNKNOWN', truncated: 'UNKNOWN', outcome: 'OK' }), 'UNKNOWN');
  assert.equal(completionOf({ stopReason: 'weird_reason', truncated: false, outcome: 'OK' }), 'OTHER');
});

test('executor: stopReason e completion gravados no journal RESPONSE_RECEIVED, no record e no export; USAGE_PARSED separa visivel/raciocinio/total; taxa de conclusao derivavel sem inferencia', async () => {
  const dir = tmp('stopreason'); const store = memoryContentStore({ p1: 'Texto sintético.', p2: 'Outro texto sintético.' });
  const bodies = [
    { httpStatus: 200, body: { id: 'msg_sim', type: 'message', model: MODEL, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 300, output_tokens: 64, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' } } },
    { httpStatus: 200, body: { id: 'msg_sim', type: 'message', model: MODEL, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' } } },
  ];
  let i = 0;
  const cfg: ExecutorConfig = { batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async () => bodies[i++]!, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } }, capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40) };
  const ex = createExecutor(cfg);
  const p1 = plan({ promptSha256: store.sha['p1']!, promptId: 'P1' }); const p2 = plan({ promptSha256: store.sha['p2']!, promptId: 'P2' });
  assert.equal((await ex.run(p1)).state, 'COST_COMPUTED'); assert.equal((await ex.run(p2)).state, 'COST_COMPUTED'); ex.close();
  const lines = verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
  const resp = (id: string) => lines.find((l) => l.operationId === id && l.kind === 'RESPONSE_RECEIVED')!.body as Record<string, unknown>;
  const usage = (id: string) => lines.find((l) => l.operationId === id && l.kind === 'USAGE_PARSED')!.body as Record<string, unknown>;
  assert.deepEqual([resp(operationIdOf(p1))['stopReason'], resp(operationIdOf(p1))['completion']], ['max_tokens', 'TRUNCATED_MAX_TOKENS']);
  assert.deepEqual([resp(operationIdOf(p2))['stopReason'], resp(operationIdOf(p2))['completion']], ['end_turn', 'COMPLETE']);
  assert.ok('outputVisible' in usage(operationIdOf(p1)) && 'reasoning' in usage(operationIdOf(p1)) && 'outputTotal' in usage(operationIdOf(p1)), 'tres campos de saida sempre presentes');
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p1)}.json`), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([rec['stopReason'], rec['completion'], rec['outcome']], ['max_tokens', 'TRUNCATED_MAX_TOKENS', 'OK']);
  const ds = exportDataset(dir); const rows = readFileSync(ds.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { declared: { completion: string; stopReason: string; outputTotal: unknown } });
  const completions = rows.map((r) => r.declared.completion).sort();
  assert.deepEqual(completions, ['COMPLETE', 'TRUNCATED_MAX_TOKENS']);
  // completion rate derivable mechanically: completed / total, truncated counts as NOT completed (R3.2 §5.7 item 5), no inference from counts
  const rate = rows.filter((r) => r.declared.completion === 'COMPLETE').length / rows.length; assert.equal(rate, 0.5);
});
