/**
 * EXEC-ECON C160: executor do estudo econômico E1/E2 v3 (delta ÚNICO sobre o E3G5 4750b77e; especificação
 * runs/C160/ECON_PREP/V3_1/EXECUTORES/ANALISE_EXECUTORES_ECON_V3_1.md, itens 1–12). Assinatura: agente EXEC-ECON C160.
 *
 * O que este módulo faz (o runner do E3G5 continua sendo o único lugar que reserva, envia e liquida):
 *   item 1  corpo H_PARITY + thinking 'omit': nada de raciocínio, amostragem, ferramenta ou cache é enviado (adapters em modal/index.ts);
 *   item 2  claude-sonnet-5 no adaptador (só H_PARITY), no catálogo do estudo (ECON_MODELS) e no preço: a tabela do Sonnet 5 só entra ATESTADA (G-2);
 *           sem ela o consumidor nem começa (ECON_PRICE_MISSING), nunca um preço inventado;
 *   item 3  resposta persistida por conteúdo antes do SETTLED (runner.persistResponse) e o TEXTO no arquivo de dados do estudo TENTATIVAS.jsonl;
 *   item 4  consumidor do CRONOGRAMA.jsonl como está (5 modelos misturados por bloco, ordem seq, opId = operationId, 8192), ledger único 95/11/28/132;
 *   item 5  teto Anthropic sem sobretaxa de escrita de cache (record/cost.ts noCacheWrite, só H_PARITY + cacheDirectives NONE);
 *   item 6  linha por tentativa no formato da porta (rubrica_econ.mjs portaOperacional);
 *   item 7  sem retry/fallback, concorrência 1, TLS intacto (egress congelado), egress só para os 3 hosts oficiais;
 *   item 8  timeout por tentativa ÚNICO (600 000 ms) para os 5 modelos; timeout = INCERTO, custo no highUsd, nunca reenviado;
 *   item 9  reserva Google parametrizada pelo G-7b (sem o dado: 2 × 8192, HIPÓTESE dependente do G-7b, não limite);
 *   item 10 n:1, stream:false, store:false (OpenAI) e generationConfig.candidateCount:1 (Google) EXPLÍCITOS no corpo (decisão D2 da master);
 *   item 11 guarda de ordem e prefixo: antes de cada envio, todo seq menor está executado e terminal; seq estritamente crescente no journal;
 *   item 12 recusa e filtro (refusal, content_filter, SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII) = outcome REFUSED_WITH_USAGE (parsers, mantidos).
 * Sem rede aqui: o modo REAL só existe pelo egress congelado (GO, credencial, TLS), que este módulo não altera.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { sha256Canon, sha256Hex } from '../core/canon.js';
import { createH2EvalExecutor, priceTableFromModal, loadE3GPriceTable, type H2EvalExecutor } from '../index.js';
import { loadPriceTable as loadModalPriceTable, type PriceTableH2 } from '../modal/pricing/pricing.js';
import { OFFICIAL_HOSTS } from '../modal/index.js';
import { CAPS_PROFILE_ECON_DR277, usdToPico, type LedgerOpening } from '../core/ledger.js';
import type { EgressConfig, GoContext as GoContext_ } from '../core/egress.js';
import type { PauseAck, UncertainAck } from '../core/runner.js';
import type { PriceTable, PriceCategory } from '../record/prices.js';
import { validateGoEconV1, goEconCoversAttempt, type GoEconContext, type GoEconV1 } from './goEcon.js';
import type { ContentStore, JournalLine, OperationPlan, PostcallRecord, Provider, ResolvedContent, RunnerResult, StopReason } from '../types.js';

export const ECON_EXECUTOR_VERSION = 'otk.h2eval.econ.v1';
export const ECON_MAX_OUTPUT_TOKENS = 8192;
/** item 8: proposta pré-registrada (v3.1) e usada no G-6: 600 000 ms, igual nos 5 modelos. */
export const ECON_TIMEOUT_MS = 600_000;
/** delta 4 (R-D1 do G15 17df0538): margem mínima até o notAfter do GO para começar uma tentativa: 15 min (>= timeout 600 s + folga). */
export const ECON_GO_MARGEM_MS = 15 * 60_000;
/** folga mínima exigida da margem além do timeout por tentativa */
export const ECON_GO_FOLGA_MS = 60_000;

/** item 2: catálogo do estudo. Disponibilidade na conta: G-3 (Sonnet 5) e chamada real (todos). */
export const ECON_MODELS = Object.freeze({
  'claude-sonnet-5': { provider: 'anthropic', api: 'anthropic.messages', arm: 'B', availability: 'PENDENTE_G3', price: 'PENDENTE_G2 (tabela atestada injetada)' },
  'claude-opus-5-5': { provider: 'anthropic', api: 'anthropic.messages', arm: 'B', availability: 'OBSERVADO_REAL', price: 'price_table_h2eval_v3 (AL14)' },
  'claude-haiku-5-5': { provider: 'anthropic', api: 'anthropic.messages', arm: 'C2', availability: 'OBSERVADO_REAL', price: 'price_table_h2eval_v3 (AL14)' },
  'gpt-6-luna': { provider: 'openai', api: 'openai.chat_completions', arm: 'C1', availability: 'OBSERVADO_REAL', price: 'price_table_h2eval_e3g_attested_v1 (DR-208)' },
  'gemini-3.1-flash-lite': { provider: 'google', api: 'gemini.generate_content', arm: 'C3', availability: 'OBSERVADO_REAL', price: 'price_table_h2eval_e3g_attested_v1 (DR-168/187/194)' },
} as const);
export type EconModel = keyof typeof ECON_MODELS;
export const isEconModel = (m: string): m is EconModel => Object.prototype.hasOwnProperty.call(ECON_MODELS, m);
const TIER: Record<Provider, string> = { anthropic: 'standard_only', openai: 'default', google: 'NONE' };

export class EconError extends Error { constructor(readonly code: string, detail = '') { super(`${code}${detail ? `: ${detail}` : ''}`); this.name = 'EconError'; } }

// ------------------------------------------------------------------------------------------------------------------------------
// item 4: CRONOGRAMA (lido como está; nada é reordenado nem gerado aqui)
// ------------------------------------------------------------------------------------------------------------------------------
export interface CronLine { seq: number; block: number; posNoBloco: number; opId: string; itemId: string; family: string; templateId: string; arm: string; rep: number; model: string; provider: Provider; promptSha256: string; systemSha256: string; maxOutputTokens: number; samplingParams: string; reasoningParams: string; cacheDirectives: string; tools: string; maxRetries: number; timeoutMs?: number }
const HEX64 = /^[0-9a-f]{64}$/;

