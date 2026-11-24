/**
 * EXEC-ECON C160: fixture OFFLINE do estudo econômico (corpus mínimo, cronograma com os 5 modelos misturados por bloco, tabela do Sonnet 5
 * de TESTE, transporte falso por modelo). Nenhuma rede, nenhuma credencial, US$ 0. Os preços do Sonnet 5 aqui são SINTÉTICOS (3/15) e a
 * atestação é FIXTURE: não é atestação do autor (G-2 segue aberto).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Canon, sha256Hex } from '../../../scripts/h2eval/core/canon.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';
import { loadEconPriceTable, ECON_TIMEOUT_MS, type CronLine, type EconConfig, type G7b } from '../../../scripts/h2eval/econ/econ.js';

export const tmp = (p: string): string => mkdtempSync(path.join(tmpdir(), `econ-${p}-`));
export const SISTEMA = ('Você é um assistente de organização pessoal. Responda só com JSON válido, sem texto fora do objeto. Classifique a mensagem do usuário.' + ' ').repeat(5).trim();
export const USER = ['Anotar a frase: a ordem simplifica o dia.', 'Não esquecer de assinar o cliente amanhã cedo.'];
export const MODELOS: Array<[string, CronLine['provider'], string]> = [['gpt-6-luna', 'openai', 'C1'], ['gemini-3.1-flash-lite', 'google', 'C3'], ['claude-haiku-5-5', 'anthropic', 'C2'], ['claude-opus-5-5', 'anthropic', 'B'], ['claude-sonnet-5', 'anthropic', 'B']];

export function writeCorpus(dir: string): { corpusDir: string; prompts: string[] } {
  const corpusDir = path.join(dir, 'CORPUS'); mkdirSync(path.join(corpusDir, 'sistema'), { recursive: true });
  const sisSha = sha256Hex(Buffer.from(SISTEMA, 'utf8')); writeFileSync(path.join(corpusDir, 'sistema', `${sisSha}.txt`), SISTEMA);
  const prompts: string[] = []; const lines: string[] = [];
  USER.forEach((u, i) => {
    const messages = [{ role: 'system', parts: [{ type: 'text', text: SISTEMA }] }, { role: 'user', parts: [{ type: 'text', text: u }] }];
    const promptSha256 = sha256Canon(messages); prompts.push(promptSha256);
    lines.push(JSON.stringify({ itemId: `item${i}aaaaaaaaaa`.slice(0, 16), family: 'classificar', templateId: `tpl-${i}`, systemSha256: sisSha, userText: u, promptSha256, prefixMessages: 1 }));
  });
  writeFileSync(path.join(corpusDir, 'itens.jsonl'), lines.join('\n') + '\n');
  return { corpusDir, prompts };
}

/** blocos de 5 tentativas (os 5 modelos misturados na ordem dada); `only` restringe a um modelo (cronograma de 1 linha). */
export function writeCronograma(dir: string, prompts: string[], o: { blocks?: number; only?: string; extra?: (l: CronLine) => CronLine } = {}): { file: string; sha: string; lines: CronLine[] } {
  const lines: CronLine[] = []; const blocks = o.blocks ?? 2; let seq = 0;
  for (let b = 0; b < blocks; b++) for (const [model, provider, arm] of MODELOS) {
    if (o.only && o.only !== model) continue;
    const base: CronLine = { seq, block: b, posNoBloco: seq % 5, opId: sha256Hex(`op:${b}:${model}:${seq}`), itemId: `item${b % 2}aaaaaaaaaa`.slice(0, 16), family: 'classificar', templateId: `tpl-${b % 2}`, arm, rep: 1, model, provider, promptSha256: prompts[b % prompts.length]!, systemSha256: 'x', maxOutputTokens: 8192, samplingParams: 'NOT_SENT', reasoningParams: 'NOT_SENT', cacheDirectives: 'NONE', tools: 'NONE', maxRetries: 0 };
    lines.push(o.extra ? o.extra(base) : base); seq++;
  }
  const file = path.join(dir, 'CRONOGRAMA.jsonl'); const txt = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; writeFileSync(file, txt);
  return { file, sha: sha256Hex(Buffer.from(txt, 'utf8')), lines };
}

