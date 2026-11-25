/**
 * Tests the day summaries of the live page (`reproducao/ao_vivo/dados_dias.mjs`).
 *
 * Strategy: runs on the real published records (no fixtures), because the point is that the page shows the
 * known numbers of the two collections. Partitions: totals, per-group rows, refused calls (no check), the model
 * without OTK count, the order of the replay, and the absence of conversation text and provider identifiers.
 * Needs: only the files in reproducao/; no network, no time dependence.
 *
 * @module test/reproducao_ao_vivo/dados_dias.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFromRawUsage, summarizeBothDays, whoRefused } from '../../reproducao/ao_vivo/dados_dias.mjs';
import { REPO_ROOT } from './ajuda.mjs';

const days = summarizeBothDays(REPO_ROOT);

test('7 Oct: 662 real calls, 658 with the receipt signature verified, 0 not verified, 4 without the check', () => {
  assert.deepEqual(days.oct07.counters.total, { calls: 662, signatureYes: 658, signatureNo: 0, withoutCheck: 4 });
});

test('7 Oct: the 4 calls without the check: 3 stopped by the OTK\'s own quota (HTTP 429, quota_exceeded) and 1 refused by OpenAI (HTTP 400)', () => {
  assert.deepEqual(days.oct07.refusedHttpStatuses, { 429: 3, 400: 1 });
  assert.deepEqual(days.oct07.refusedBy, { otk: { total: 3, http: { 429: 3 } }, provedor: { total: 1, http: { 400: 1 }, providers: ['OpenAI'] } });
  const refused = days.oct07.calls.filter((c) => c.signatureVerified === null);
  assert.deepEqual(refused.map((c) => `${c.refusedBy}:${c.httpStatus}`).sort(), ['otk:429', 'otk:429', 'otk:429', 'provedor:400']);
  assert.ok(days.oct07.calls.filter((c) => c.signatureVerified !== null).every((c) => c.refusedBy === null));
});

test('who refused is read from the stored error, not from the HTTP status alone', () => {
  assert.equal(whoRefused({ httpStatus: 429, error: 'http 429: {"ok":false,"error":"quota_exceeded","quotaCU":"10000"}' }), 'otk');
  assert.equal(whoRefused({ httpStatus: 429, error: 'http 429: {"error":{"type":"rate_limit_error"}}' }), 'provedor');
  assert.equal(whoRefused({ httpStatus: 400, error: 'http 400: {"error":{"message":"invalid_json"}}' }), 'provedor');
  assert.equal(whoRefused({ httpStatus: 200, conference: { verdict: 'within_threshold' } }), null);
});

test('7 Oct: synthetic dry-run folders are left out', () => {
  assert.ok(days.oct07.sources.length > 0);
  assert.ok(days.oct07.sources.every((s) => !/synthetic/i.test(s)));
});

test('7 Oct: the per-group rows add up to the total', () => {
  const sum = days.oct07.counters.groups.reduce((s, g) => s + g.calls, 0);
  assert.equal(sum, days.oct07.counters.total.calls);
});

test('23 Nov: 1,720 sends with the record written before, 1,505 of them with the OTK count, 215 without', () => {
  const { sent, recordedBefore, withOtkCount, withoutOtkCount } = days.nov23.counters.total;
  assert.deepEqual({ sent, recordedBefore, withOtkCount, withoutOtkCount }, { sent: 1720, recordedBefore: 1720, withOtkCount: 1505, withoutOtkCount: 215 });
});

test('23 Nov: 8 models, and gpt-6-luna is the one without count (215 sends, UNSUPPORTED_FOR_ESTIMATION)', () => {
  assert.equal(days.nov23.counters.groups.length, 8);
  const luna = days.nov23.counters.groups.find((g) => g.group === 'gpt-6-luna');
  assert.deepEqual(luna, { group: 'gpt-6-luna', sent: 215, recordedBefore: 215, withOtkCount: 0, withoutOtkCount: 215, withDeclared: 214 });
  const lunaOps = days.nov23.operations.filter((o) => o.model === 'gpt-6-luna');
  assert.ok(lunaOps.every((o) => o.estimateStatus === 'UNSUPPORTED_FOR_ESTIMATION' && o.otkCount === null));
});

test('23 Nov: sends with declared usage per model equal what part C counts (tabela_estimado.json, declaradoDisponivel), Google included', () => {
  const partC = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'reproducao', 'cmp8', 'esperado', 'tabela_estimado.json'), 'utf8')).declaradoDisponivel;
  const page = Object.fromEntries(days.nov23.counters.groups.map((g) => [g.group, g.withDeclared]));
  assert.deepEqual(page, partC);
  const google = days.nov23.operations.filter((o) => o.provider === 'Google');
  assert.equal(google.length, 430);
  assert.equal(google.filter((o) => o.declaredInput !== null).length, partC['gemini-3.5-flash-lite'] + partC['gemini-3.1-flash-lite']);
});

test('declared usage rule: Google promptTokenCount, OpenAI prompt_tokens, Anthropic input plus cache; missing never becomes zero', () => {
  assert.equal(declaredFromRawUsage('google', { promptTokenCount: 120 }), 120);
  assert.equal(declaredFromRawUsage('openai', { prompt_tokens: 448 }), 448);
  assert.equal(declaredFromRawUsage('anthropic', { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }), 17);
  assert.equal(declaredFromRawUsage('google', {}), null);
  assert.equal(declaredFromRawUsage('google', null), null);
  assert.equal(declaredFromRawUsage('openai', { prompt_tokens: 'UNKNOWN' }), null);
});

test('23 Nov: every journal is linked prevHash -> hash from the first line to the last', () => {
  assert.deepEqual(days.nov23.chainLinked, { openai: true, anthropic: true, google: true, google_v1_3: true });
});

test('23 Nov: the replay follows the send time', () => {
  const times = days.nov23.operations.map((o) => o.sentUtc);
  assert.deepEqual(times, [...times].sort());
});

test('the summaries carry no conversation text, provider identifier or machine path', () => {
  const text = JSON.stringify(days);
  for (const forbidden of ['providerMessageId', 'providerRequestId', 'chatcmpl-', 'msg_', 'acknowledgedBy', 'responseText', 'prompt"', ':\\\\', 'C:/', '/home/', '/Users/']) {
    assert.ok(!text.includes(forbidden), `found "${forbidden}" in the summaries`);
  }
  const callKeys = new Set(days.oct07.calls.flatMap(Object.keys));
  assert.deepEqual([...callKeys].sort(), ['costUsd', 'declaredInput', 'declaredOutput', 'httpStatus', 'inputDifference', 'model', 'otkInput', 'otkOutput', 'provider', 'refusedBy', 'signatureVerified', 'stage', 'verdict']);
  assert.ok(!text.includes('quota_exceeded') && !text.includes('Invalid body'), 'an error text reached the summaries');
});