/** Lê e valida o CRONOGRAMA.jsonl: sha esperado, seq = 0..n-1 estritamente crescente, opId único, as regras do desenho em toda linha e o timeout único (item 8). */
export function readCronograma(file: string, o: { expectedSha256: string; timeoutMs: number }): CronLine[] {
  const buf = readFileSync(file); const sha = sha256Hex(buf);
  if (!HEX64.test(o.expectedSha256) || sha !== o.expectedSha256) throw new EconError('ECON_CRONOGRAMA_SHA', `${sha.slice(0, 12)} != ${String(o.expectedSha256).slice(0, 12)}`);
  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CronLine);
  return validateCronograma(lines, o.timeoutMs);
}
export function validateCronograma(lines: CronLine[], timeoutMs: number): CronLine[] {
  if (timeoutMs !== ECON_TIMEOUT_MS) throw new EconError('ECON_TIMEOUT_NOT_PREREGISTERED', `${timeoutMs} != ${ECON_TIMEOUT_MS}`);
  const ids = new Set<string>();
  lines.forEach((l, i) => {
    const at = `seq ${l.seq}`;
    if (l.seq !== i) throw new EconError('ECON_CRONOGRAMA_SEQ', `${at} na posição ${i} (seq tem de ser 0..n-1, estritamente crescente)`);
    if (!HEX64.test(l.opId) || ids.has(l.opId)) throw new EconError('ECON_CRONOGRAMA_OPID', at); ids.add(l.opId);
    if (!HEX64.test(l.promptSha256)) throw new EconError('ECON_CRONOGRAMA_PROMPT', at);
    if (!isEconModel(l.model) || ECON_MODELS[l.model].provider !== l.provider) throw new EconError('ECON_CRONOGRAMA_MODEL', `${at} ${l.model}/${l.provider}`);
    if (l.maxOutputTokens !== ECON_MAX_OUTPUT_TOKENS || l.samplingParams !== 'NOT_SENT' || l.reasoningParams !== 'NOT_SENT' || l.cacheDirectives !== 'NONE' || l.tools !== 'NONE' || l.maxRetries !== 0) throw new EconError('ECON_CRONOGRAMA_DESENHO', at);
    if (l.timeoutMs !== undefined && l.timeoutMs !== timeoutMs) throw new EconError('ECON_TIMEOUT_DESIGUAL', `${at}: ${l.timeoutMs} != ${timeoutMs}`);
    if (!Number.isInteger(l.block) || !Number.isInteger(l.rep) || l.rep < 0 || typeof l.arm !== 'string' || !/^[A-Za-z0-9]+$/.test(l.arm)) throw new EconError('ECON_CRONOGRAMA_CAMPO', at);
    if (i > 0 && l.block < lines[i - 1]!.block) throw new EconError('ECON_CRONOGRAMA_BLOCO', at);
  });
  return lines;
}