export function writeSonnet5Fixture(dir: string, over: Record<string, unknown> = {}): string {
  const t = { schema: 'otk.h2eval.price_table.v1', version: 'TESTE-sonnet5-fixture', currency: 'USD', unit: 'micro-USD per 1M', capturedUtc: '2026-11-17T00:00:00Z', source: { note: 'FIXTURE DE TESTE: NAO e atestacao do autor (G-2 aberto)' },
    models: { 'claude-sonnet-5': { provider: 'anthropic', api: 'anthropic.messages', availability: 'FIXTURE', standardTerms: {}, notes: [], attestation: { attestedBy: 'human:FIXTURE', decisionRecords: ['DR-0'], literals: [{ file: 'FIXTURE', sha256: 'f'.repeat(64) }], tier: 'STANDARD' },
      tiers: [{ id: 'standard', appliesWhen: 'FIXTURE', prices: { input: '3000000', cacheRead: null, cacheWrite5m: null, cacheWrite1h: null, cacheWrite: null, output: '15000000', reasoning: '15000000', imageTokens: null, audioTokens: null }, citation: 'FIXTURE' }] } }, ...over };
  const p = path.join(dir, 'sonnet5_fixture.json'); writeFileSync(p, JSON.stringify(t)); return p;
}

// ---------------------------------------------------------------- respostas no formato real de cada provedor (corpo documentado; números sintéticos)
export type Caso = 'texto' | 'recusa' | 'filtro' | 'limite' | 'ausente' | 'zero' | 'nulo';
export function respostaDe(provider: CronLine['provider'], model: string, caso: Caso, texto = '{"route":"captura"}'): { httpStatus: number; body: unknown } {
  if (provider === 'anthropic') {
    const usage = (o: Record<string, unknown> = {}) => ({ input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 40, output_tokens_details: { thinking_tokens: 12 }, service_tier: 'standard', inference_geo: 'global', ...o });
    const msg = (content: unknown[], stop: unknown, u: unknown) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, ...(u === undefined ? {} : { usage: u }) });
    switch (caso) {
      case 'texto': return { httpStatus: 200, body: msg([{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: texto }], 'end_turn', usage()) };
      case 'recusa': return { httpStatus: 200, body: msg([{ type: 'text', text: '' }], 'refusal', usage({ output_tokens: 3, output_tokens_details: { thinking_tokens: 0 } })) };
      case 'filtro': return { httpStatus: 200, body: msg([{ type: 'refusal', refusal: 'x' }], 'refusal', usage({ output_tokens: 3, output_tokens_details: { thinking_tokens: 0 } })) };
      case 'limite': return { httpStatus: 200, body: msg([{ type: 'text', text: texto.slice(0, 5) }], 'max_tokens', usage({ output_tokens: 8192, output_tokens_details: { thinking_tokens: 8000 } })) };
      case 'ausente': return { httpStatus: 200, body: msg([{ type: 'text', text: texto }], 'end_turn', undefined) };
      case 'zero': return { httpStatus: 200, body: msg([], 'end_turn', usage({ output_tokens: 0, output_tokens_details: { thinking_tokens: 0 } })) };
      case 'nulo': return { httpStatus: 200, body: msg([{ type: 'text', text: texto }], null, usage({ input_tokens: null })) };
    }
  }
  if (provider === 'openai') {
    const usage = (o: Record<string, unknown> = {}) => ({ prompt_tokens: 80, completion_tokens: 50, total_tokens: 130, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 30, audio_tokens: 0 }, ...o });
    const cc = (msg: Record<string, unknown>, fr: unknown, u: unknown) => ({ id: 'chatcmpl-fixture', object: 'chat.completion', model, service_tier: 'default', choices: [{ index: 0, finish_reason: fr, message: { role: 'assistant', ...msg } }], ...(u === undefined ? {} : { usage: u }) });
    switch (caso) {
      case 'texto': return { httpStatus: 200, body: cc({ content: texto, refusal: null }, 'stop', usage()) };
      case 'recusa': return { httpStatus: 200, body: cc({ content: null, refusal: 'Não posso ajudar.' }, 'stop', usage({ completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 } })) };
      case 'filtro': return { httpStatus: 200, body: cc({ content: null, refusal: null }, 'content_filter', usage({ completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 } })) };
      case 'limite': return { httpStatus: 200, body: cc({ content: texto.slice(0, 5), refusal: null }, 'length', usage({ completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8000, audio_tokens: 0 } })) };
      case 'ausente': return { httpStatus: 200, body: cc({ content: texto, refusal: null }, 'stop', undefined) };
      case 'zero': return { httpStatus: 200, body: cc({ content: '', refusal: null }, 'stop', usage({ completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 } })) };
      case 'nulo': return { httpStatus: 200, body: cc({ content: texto, refusal: null }, null, usage({ prompt_tokens: null })) };
    }
  }
  const um = (o: Record<string, unknown> = {}) => ({ promptTokenCount: 85, candidatesTokenCount: 20, thoughtsTokenCount: 15, totalTokenCount: 120, cachedContentTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 85 }], ...o });
  const gc = (parts: unknown[], fr: unknown, u: unknown, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { parts, role: 'model' }, finishReason: fr, index: 0 }], ...(u === undefined ? {} : { usageMetadata: u }), modelVersion: model, responseId: 'fixture', ...extra });
  switch (caso) {
    case 'texto': return { httpStatus: 200, body: gc([{ text: 'pensando', thought: true }, { text: texto }], 'STOP', um()) };
    case 'recusa': return { httpStatus: 200, body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: um({ candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 85 }), modelVersion: model } };
    case 'filtro': return { httpStatus: 200, body: gc([], 'SAFETY', um({ candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 85 })) };
    case 'limite': return { httpStatus: 200, body: gc([{ text: texto.slice(0, 5) }], 'MAX_TOKENS', um({ candidatesTokenCount: 8192, thoughtsTokenCount: 100, totalTokenCount: 8377 })) };
    case 'ausente': return { httpStatus: 200, body: gc([{ text: texto }], 'STOP', undefined) };
    case 'zero': return { httpStatus: 200, body: gc([], 'STOP', um({ candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 85 })) };
    case 'nulo': return { httpStatus: 200, body: gc([{ text: texto }], null, um({ promptTokenCount: null })) };
  }
}

export interface Ambiente { dir: string; cfg: EconConfig; sent: BuiltRequest[]; cron: CronLine[] }
/** `answer(req, n)` responde por pedido (n = índice do envio); default: 'texto' do provedor do modelo pedido. */
export function ambiente(o: { blocks?: number; only?: string; answer?: (req: BuiltRequest, n: number) => Promise<{ httpStatus: number; body: unknown }> | { httpStatus: number; body: unknown }; g7b?: G7b; sonnet5?: boolean; extraCfg?: Partial<EconConfig>; cronExtra?: (l: CronLine) => CronLine } = {}): Ambiente {
  const dir = tmp('amb'); const { corpusDir, prompts } = writeCorpus(dir); const c = writeCronograma(dir, prompts, { blocks: o.blocks, only: o.only, extra: o.cronExtra });
  const batchDir = path.join(dir, 'batch'); mkdirSync(batchDir, { recursive: true });
  const sent: BuiltRequest[] = [];
  const provOf = (req: BuiltRequest): CronLine['provider'] => (req.url.includes('anthropic') ? 'anthropic' : req.url.includes('openai') ? 'openai' : 'google');
  const modelOf = (req: BuiltRequest): string => { const b = req.body as { model?: string }; return b.model ?? /models\/([^:]+):/.exec(req.url)![1]!; };
  const double = async (req: BuiltRequest) => { sent.push(req); const n = sent.length - 1; return o.answer ? o.answer(req, n) : respostaDe(provOf(req), modelOf(req), 'texto'); };
  let t = Date.parse('2026-11-20T00:00:00.000Z'); const clock = () => new Date((t += 1000)).toISOString();
  const cfg: EconConfig = {
    batchDir, cronogramaPath: c.file, cronogramaSha256: c.sha, corpusDir, studyId: 'econ-teste', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), executorCodeSha: 'c'.repeat(40),
    timeoutMs: ECON_TIMEOUT_MS, g7b: o.g7b ?? { estado: 'ABERTO' }, prices: loadEconPriceTable(o.sonnet5 === false ? {} : { sonnet5TablePath: writeSonnet5Fixture(dir) }),
    egress: { mode: 'OFFLINE', campaign: 'econ-teste', double }, clock, ...o.extraCfg,
  };
  return { dir, cfg, sent, cron: c.lines };
}