/** item 4: OperationPlan de uma linha; opId do plano = operationId; corpo H_PARITY (itens 1, 10); 8192; nada enviado de amostragem/raciocínio/cache. */
export function planOf(l: CronLine, ctx: { studyId: string; protocolHash: string; manifestSha256: string }): OperationPlan {
  const m = ECON_MODELS[l.model as EconModel];
  return {
    schema: 'h2eval.plan.v0', studyId: ctx.studyId, protocolHash: ctx.protocolHash, manifestSha256: ctx.manifestSha256,
    batchId: `econ-b${String(l.block).padStart(4, '0')}`, phase: 'COMPARATIVE_PAIRED', cellId: l.arm, groupId: l.itemId, promptId: l.itemId, rep: l.rep, variant: l.templateId, split: 'NONE',
    provider: l.provider, api: m.api, endpoint: m.api, modelRequested: l.model, task: 'analysis', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1',
    promptSha256: l.promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE',
    params: { maxTokens: l.maxOutputTokens, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: TIER[l.provider], serviceTierRequested: TIER[l.provider], cacheDirectives: 'NONE', thinking: { mode: 'omit' }, cacheTtlRequested: 'NOT_APPLICABLE', bodyProfile: 'H_PARITY' },
    opId: l.opId, econSeq: l.seq,
  } as OperationPlan;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Conteúdo: corpus do kit (itens.jsonl + sistema/<sha>.txt), com o promptSha256 recomputado (sha256 canônico das mensagens)
// ------------------------------------------------------------------------------------------------------------------------------
export function corpusContentStore(corpusDir: string): ContentStore & { charsOf(sha: string): number; systemShaOf(sha: string): string } {
  const byHash = new Map<string, ResolvedContent>(); const sysOf = new Map<string, string>();
  for (const l of readFileSync(path.join(corpusDir, 'itens.jsonl'), 'utf8').split('\n').filter((x) => x.trim())) {
    const it = JSON.parse(l) as { itemId: string; systemSha256: string; userText: string; promptSha256: string };
    const sisBuf = readFileSync(path.join(corpusDir, 'sistema', `${it.systemSha256}.txt`));
    if (sha256Hex(sisBuf) !== it.systemSha256) throw new EconError('ECON_CORPUS_SISTEMA_SHA', it.itemId);
    const messages: ResolvedContent['messages'] = [{ role: 'system', parts: [{ type: 'text', text: sisBuf.toString('utf8') }] }, { role: 'user', parts: [{ type: 'text', text: it.userText }] }];
    if (sha256Canon(messages) !== it.promptSha256) throw new EconError('ECON_CORPUS_PROMPT_SHA', it.itemId);
    byHash.set(it.promptSha256, { promptSha256: it.promptSha256, messages, prefixMessages: 'NOT_APPLICABLE' }); sysOf.set(it.promptSha256, it.systemSha256);
  }
  return {
    get: async (h) => { const c = byHash.get(h); if (!c) throw new EconError('ECON_CONTENT_NOT_FOUND', h.slice(0, 12)); return c; },
    getBytes: async () => { throw new EconError('ECON_NO_BINARY'); },
    systemShaOf: (h) => { const s = sysOf.get(h); if (!s) throw new EconError('ECON_CONTENT_NOT_FOUND', h.slice(0, 12)); return s; },
    charsOf: (h) => { const c = byHash.get(h); if (!c) throw new EconError('ECON_CONTENT_NOT_FOUND', h.slice(0, 12)); return c.messages.reduce((a, m) => a + m.parts.reduce((b, p) => b + (p.type === 'text' ? p.text.length : 0), 0), 0); },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// item 2: preços. Opus/Haiku 5.5 = v3 (AL14); luna/flash-lite = tabela atestada E3G; Sonnet 5 = SÓ uma tabela atestada injetada (G-2)
// ------------------------------------------------------------------------------------------------------------------------------
export interface EconAttestation { attestedBy: string; decisionRecords: string[]; literals: Array<{ file: string; sha256: string }>; tier: string }
/** Valida a tabela do Sonnet 5 (schema otk.h2eval.price_table.v1, só o modelo claude-sonnet-5, atestação humana com DR e literal por sha, entrada/saída/raciocínio positivos). */
export function validateSonnet5Table(buf: Buffer): { table: PriceTableH2; sha256: string } {
  const t = JSON.parse(buf.toString('utf8')) as PriceTableH2 & { models: Record<string, { attestation?: EconAttestation }> };
  if (t.schema !== 'otk.h2eval.price_table.v1' || t.currency !== 'USD') throw new EconError('ECON_SONNET5_TABLE_SCHEMA');
  const ks = Object.keys(t.models ?? {}); if (ks.length !== 1 || ks[0] !== 'claude-sonnet-5') throw new EconError('ECON_SONNET5_TABLE_MODELS', ks.join(','));
  const pm = t.models['claude-sonnet-5']!; const a = pm.attestation;
  if (pm.provider !== 'anthropic') throw new EconError('ECON_SONNET5_TABLE_PROVIDER');
  if (!a || !/^human:\S/.test(a.attestedBy ?? '') || !Array.isArray(a.decisionRecords) || !a.decisionRecords.length || !a.decisionRecords.every((d) => /^DR-\d+$/.test(d)) || !Array.isArray(a.literals) || !a.literals.length || !a.literals.every((l) => HEX64.test(l.sha256 ?? '')) || a.tier !== 'STANDARD') throw new EconError('ECON_SONNET5_NOT_ATTESTED');
  if (pm.tiers.length !== 1) throw new EconError('ECON_SONNET5_TABLE_TIERS');
  for (const k of ['input', 'output', 'reasoning'] as const) { const v = pm.tiers[0]!.prices[k]; if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) throw new EconError('ECON_SONNET5_PRICE_MISSING', k); }
  return { table: t, sha256: sha256Hex(buf) };
}
export type EconPriceTable = PriceTable & { armAttestedModels: readonly string[]; parts: Record<string, string> };
/** Tabela composta por modelo (nenhum preço é copiado nem digitado aqui). */
export function loadEconPriceTable(o: { sonnet5TablePath?: string } = {}): EconPriceTable {
  const v3 = priceTableFromModal(loadModalPriceTable()); const arm = loadE3GPriceTable();
  const s5 = o.sonnet5TablePath ? priceTableFromModal(validateSonnet5Table(readFileSync(o.sonnet5TablePath))) : null;
  const src = (model: string): PriceTable | null => (model === 'claude-opus-5-5' || model === 'claude-haiku-5-5' ? v3 : model === 'gpt-6-luna' || model === 'gemini-3.1-flash-lite' ? arm : model === 'claude-sonnet-5' ? s5 : null);
  const parts = { v3: v3.sha256, e3g: arm.sha256, sonnet5: s5 ? s5.sha256 : 'AUSENTE_G2' };
  return Object.freeze({
    id: `econ-composta(v3:${v3.id};e3g:${arm.id};sonnet5:${s5 ? s5.id : 'AUSENTE_G2'})`, sha256: sha256Canon(parts), capturedUtc: arm.capturedUtc, schema: 'otk.h2eval.price_table.econ_composta.v1', currency: 'USD',
    micro: (provider: string, model: string, cat: PriceCategory, at: string, hint?: number) => { const t = src(model); return t ? t.micro(provider, model, cat, at, hint) : null; },
    entries: Object.freeze([...v3.entries.filter((e) => e.model === 'claude-opus-5-5' || e.model === 'claude-haiku-5-5'), ...arm.entries, ...(s5 ? s5.entries : [])]),
    armAttestedModels: arm.armAttestedModels, parts,
  });
}
/** Modelos do estudo sem preço de entrada/saída: o consumidor não começa (falhar no seq 8 deixaria o estudo pela metade). */
export function econPriceGaps(prices: PriceTable, atUtc: string): string[] {
  return (Object.keys(ECON_MODELS) as EconModel[]).filter((m) => prices.micro(ECON_MODELS[m].provider, m, 'input', atUtc) === null || prices.micro(ECON_MODELS[m].provider, m, 'output', atUtc) === null);
}

/** delta 7: identidade do corpus como o kit a calcula (gera_corpus_econ.mjs): sha256(promptSha256 ordenados unidos por '\n' + '\n' + sha256(GABARITO.jsonl)); e o sha do painel.txt. */
export function corpusIdentity(corpusDir: string): { corpusSha256: string; painelSha256: string } {
  const itens = readFileSync(path.join(corpusDir, 'itens.jsonl'), 'utf8').split('\n').filter((x) => x.trim()).map((l) => (JSON.parse(l) as { promptSha256: string }).promptSha256);
  const gab = sha256Hex(readFileSync(path.join(corpusDir, 'GABARITO.jsonl')));
  return { corpusSha256: sha256Hex(Buffer.from(itens.slice().sort().join('\n') + '\n' + gab, 'utf8')), painelSha256: sha256Hex(readFileSync(path.join(corpusDir, 'painel.txt'))) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// delta 7 (OPÇÃO (c) para o autor): reserva de entrada da família `resposta` (painel) Anthropic pelo T MEDIDO no smoke + 2 %
// ------------------------------------------------------------------------------------------------------------------------------
/**
 * Medida congelada (ECON_SMOKE_RUN, CHECKPOINT l. 86-87; X1 SMOKE_FINAL §2): o pedido do painel do corpus f7832807 (sistema `resposta`
 * b8b4a6bd…, 178 651 caracteres + pergunta = 178 793 caracteres) contou T = 86 880 tokens no Haiku 5.5 (2,058 caracteres/token).
 * A reserva usa T/caracteres × (1 + 2 %) (≈ 2,018 caracteres/token), SÓ para provedor anthropic e SÓ para pedidos cujo sistema é esse
 * painel, num corpus cujo corpusSha e painel conferem. Qualquer outro texto: a razão do pior caso (1,647). A entrada real acima do limite
 * para o executor (STOP_INPUT_ABOVE_RESERVATION, com latch; custo acima do teto: STOP_CAP_VIOLATION, com latch) — nunca gasto a mais.
 */
export interface ReservaPainel { provider: 'anthropic'; corpusSha256: string; painelSha256: string; sistemaSha256: string; charsMedidos: number; tokensMedidos: number; margemPct: number; fonte: string }
export const ECON_RESERVA_PAINEL_MEDIDA: Readonly<ReservaPainel> = Object.freeze({
  provider: 'anthropic', corpusSha256: 'f7832807db2fd7c35a2fc27630c0e77b241da810f3fc982e2d5b592f6c20dd15', painelSha256: '5047ffef198772940b0ea534e05d627dca26b7c6d1bcb8f0d6d0c81ec684f3e4',
  sistemaSha256: 'b8b4a6bd9942d1e08ec055343c3e50ed5059ad8ac2d6b3adab31ebbec558100f', charsMedidos: 178793, tokensMedidos: 86880, margemPct: 2,
  fonte: 'ECON_SMOKE_RUN seq 5 (G-11, claude-haiku-5-5, input_tokens 86880) e X1 SMOKE_FINAL opcao (c)',
});
/** limite de entrada pela medida: ceil(caracteres × T × (100 + margem) / (caracteres medidos × 100)), aritmética inteira */
export const boundByMeasure = (chars: number, r: Pick<ReservaPainel, 'charsMedidos' | 'tokensMedidos' | 'margemPct'>): number => Math.ceil((chars * r.tokensMedidos * (100 + r.margemPct)) / (r.charsMedidos * 100));

// ------------------------------------------------------------------------------------------------------------------------------
// itens 5 e 9: política de teto por tentativa
// ------------------------------------------------------------------------------------------------------------------------------
/** item 9: estado do G-7b. ABERTO => reserva Google com 8192 de thoughts além dos 8192 de saída (2 × 8192): HIPÓTESE dependente do G-7b, não limite (D1 do X1). */
export type G7b = { estado: 'ABERTO' } | { estado: 'LIMITA'; fonte: string } | { estado: 'NAO_LIMITA'; tMaxThoughts: number; fonte: string };
export const G7B_ABERTO_THOUGHTS_TOKENS = ECON_MAX_OUTPUT_TOKENS;
export function googleThoughtsAllowance(g: G7b): { tokens: number; boundedByMaxOutput: boolean; basis: string } {
  if (g.estado === 'LIMITA') { if (!g.fonte) throw new EconError('ECON_G7B_SEM_FONTE'); return { tokens: 0, boundedByMaxOutput: true, basis: `G-7b: maxOutputTokens limita os thoughts (${g.fonte})` }; }
  if (g.estado === 'NAO_LIMITA') { if (!g.fonte || !Number.isInteger(g.tMaxThoughts) || g.tMaxThoughts <= 0) throw new EconError('ECON_G7B_TMAX_INVALIDO'); return { tokens: g.tMaxThoughts, boundedByMaxOutput: false, basis: `G-7b: thoughts fora do maxOutputTokens, T_max ${g.tMaxThoughts} (${g.fonte})` }; }
  return { tokens: G7B_ABERTO_THOUGHTS_TOKENS, boundedByMaxOutput: false, basis: 'G-7b ABERTO: 2 x 8192 (HIPOTESE, nao limite; depende do G-7b)' };
}
/** Razões caracteres/token do pior caso (CUSTO_PREVISTO_ECON.json razoesCharsPorToken.*.pior; p01 medido). Parâmetro, não constante escondida. */
export const ECON_RAZOES_PIOR: Readonly<Record<Provider, number>> = Object.freeze({ anthropic: 1.647, openai: 2.388, google: 1.593 });
export function econCapPolicy(o: { charsOf: (promptSha256: string) => number; razoes?: Record<Provider, number>; g7b: G7b; painel?: { reserva: ReservaPainel; systemShaOf: (promptSha256: string) => string } }) {
  const r = o.razoes ?? ECON_RAZOES_PIOR; const g = googleThoughtsAllowance(o.g7b);
  for (const p of ['anthropic', 'openai', 'google'] as const) if (!(r[p]! > 0)) throw new EconError('ECON_RAZAO_INVALIDA', p);
  const pn = o.painel;
  return {
    /** entrada = ceil(caracteres do pedido / razão do pior caso), a mesma regra do CUSTO_PREVISTO_ECON; delta 7: o painel Anthropic medido, pela medida + margem */
    inputUpperBoundTokens: (plan: OperationPlan) => (pn && plan.provider === pn.reserva.provider && pn.systemShaOf(plan.promptSha256) === pn.reserva.sistemaSha256 ? boundByMeasure(o.charsOf(plan.promptSha256), pn.reserva) : Math.ceil(o.charsOf(plan.promptSha256) / r[plan.provider]!)),
    /** Anthropic e OpenAI: 0 (max_tokens / max_completion_tokens limitam a saída inteira, raciocínio incluído; um custo acima do teto continua STOP_CAP_VIOLATION). Google: do G-7b. */
    reasoningAllowanceTokens: (plan: OperationPlan) => (plan.provider === 'google' ? g.tokens : 0),
    thoughtsBoundedByMaxOutput: (plan: OperationPlan) => plan.provider === 'google' && g.boundedByMaxOutput,
    googleBasis: g.basis,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// item 11: guarda de ordem e prefixo (fatos do journal)
// ------------------------------------------------------------------------------------------------------------------------------
const AFTER_SEND_TERMINAL = new Set(['SETTLED', 'UNCERTAIN_ISOLATED', 'STOP_GLOBAL']);
export interface OrderIndex { sent: Set<string>; executedTerminal: Set<string>; plannedSeqs: number[]; increasing: boolean; processed: number }
export const newOrderIndex = (): OrderIndex => ({ sent: new Set(), executedTerminal: new Set(), plannedSeqs: [], increasing: true, processed: 0 });
export function indexJournal(idx: OrderIndex, lines: readonly JournalLine[]): OrderIndex {
  for (let i = idx.processed; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind === 'PLANNED') { const s = (l.body as { econSeq?: unknown }).econSeq; if (typeof s === 'number') { if (idx.plannedSeqs.length && s <= idx.plannedSeqs[idx.plannedSeqs.length - 1]!) idx.increasing = false; idx.plannedSeqs.push(s); } }
    else if (l.kind === 'SENT') idx.sent.add(l.operationId);
    else if (AFTER_SEND_TERMINAL.has(l.kind) && idx.sent.has(l.operationId)) idx.executedTerminal.add(l.operationId);
  }
  idx.processed = lines.length; return idx;
}
/** null = pode enviar; senão o motivo. Exige: seq do journal estritamente crescente, nenhum PLANNED com seq >= s, e todo seq < s executado (SENT) e terminal. */
export function orderVerdict(idx: OrderIndex, seq: number, opIdBySeq: readonly string[]): string | null {
  if (!idx.increasing) return 'JOURNAL_SEQ_NAO_CRESCENTE';
  const last = idx.plannedSeqs[idx.plannedSeqs.length - 1];
  if (last !== undefined && last >= seq) return `PLANNED_COM_SEQ_${last}_GE_${seq}`;
  for (let t = 0; t < seq; t++) if (!idx.executedTerminal.has(opIdBySeq[t]!)) return `SEQ_${t}_NAO_EXECUTADO_OU_NAO_TERMINAL`;
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------------
// item 6: linha por tentativa (TENTATIVAS.jsonl) e texto da resposta
// ------------------------------------------------------------------------------------------------------------------------------
/** Texto visível da resposta (nunca thinking/thought). Ausente => null. */
export function outputTextOf(provider: Provider, body: unknown): string | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (provider === 'anthropic') { const c = Array.isArray(b['content']) ? (b['content'] as Array<Record<string, unknown>>).filter((x) => x['type'] === 'text' && typeof x['text'] === 'string') : []; return c.length ? c.map((x) => x['text'] as string).join('') : null; }
  if (provider === 'openai') { const ch = Array.isArray(b['choices']) ? (b['choices'] as Array<Record<string, unknown>>)[0] : undefined; const m = ch?.['message'] as Record<string, unknown> | undefined; return typeof m?.['content'] === 'string' ? (m['content'] as string) : null; }
  const cand = Array.isArray(b['candidates']) ? (b['candidates'] as Array<Record<string, unknown>>)[0] : undefined;
  const parts = Array.isArray((cand?.['content'] as Record<string, unknown> | undefined)?.['parts']) ? ((cand!['content'] as Record<string, unknown>)['parts'] as Array<Record<string, unknown>>).filter((p) => typeof p['text'] === 'string' && p['thought'] !== true) : [];
  return parts.length ? parts.map((p) => p['text'] as string).join('') : null;
}
const LIMIT_REASONS = new Set(['max_tokens', 'length', 'MAX_TOKENS']);
/**
 * delta 2 (master, X1 v3.2 R-A): `truncated` BOOLEANO sempre que a resposta permitir, a partir do `completion` do registro (que é o que os
 * records REAIS trazem): COMPLETE => false; TRUNCATED_* => true; REFUSED/OTHER com stopReason conhecido => pelo stopReason (limite => true,
 * senão false); sem informação (completion UNKNOWN e stopReason UNKNOWN) => 'UNKNOWN' (a porta v3.2 trata como FIM_DESCONHECIDO). Nunca inventado.
 */
export function truncatedOf(completion: string | undefined, stopReason: string): boolean | 'UNKNOWN' {
  if (completion === 'COMPLETE') return false;
  if (typeof completion === 'string' && completion.startsWith('TRUNCATED')) return true;
  if (stopReason === 'UNKNOWN') return 'UNKNOWN';
  return LIMIT_REASONS.has(stopReason);
}
const picoToUsdNum = (p: bigint): number => Number(p) / 1e12;
const tokens = (v: unknown): number | null => (typeof v === 'number' ? v : v === 'NOT_APPLICABLE' ? 0 : null);
export interface Tentativa {
  schema: 'otk.econ.tentativa.v1'; opId: string; seq: number; block: number; arm: string; model: string; provider: Provider;
  outcome: string; httpStatus: number | null; stopReason: string; truncated: boolean | 'UNKNOWN'; modelServed: string; outputText: string | null; responseSha256: string;
  refusal: { refused: boolean; code: string } | null; exclusion: string;
  usage: { inputUncached: number | null; cacheRead: number | null; cacheWrite: number | null; outputTotal: number | null; U: number | null; completeness: string; naComoZero: string[] } | null;
  cost: { state: string; lowUsd: number; highUsd: number; capUsd: number }; latencyMs: number | null; tsSentUtc: string; timeoutMs: number; samplingParams: 'NOT_SENT'; reasoningParams: 'NOT_SENT';
}
export function tentativaOf(l: CronLine, rec: PostcallRecord, responseBody: unknown, capPico: bigint, timeoutMs: number): Tentativa {
  const cap = picoToUsdNum(capPico);
  let cost: Tentativa['cost'];
  const lowerPico = (rec as unknown as { costLowerUsd?: unknown }).costLowerUsd;
  if (rec.cost.state === 'UPPER_BOUND' && /^\d+$/.test(String(rec.cost.usd))) { // delta 6: liquidado pelo limite superior; o inferior declarado (nunca 0 por falta de dado)
    const hi = picoToUsdNum(BigInt(rec.cost.usd as string)); const lo = typeof lowerPico === 'string' && /^\d+$/.test(lowerPico) ? picoToUsdNum(BigInt(lowerPico)) : 0;
    cost = { state: 'UPPER_BOUND', lowUsd: lo, highUsd: rec.cost.capCovered === false ? Math.max(hi, cap) : hi, capUsd: cap };
  } else if (rec.cost.state === 'CALCULATED' && /^\d+$/.test(String(rec.cost.usd))) { const c = picoToUsdNum(BigInt(rec.cost.usd as string)); cost = { state: rec.cost.capCovered === false ? 'CALCULATED_ABOVE_CAP' : 'CALCULATED', lowUsd: c, highUsd: Math.max(c, rec.cost.capCovered === false ? cap : c), capUsd: cap }; }
  else cost = { state: 'UNKNOWN', lowUsd: 0, highUsd: cap, capUsd: cap }; // incerto/desconhecido: intervalo [0, teto]; o valor nunca vira 0 (o highUsd carrega a reserva inteira)
  const u = rec.usage;
  const na: string[] = []; const t = (k: 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'outputTotal' | 'U') => { const v = u ? (u as unknown as Record<string, unknown>)[k] : null; if (v === 'NOT_APPLICABLE') na.push(k); return tokens(v); };
  const usage = u ? { inputUncached: t('inputUncached'), cacheRead: t('cacheRead'), cacheWrite: t('cacheWrite'), outputTotal: t('outputTotal'), U: t('U'), completeness: u.usageCompleteness, naComoZero: na } : null;
  const sr = rec.stopReason ?? 'UNKNOWN';
  return {
    schema: 'otk.econ.tentativa.v1', opId: l.opId, seq: l.seq, block: l.block, arm: l.arm, model: l.model, provider: l.provider,
    outcome: rec.outcome, httpStatus: typeof rec.httpStatus === 'number' ? rec.httpStatus : null, stopReason: sr, truncated: truncatedOf(rec.completion, sr),
    modelServed: u?.modelServed ?? 'UNKNOWN', outputText: responseBody === null ? null : outputTextOf(l.provider, responseBody), responseSha256: rec.responseSha256,
    refusal: rec.refusal ? { refused: rec.refusal.refused, code: rec.refusal.code } : null, exclusion: rec.exclusion,
    usage, cost, latencyMs: typeof rec.latencyMs === 'number' ? rec.latencyMs : null, tsSentUtc: rec.tsSentUtc, timeoutMs, samplingParams: 'NOT_SENT', reasoningParams: 'NOT_SENT',
  };
}
function appendFsync(file: string, line: string): void { const fd = openSync(file, 'a'); try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); } }

// ------------------------------------------------------------------------------------------------------------------------------
// Consumidor (item 4) com a guarda (item 11), o timeout único (item 8) e o egress dos 3 hosts (item 7)
// ------------------------------------------------------------------------------------------------------------------------------
export const ECON_ALLOWED_HOSTS: readonly string[] = Object.freeze([...OFFICIAL_HOSTS.anthropic, ...OFFICIAL_HOSTS.openai, ...OFFICIAL_HOSTS.google]);
export interface EconConfig {
  batchDir: string; cronogramaPath: string; cronogramaSha256: string; corpusDir: string;
  studyId: string; protocolHash: string; manifestSha256: string; executorCodeSha: string;
  timeoutMs: number; g7b: G7b; razoes?: Record<Provider, number>;
  prices: EconPriceTable; acceptedModelsServed?: Record<string, readonly string[]>;
  egress: Omit<EgressConfig, 'campaign' | 'timeoutMs' | 'allowedHosts'> & { campaign: string; allowedHosts?: readonly string[] };
  clock?: () => string; stopFile?: string; uncertainAck?: readonly UncertainAck[]; pauseAck?: readonly PauseAck[]; preAuthorizedTo100?: readonly PauseAck[]; ledgerOpening?: LedgerOpening;
  /** só testes: no máximo N chamadas a run() nesta invocação */
  maxOps?: number;
  /**
   * delta 2 (R2 do G15): GO do estudo (h2eval.go.econ.v1, econ/goEcon.ts). OBRIGATÓRIO no modo REAL (sem ele o consumidor não começa); no OFFLINE é
   * opcional e, se dado, vale igual. Validado no início, de novo antes de cada tentativa (arquivo com o mesmo sha, janela, escopo, maxAttempts).
   */
  /** delta 7 (opção (c)): reserva do painel pela medida; tem de ser IGUAL a ECON_RESERVA_PAINEL_MEDIDA e o corpus tem de conferir; registrada no GO (reservaPainelSha256). */
  reservaPainel?: ReservaPainel;
  go?: { file: string; preregistrationSha256: string; treeClean: boolean | null; nowMs?: () => number; /** delta 4 (R-D1): margem mínima até o notAfter do GO antes de reservar (padrão ECON_GO_MARGEM_MS; >= timeout + ECON_GO_FOLGA_MS) */ marginMs?: number };
}
export interface EconRunSummary { schema: 'otk.econ.run_summary.v1'; /** delta 7: sha canônico da reserva do painel em uso, ou null */ reservaPainelSha256?: string | null; executorVersion: string; tentativasPlanejadas: number; executadasPrefixo: number; parada: { seq: number; opId: string; state: string; stop: StopReason | string | null } | null; ledger: unknown; googleBasis: string; precos: Record<string, string> }

/**
 * delta 3: o validador que o egress chama no ramo h2eval.go.econ.v1 (core/egress.ts readGo). Puro sobre (texto, contexto da tentativa):
 * arquivo com o sha fixado no início, validação completa com o relógio DO EGRESS, executor e campanha, provedor e modelo no escopo; devolve o
 * pauseAck do provedor. A faixa de seq e o maxAttempts (que o contexto do egress não conhece) ficam na guarda `admit` do consumidor.
 */
export function goEconEgressValidator(o: { sha0: string; go0: GoEconV1; ctxOf: () => GoEconContext; executorCodeSha: string; campaign: string }): NonNullable<EgressConfig['goEcon']> {
  return { validate: (text: string, c: GoContext_) => {
    if (sha256Hex(text) !== o.sha0) return { code: 'GO_CHANGED_DURING_RUN', pauseAck: null };
    const code = validateGoEconV1(text, { ...o.ctxOf(), nowMs: c.nowMs }); if (code) return { code, pauseAck: null };
    if (c.executorCodeSha !== o.executorCodeSha || c.campaign !== o.campaign) return { code: 'GO_EXECUTOR_MISMATCH', pauseAck: null };
    if (!o.go0.scope.providers.includes(c.provider) || !o.go0.scope.modelIds.includes(c.modelRequested)) return { code: 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE', pauseAck: null };
    const pa = o.go0.pauseAck80pct?.[c.provider];
    return { code: null, pauseAck: pa ? { acknowledgedBy: pa.acknowledgedBy, goDigestSha256: o.go0.goDigestSha256 } : null };
  } };
}

export interface EconExecutor { ex: H2EvalExecutor; cron: CronLine[]; idx: OrderIndex; googleBasis: string; reservaPainelSha256: string | null; plan(l: CronLine): OperationPlan }
/** Monta o executor do estudo com todas as guardas (exposto para os testes da guarda de ordem chamarem run() fora de ordem). */
export async function createEconExecutor(cfg: EconConfig): Promise<EconExecutor> {
  const cron = readCronograma(cfg.cronogramaPath, { expectedSha256: cfg.cronogramaSha256, timeoutMs: cfg.timeoutMs });
  if (!HEX64.test(cfg.protocolHash) || !HEX64.test(cfg.manifestSha256)) throw new EconError('ECON_IDENTIDADE');
  const hosts = cfg.egress.allowedHosts ?? ECON_ALLOWED_HOSTS;
  if (hosts.some((h) => !ECON_ALLOWED_HOSTS.includes(h))) throw new EconError('ECON_EGRESS_HOST', hosts.join(','));
  const store = corpusContentStore(cfg.corpusDir);
  for (const l of cron) await store.get(l.promptSha256); // todo pedido existe e confere antes de qualquer reserva
  const gaps = econPriceGaps(cfg.prices, (cfg.clock ?? (() => new Date().toISOString()))());
  if (gaps.length) throw new EconError('ECON_PRICE_MISSING', gaps.join(','));
  // delta 7: a reserva do painel só vale com o parâmetro congelado e o corpus medido (corpusSha e painel conferidos aqui, antes de qualquer arquivo)
  let reservaPainelSha256: string | null = null;
  if (cfg.reservaPainel) {
    if (sha256Canon(cfg.reservaPainel) !== sha256Canon(ECON_RESERVA_PAINEL_MEDIDA)) throw new EconError('ECON_RESERVA_PAINEL_PARAM', 'parametro diferente da medida congelada');
    let id: { corpusSha256: string; painelSha256: string }; try { id = corpusIdentity(cfg.corpusDir); } catch { throw new EconError('ECON_RESERVA_PAINEL_CORPUS', 'corpus sem GABARITO/painel legiveis'); }
    if (id.corpusSha256 !== cfg.reservaPainel.corpusSha256 || id.painelSha256 !== cfg.reservaPainel.painelSha256) throw new EconError('ECON_RESERVA_PAINEL_CORPUS', 'corpus/painel nao sao os medidos');
    if (!cron.some((l) => store.systemShaOf(l.promptSha256) === cfg.reservaPainel!.sistemaSha256)) throw new EconError('ECON_RESERVA_PAINEL_CORPUS', 'nenhum pedido usa o sistema medido');
    reservaPainelSha256 = sha256Canon(cfg.reservaPainel);
  }
  const cap = econCapPolicy({ charsOf: store.charsOf, razoes: cfg.razoes, g7b: cfg.g7b, ...(cfg.reservaPainel ? { painel: { reserva: cfg.reservaPainel, systemShaOf: store.systemShaOf } } : {}) });
  const opIdBySeq = cron.map((l) => l.opId);
  // delta 2 (R2): GO ECON. REAL sem GO => não começa; GO inválido => não começa (nada é criado: nenhum ledger, nenhum journal)
  if (cfg.egress.mode === 'REAL' && !cfg.go) throw new EconError('ECON_GO_MISSING');
  let goGate: ((seq: number, provider: Provider, model: string) => string | null) | null = null; let goPauseAck: PauseAck[] = [];
  // tetos do ledger: sem GO, os de planejamento da DR-277 (OFFLINE); com GO, os do GO (delta 7b)
  let ledgerCaps: { campaignUsd: string; providersUsd: Record<Provider, string> } = { campaignUsd: CAPS_PROFILE_ECON_DR277.campaign, providersUsd: { ...CAPS_PROFILE_ECON_DR277.providers } };
  let goEgress: Partial<EgressConfig> = {};
  if (cfg.go) {
    const g = cfg.go; const nowMs = g.nowMs ?? (() => Date.now());
    const margin = g.marginMs ?? ECON_GO_MARGEM_MS;
    if (!Number.isInteger(margin) || margin < cfg.timeoutMs + ECON_GO_FOLGA_MS) throw new EconError('ECON_GO_MARGEM_INVALIDA', `margem ${margin} < timeout ${cfg.timeoutMs} + folga ${ECON_GO_FOLGA_MS}`);
    const ctxOf = (at?: number): GoEconContext => ({ campaign: cfg.egress.campaign, studyId: cfg.studyId, preregistrationSha256: g.preregistrationSha256, executorCodeSha: cfg.executorCodeSha, treeClean: g.treeClean, cronogramaSha256: cfg.cronogramaSha256, cronogramaLength: cron.length, timeoutMs: cfg.timeoutMs, g7bEstado: cfg.g7b.estado, ledgerCaps, nowMs: at ?? nowMs(), reservaPainelSha256 });
    if (!existsSync(g.file)) throw new EconError('ECON_GO_INVALID', 'GO_FILE_MISSING');
    const text0 = readFileSync(g.file, 'utf8'); const sha0 = sha256Hex(text0);
    // delta 7b: os tetos do ledger do estudo são os do GO assinado (validados contra o envelope DR-277 por validateGoEconV1)
    try { const c = (JSON.parse(text0) as { caps?: { globalCampaignUsd?: unknown; perProviderSubLedgerUsd?: Record<string, unknown> } }).caps; if (c && c.perProviderSubLedgerUsd) ledgerCaps = { campaignUsd: String(c.globalCampaignUsd), providersUsd: { anthropic: String(c.perProviderSubLedgerUsd['anthropic']), openai: String(c.perProviderSubLedgerUsd['openai']), google: String(c.perProviderSubLedgerUsd['google']) } }; } catch { /* GO ilegível: a validação abaixo recusa */ }
    const code0 = validateGoEconV1(text0, ctxOf()); if (code0) throw new EconError('ECON_GO_INVALID', code0);
    const go0 = JSON.parse(text0) as GoEconV1;
    goPauseAck = Object.entries(go0.pauseAck80pct ?? {}).map(([p, v]) => ({ provider: p as Provider, acknowledgedBy: v!.acknowledgedBy, source: 'go' as const, reference: go0.goDigestSha256 }));
    // delta 3 (DECISOES_MASTER_ECON): o egress lê o GO ECON pelo gancho `goEcon` (core/egress.ts readGo). Mesmo arquivo, mesmo relógio, mesma
    // validação do consumidor; o egress confere ainda provedor e modelo da tentativa e devolve o pauseAck do provedor (contrato dos GO existentes).
    goEgress = {
      goFile: g.file, preregistrationSha256: g.preregistrationSha256, now: nowMs,
      goEcon: goEconEgressValidator({ sha0, go0, ctxOf, executorCodeSha: cfg.executorCodeSha, campaign: cfg.egress.campaign }),
    };
    goGate = (seq, provider, model) => {
      let text: string; try { text = readFileSync(g.file, 'utf8'); } catch { return 'GO_FILE_UNREADABLE'; }
      if (sha256Hex(text) !== sha0) return 'GO_CHANGED_DURING_RUN';
      const at = nowMs(); const code = validateGoEconV1(text, ctxOf(at)); if (code) return code;
      // delta 4 (R-D1): só começa uma tentativa com margem até o fim do GO (a tentativa pode durar até o timeout); sem margem, pausa antes de reservar
      if (Date.parse(go0.window.notAfterUtc) - at < margin) return 'GO_MARGEM_INSUFICIENTE';
      const s = go0.scope; let sent = 0; for (let t = s.seqFrom; t <= s.seqTo; t++) if (idx.sent.has(opIdBySeq[t]!)) sent++;
      return goEconCoversAttempt(go0, { seq, provider, model, attemptsSentInScope: sent });
    };
  }
  const idx = newOrderIndex(); let ex: H2EvalExecutor | null = null;
  ex = createH2EvalExecutor({
    batchDir: cfg.batchDir, contentStore: store, prices: cfg.prices, ledger: { campaignUsd: ledgerCaps.campaignUsd, providersUsd: { ...ledgerCaps.providersUsd } },
    ledgerPath: path.join(cfg.batchDir, 'ledger.jsonl'), egress: { ...cfg.egress, ...goEgress, allowedHosts: hosts, timeoutMs: cfg.timeoutMs }, capPolicy: cap, executorCodeSha: cfg.executorCodeSha,
    clock: cfg.clock, stopFile: cfg.stopFile, uncertainAck: cfg.uncertainAck, pauseAck: [...(cfg.pauseAck ?? []), ...goPauseAck], preAuthorizedTo100: cfg.preAuthorizedTo100, ledgerOpening: cfg.ledgerOpening,
    acceptedModelsServed: cfg.acceptedModelsServed ?? Object.fromEntries(Object.keys(ECON_MODELS).map((m) => [m, [m]])),
    econ: { study: cfg.studyId },
    admit: (plan) => {
      const why = orderVerdict(indexJournal(idx, ex!.journal.lines()), plan.econSeq ?? -1, opIdBySeq);
      if (why) return { kind: 'STOP', stop: 'STOP_ECON_ORDER', detail: { motivo: why, econSeq: plan.econSeq ?? null } };
      const goWhy = goGate ? goGate(plan.econSeq ?? -1, plan.provider, plan.modelRequested) : null; // delta 2 (R2): o GO cobre ESTA tentativa
      return goWhy ? { kind: 'STOP', stop: 'PAUSE_ECON_GO', detail: { motivo: goWhy, econSeq: plan.econSeq ?? null } } : null;
    },
  });
  return { ex, cron, idx, googleBasis: cap.googleBasis, reservaPainelSha256, plan: (l) => planOf(l, cfg) };
}

export async function runEcon(cfg: EconConfig): Promise<EconRunSummary> {
  const { ex, cron, idx, googleBasis, reservaPainelSha256 } = await createEconExecutor(cfg);
  const tentFile = path.join(cfg.batchDir, 'TENTATIVAS.jsonl');
  const written = new Set<string>(existsSync(tentFile) ? readFileSync(tentFile, 'utf8').split('\n').filter((x) => x.trim()).map((x) => (JSON.parse(x) as { opId: string }).opId) : []);
  let parada: EconRunSummary['parada'] = null; let calls = 0;
  try {
    for (const l of cron) {
      if (cfg.maxOps !== undefined && calls >= cfg.maxOps) break;
      const res: RunnerResult = await ex.run(planOf(l, cfg)); calls++;
      indexJournal(idx, ex.journal.lines());
      if (idx.sent.has(l.opId) && !written.has(l.opId) && existsSync(path.join(cfg.batchDir, 'records', `${l.opId}.json`))) {
        const rec = JSON.parse(readFileSync(path.join(cfg.batchDir, 'records', `${l.opId}.json`), 'utf8')) as PostcallRecord;
        const rp = path.join(cfg.batchDir, 'responses', `${rec.responseSha256}.json`);
        const body = HEX64.test(rec.responseSha256) && existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null;
        const reserved = ex.journal.of(l.opId).find((x) => x.kind === 'RESERVED');
        const capPico = BigInt((reserved?.body as { usd?: string } | undefined)?.usd ?? '0');
        appendFsync(tentFile, JSON.stringify(tentativaOf(l, rec, body, capPico, cfg.timeoutMs)) + '\n'); written.add(l.opId);
      }
      if (res.stop !== null || !idx.executedTerminal.has(l.opId)) { parada = { seq: l.seq, opId: l.opId, state: res.state, stop: res.stop ?? 'NAO_EXECUTADA' }; break; }
    }
  } finally { ex.close(); }
  let prefix = 0; while (prefix < cron.length && idx.executedTerminal.has(cron[prefix]!.opId)) prefix++;
  return { schema: 'otk.econ.run_summary.v1', reservaPainelSha256, executorVersion: ECON_EXECUTOR_VERSION, tentativasPlanejadas: cron.length, executadasPrefixo: prefix, parada, ledger: ex.ledger.state(), googleBasis, precos: cfg.prices.parts };
}

/** K-CUSTO informativo: Σ costCap por provedor com esta política (não bloqueia; LIMITING decide em execução). Valores em USD. */
export function somaCostCap(cron: readonly CronLine[], charsOf: (sha: string) => number, prices: PriceTable, g7b: G7b, atUtc: string, computeCostCap: typeof import('../record/cost.js').computeCostCap, razoes?: Record<Provider, number>, painel?: { reserva: ReservaPainel; systemShaOf: (sha: string) => string }): Record<string, number | string> {
  const cp = econCapPolicy({ charsOf, razoes, g7b, ...(painel ? { painel } : {}) }); const acc: Record<string, bigint> = {}; const miss = new Set<string>();
  for (const l of cron) {
    const p = planOf(l, { studyId: 'K', protocolHash: '0'.repeat(64), manifestSha256: '0'.repeat(64) });
    const c = computeCostCap(prices, { provider: p.provider, model: p.modelRequested, api: p.api, inputUpperBoundTokens: cp.inputUpperBoundTokens(p), maxOutputTokens: ECON_MAX_OUTPUT_TOKENS, reasoningAllowanceTokens: cp.reasoningAllowanceTokens(p), atUtc, noCacheWrite: true, thoughtsBoundedByMaxOutput: cp.thoughtsBoundedByMaxOutput(p) });
    if ('error' in c) { miss.add(l.model); continue; }
    acc[p.provider] = (acc[p.provider] ?? 0n) + BigInt(c.usd); acc['total'] = (acc['total'] ?? 0n) + BigInt(c.usd);
  }
  return { ...Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(picoToUsdNum(v) * 100) / 100])), semPreco: [...miss].join(',') || 'NENHUM', teto: `${usdToPico(CAPS_PROFILE_ECON_DR277.providers.anthropic) / 10n ** 12n}/${CAPS_PROFILE_ECON_DR277.providers.openai}/${CAPS_PROFILE_ECON_DR277.providers.google}/${CAPS_PROFILE_ECON_DR277.campaign}` };
}
