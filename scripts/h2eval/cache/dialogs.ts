/**
 * H2-EVAL / R13 — diálogos S2 (sem hit, controle) e S3 (tentativa de hit) do estudo de cache (R07 §3.2, CONTRACT_MIN §2).
 *
 * Cada diálogo = UM prefixo estável longo (~4 500 tokens, ÚNICO por diálogo para que o 1º pedido de cada diálogo nunca reaproveite
 * o de outro) + 3 turnos do usuário. As respostas do assistente dos turnos 1 e 2 são ROTEIRIZADAS (o histórico não depende do modelo),
 * logo o corpo de cada chamada é determinístico e pré-registrável por hash. A chamada k leva os turnos 1..k e as k-1 respostas.
 * S2: nonce único no INÍCIO de cada chamada (também nos turnos seguintes), sem marcação de cache = braço controle.
 * S3: sem nonce, prefixo idêntico entre as chamadas; Anthropic recebe `cache_control` no bloco do prefixo (a API exige);
 *     OpenAI e Gemini cacheiam automaticamente (nada a marcar). O braço FINAL é o observado no usage (classify.ts), nunca esta intenção.
 * Sem rede, sem relógio: o intervalo entre chamadas é só um PLANO (offsets em segundos) conferido contra o TTL assumido.
 */
import { assertFreshSeed } from '../corpus/seedGuard.js';
import { assignSplits, assignSplitsCounts, DIALOG_FRACTIONS, type Split, type SplitCounts } from '../corpus/split.js';
import { canonicalJson, hasLoneSurrogate, int, pick, rngFor, sha256Hex } from '../corpus/util.js';
// B2 integration (coordinator's decision on F-INT-1, ownership of this adjustment transferred to BOT-02): the ADAPTER is the single
// source of the request body; the pre-registrable reference below is DERIVED from it through bodyOf(plan, content).
import { bodyOf } from '../modal/index.js';
import { defaultThinkingFor, reasoningRecordOf, serviceTierRequestedFor } from '../modal/contract_r2.js';
import type { MatrixModel } from '../modal/types.js';

/** Corpus/H1 model aliases accepted by renderCall → exact matrix ids the adapters require. */
export const MODEL_ALIASES: Readonly<Record<string, MatrixModel>> = Object.freeze({ 'gpt-4o-mini': 'gpt-4o-mini-2024-07-18', 'gpt-4o-mini-2024-07-18': 'gpt-4o-mini-2024-07-18', 'claude-haiku-4-5': 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001', 'claude-haiku-5-5': 'claude-haiku-5-5', 'claude-sonnet-5-5': 'claude-sonnet-5-5', 'claude-opus-5-5': 'claude-opus-5-5', 'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite' });
const API_OF: Readonly<Record<Provider, 'openai.chat_completions' | 'anthropic.messages' | 'gemini.generate_content'>> = Object.freeze({ openai: 'openai.chat_completions', anthropic: 'anthropic.messages', google: 'gemini.generate_content' });

export type Provider = 'openai' | 'anthropic' | 'google';
export type Arm = 'S2_NOHIT' | 'S3_HITATTEMPT';
export type Phase = 'CONFIRMATORY' | 'PILOT';

export interface DialogTurn { user: string; /** resposta roteirizada do assistente; null no último turno (é a que o modelo produz) */ assistant: string | null }
export interface Dialog {
  dialogId: string; arm: Arm; phase: Phase; split: Split | 'NONE';
  prefix: string; prefixSha256: string; turns: DialogTurn[];
  /** só S2: um nonce por chamada (1..3), único no estudo todo */
  nonces: string[];
}

export interface DialogOptions {
  seed: number; extraForbiddenSeeds?: readonly number[];
  s2Dialogs?: number; s3Dialogs?: number; pilotS2?: number; pilotS3?: number;
  /** C154 (R5): contagens explicitas por braco e split (substitui s2Dialogs/s3Dialogs + DIALOG_FRACTIONS quando presente) */
  splitPlanDialogs?: Readonly<Partial<Record<Arm, SplitCounts>>>;
  /** meta de caracteres do prefixo (≈ 4 500 tokens; calibrada em teste com js-tiktoken) */
  prefixChars?: number;
}

export const DEFAULT_PREFIX_CHARS = 19000;

const TEAMS = ['Atlas', 'Boreal', 'Cinza', 'Delta', 'Eclipse', 'Faro', 'Granito', 'Horizonte', 'Ibis', 'Jaspe'];
const ITEMS = ['pedido', 'chamado', 'lote', 'contrato', 'relatório', 'ativo', 'incidente', 'requisição'];
const TYPES = ['rotineiro', 'urgente', 'crítico', 'recorrente', 'excepcional', 'sazonal'];

interface Rule { n: number; item: string; type: string; days: number; team: string }

function ruleText(x: Rule): string {
  return `Regra ${x.n}: para ${x.item} do tipo ${x.type}, o prazo máximo é de ${x.days} dias corridos e a responsabilidade é da equipe ${x.team}; qualquer exceção exige registro prévio no livro de ocorrências.`;
}

function makePrefix(dialogId: string, r: () => number, chars: number): { prefix: string; rules: Rule[] } {
  const code = Array.from({ length: 6 }, () => int(r, 0, 35).toString(36)).join('').toUpperCase();
  const head = `MANUAL INTERNO DE PROCEDIMENTOS (SINTÉTICO) — documento ${dialogId}-${code}\nEste manual é fictício e serve apenas como contexto estável de um diálogo de teste. Leia todas as regras antes de responder.\n\n`;
  const rules: Rule[] = []; const parts: string[] = [head]; let len = head.length; let n = 1; let section = 1;
  while (len < chars) {
    const title = `Seção ${section}: ${pick(r, ITEMS)}s ${pick(r, TYPES)}s\n`;
    parts.push(title); len += title.length;
    const k = int(r, 5, 9);
    for (let i = 0; i < k && len < chars; i++, n++) {
      const x: Rule = { n, item: pick(r, ITEMS), type: pick(r, TYPES), days: int(r, 1, 120), team: pick(r, TEAMS) };
      rules.push(x); const t = ruleText(x) + '\n'; parts.push(t); len += t.length;
    }
    parts.push('\n'); len += 1; section += 1;
  }
  return { prefix: parts.join(''), rules };
}

function makeTurns(r: () => number, rules: Rule[]): DialogTurn[] {
  const idx = [int(r, 0, rules.length - 1), int(r, 0, rules.length - 1), int(r, 0, rules.length - 1)];
  const a = rules[idx[0]!]!; const b = rules[idx[1]!]!; const c = rules[idx[2]!]!;
  return [
    { user: `Pergunta 1: qual é o prazo máximo da regra ${a.n}?`, assistant: `Conforme a regra ${a.n}, o prazo máximo é de ${a.days} dias corridos.` },
    { user: `Pergunta 2: e qual equipe responde pela regra ${b.n}?`, assistant: `A regra ${b.n} atribui a responsabilidade à equipe ${b.team}.` },
    { user: `Pergunta 3: resuma em uma frase a regra ${c.n}.`, assistant: null },
  ];
}

/** Nonce determinístico e único por (diálogo, chamada). Formato fixo de 16 hex (largura constante => diferença de tokens estável). */
export const nonceOf = (seed: number, dialogId: string, call: number): string => sha256Hex(`${seed}|nonce|${dialogId}|${call}`).slice(0, 16);

export function makeDialog(seed: number, arm: Arm, phase: Phase, index: number, split: Split | 'NONE', prefixChars: number): Dialog {
  const tag = arm === 'S2_NOHIT' ? 'S2' : 'S3';
  const dialogId = phase === 'PILOT' ? `PILOT-${tag}-d${String(index).padStart(2, '0')}` : `${tag}-d${String(index).padStart(2, '0')}`;
  const r = rngFor(seed, 'DIALOG', dialogId);
  const { prefix, rules } = makePrefix(dialogId, r, prefixChars);
  const turns = makeTurns(r, rules);
  const nonces = arm === 'S2_NOHIT' ? [1, 2, 3].map((k) => nonceOf(seed, dialogId, k)) : [];
  const d: Dialog = { dialogId, arm, phase, split, prefix, prefixSha256: sha256Hex(prefix), turns, nonces };
  if (hasLoneSurrogate(prefix) || turns.some((t) => hasLoneSurrogate(t.user) || hasLoneSurrogate(t.assistant ?? ''))) throw new Error(`surrogate isolado em ${dialogId}`);
  return d;
}

/** Todos os diálogos do estudo: confirmatórios S2/S3 (split por diálogo, alocação balanceada) e piloto segregado (split NONE). */
export function buildDialogs(o: DialogOptions): Dialog[] {
  const seed = assertFreshSeed(o.seed, o.extraForbiddenSeeds ?? []);
  const chars = o.prefixChars ?? DEFAULT_PREFIX_CHARS;
  const out: Dialog[] = [];
  const spec: Array<[Arm, number]> = [['S2_NOHIT', o.s2Dialogs ?? 15], ['S3_HITATTEMPT', o.s3Dialogs ?? 30]];
  for (const [arm, n0] of spec) {
    const planned = o.splitPlanDialogs?.[arm]; // C154: contagens explicitas (0 = braco fora)
    const n = planned ? planned.train + planned.validation + planned.holdout : n0;
    const splits = planned ? assignSplitsCounts(seed, `DIALOG|${arm}`, planned) : assignSplits(seed, `DIALOG|${arm}`, n, DIALOG_FRACTIONS);
    for (let i = 0; i < n; i++) out.push(makeDialog(seed, arm, 'CONFIRMATORY', i, splits[i]!, chars));
  }
  for (const [arm, n] of [['S2_NOHIT', o.pilotS2 ?? 2], ['S3_HITATTEMPT', o.pilotS3 ?? 3]] as Array<[Arm, number]>) for (let i = 0; i < n; i++) out.push(makeDialog(seed, arm, 'PILOT', i, 'NONE', chars));
  return out;
}

/** Controle S2 pareado a um diálogo S3: MESMO conteúdo (prefixo e turnos), só o nonce muda. Serve à auditoria da diferença de tokens. */
export function controlOf(d: Dialog, seed: number): Dialog {
  const id = `${d.dialogId}-CTRL`;
  return { ...d, dialogId: id, arm: 'S2_NOHIT', nonces: [1, 2, 3].map((k) => nonceOf(seed, id, k)) };
}

// ------------------------------------------------------------------ conteúdo neutro (contrato da integradora) e renderização por provedor

/**
 * Forma neutra que o ContentStore da integradora devolve (`ResolvedContent`, scripts/h2eval/types.ts da BOT-02): o prefixo estável é a
 * mensagem de SISTEMA (prefixMessages = 1) e os turnos vêm depois. No braço S2 a 1ª linha do sistema é o nonce da chamada.
 * promptSha256 = sha256(JSON canônico de { messages, prefixMessages }): é o que o plano de operação carrega.
 */
export interface NeutralContent {
  promptSha256: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> }>;
  prefixMessages: number;
}

const sentSystem = (d: Dialog, call: number): string => (d.arm === 'S2_NOHIT' ? `[ref ${d.nonces[call - 1]}]\n` : '') + d.prefix;

export function contentOf(d: Dialog, call: 1 | 2 | 3): NeutralContent {
  const t = (text: string) => [{ type: 'text' as const, text }];
  const messages: NeutralContent['messages'] = [{ role: 'system', parts: t(sentSystem(d, call)) }, { role: 'user', parts: t(d.turns[0]!.user) }];
  for (let k = 1; k < call; k++) { messages.push({ role: 'assistant', parts: t(d.turns[k - 1]!.assistant!) }); messages.push({ role: 'user', parts: t(d.turns[k]!.user) }); }
  return { promptSha256: sha256Hex(canonicalJson({ messages, prefixMessages: 1 })), messages, prefixMessages: 1 };
}

export interface RenderOptions {
  provider: Provider; model: string; maxOutputTokens: number;
  /** nome do parâmetro de teto de saída na OpenAI (H1 usou max_tokens para o gpt-4o-mini) */
  openaiTokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** service_tier fixado no pedido (B11-E: openai "default", anthropic "standard_only"); ausente = não enviado */
  serviceTier?: string;
  /** TTL pedido ao Anthropic (S3): '5m' = padrão (sem campo ttl) | '1h' */
  anthropicCacheTtl?: '5m' | '1h';
  googleThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  /** intervalo planejado entre chamadas, em segundos (plano, não relógio) */
  intervalSeconds?: number;
  /** contador de tokens do modelo (ou aproximação declarada) para registrar `nonceTokensDeclared` no S2; sem contador => 'UNKNOWN' (nunca 0) */
  nonceTokenCounter?: ((text: string) => number) | null;
}

/** Campos de `params` do plano de operação (CONTRACT_MIN R2 itens 3, 5 e 9). */
export interface CallParams {
  serviceTierRequested: string | 'NONE'; cacheTtlRequested: '5m' | '1h' | 'NOT_APPLICABLE';
  /** só S2: tokens que o nonce acrescenta, medidos com o contador injetado (auditoria do controle "sem hit") */
  nonceTokensDeclared: number | 'UNKNOWN' | 'NOT_APPLICABLE'; maxOutputTokens: number;
}

export interface RenderedCall {
  dialogId: string; arm: Arm; phase: Phase; split: Split | 'NONE'; callIndex: 1 | 2 | 3; provider: Provider; model: string; params: CallParams;
  body: Record<string, unknown>; bodySha256: string; promptSha256: string; prefixSha256: string; sentPrefixSha256: string; nonce: string | null;
  cacheDirective: { kind: 'cache_control' | 'automatic' | 'none'; ttl: '5m' | '1h' | null };
  expectedBehavior: string; scheduledOffsetSeconds: number;
}

/**
 * Corpo de referência por API (a "intenção pré-registrável" do braço) — DERIVADO do adaptador do provedor (`bodyOf`, MET-02), que é a
 * fonte única do corpo enviado (decisão da coordenadora sobre o achado F-INT-1). Mesmo `NeutralContent` + mesmos `params` ⇒ mesmo
 * `bodySha256` aqui, no plano de operações (R15) e na linha `SENT` do journal. `openaiTokenParam` e `googleThinkingLevel` são aceitos por
 * compatibilidade e NÃO alteram o corpo (o adaptador fixa `max_completion_tokens` e `thinkingLevel: MINIMAL`, R08/R14-FIX).
 */
export function planOfCall(d: Dialog, call: 1 | 2 | 3, o: RenderOptions): import('../types.js').OperationPlan {
  const c = contentOf(d, call); const mark = d.arm === 'S3_HITATTEMPT';
  const model = MODEL_ALIASES[o.model]; if (!model) throw new Error(`renderCall: model ${o.model} is not in the matrix`);
  const thinking = defaultThinkingFor(model); const { basis: _b, offDocumented: _o, ...thinkingParams } = thinking; void _b; void _o;
  const ttl = o.anthropicCacheTtl ?? '5m';
  const cacheDirectives = mark && o.provider === 'anthropic' ? ({ cache_control: 'ephemeral', ttl } as Record<string, string>) : 'NONE';
  const serviceTier = o.serviceTier ?? 'NONE';
  return {
    schema: 'h2eval.plan.v0', studyId: 'REFERENCE', protocolHash: '0'.repeat(64), manifestSha256: '0'.repeat(64), batchId: 'REFERENCE', phase: d.phase, cellId: `cache-${d.arm}`, groupId: d.dialogId, promptId: `${d.dialogId}#${call}`, rep: 0, variant: `call${call}`, split: d.split,
    provider: o.provider, api: API_OF[o.provider], endpoint: '', modelRequested: model, task: 'analysis', sizeBucket: 'L', structure: d.arm === 'S2_NOHIT' ? 'S2' : 'S3', modality: 'text', plannedCacheArm: d.arm,
    promptSha256: c.promptSha256, prefixSha256: d.prefixSha256, nonce: d.arm === 'S2_NOHIT' ? d.nonces[call - 1]! : 'NOT_APPLICABLE',
    params: { maxTokens: o.maxOutputTokens, temperature: 'DEFAULT', reasoning: reasoningRecordOf(thinking), serviceTier, serviceTierRequested: serviceTier === 'NONE' ? serviceTierRequestedFor(model).serviceTierRequested === 'NONE' ? 'NONE' : serviceTier : serviceTier, cacheDirectives, thinking: thinkingParams as import('../types.js').OperationPlan['params']['thinking'], cacheTtlRequested: mark && o.provider === 'anthropic' ? ttl : 'NOT_APPLICABLE' },
  };
}

export function renderCall(d: Dialog, call: 1 | 2 | 3, o: RenderOptions): RenderedCall {
  const c = contentOf(d, call); const nonce = d.arm === 'S2_NOHIT' ? d.nonces[call - 1]! : null; const mark = d.arm === 'S3_HITATTEMPT';
  const txt = (m: NeutralContent['messages'][number]): string => m.parts.map((p) => p.text).join('');
  const sys = txt(c.messages[0]!);
  const plan = planOfCall(d, call, o);
  const derived = bodyOf(plan as never, c as never);
  const body = derived.body as Record<string, unknown>;
  const ttl = o.anthropicCacheTtl ?? '5m';
  const directive: RenderedCall['cacheDirective'] = o.provider === 'anthropic' ? (mark ? { kind: 'cache_control', ttl } : { kind: 'none', ttl: null }) : { kind: mark ? 'automatic' : 'none', ttl: null };
  const expectedBehavior = d.arm === 'S2_NOHIT' ? 'NO_HIT esperado em todas as chamadas (nonce no início quebra o prefixo)'
    : call === 1 ? 'CRIACAO (Anthropic) ou NO_HIT (OpenAI/Google: automático, sem escrita reportada)' : 'HIT esperado (prefixo idêntico dentro do TTL), SEM garantia: o braço final é o observado';
  const params: CallParams = {
    serviceTierRequested: o.serviceTier ?? 'NONE', maxOutputTokens: o.maxOutputTokens,
    cacheTtlRequested: o.provider === 'anthropic' && mark ? (o.anthropicCacheTtl ?? '5m') : 'NOT_APPLICABLE',
    nonceTokensDeclared: d.arm !== 'S2_NOHIT' ? 'NOT_APPLICABLE' : o.nonceTokenCounter ? o.nonceTokenCounter(sys) - o.nonceTokenCounter(d.prefix) : 'UNKNOWN',
  };
  return { dialogId: d.dialogId, arm: d.arm, phase: d.phase, split: d.split, callIndex: call, provider: o.provider, model: o.model, params, body, bodySha256: derived.bodySha256, promptSha256: c.promptSha256,
    prefixSha256: d.prefixSha256, sentPrefixSha256: sha256Hex(sys), nonce, cacheDirective: directive, expectedBehavior, scheduledOffsetSeconds: (call - 1) * (o.intervalSeconds ?? 20) };
}

export const renderDialog = (d: Dialog, o: RenderOptions): RenderedCall[] => ([1, 2, 3] as const).map((k) => renderCall(d, k, o));

// ------------------------------------------------------------------ premissas de cache por modelo (R08 §4) e plano de intervalo

/** Mínimos de prefixo cacheável do R08. null = NOT_VERIFIED (não inventar). */
export const MIN_PREFIX_TOKENS: Readonly<Record<string, { tokens: number | null; status: 'DOCUMENTED' | 'NOT_VERIFIED' }>> = Object.freeze({
  'claude-haiku-4-5': { tokens: 4096, status: 'DOCUMENTED' },
  'claude-haiku-4-5-20251001': { tokens: 4096, status: 'DOCUMENTED' },
  'claude-haiku-5-5': { tokens: 512, status: 'DOCUMENTED' },
  'claude-sonnet-5-5': { tokens: 512, status: 'DOCUMENTED' },
  'gpt-4o-mini': { tokens: null, status: 'NOT_VERIFIED' },
  'gemini-3.5-flash-lite': { tokens: null, status: 'NOT_VERIFIED' },
});

/** TTL assumido (segundos) para conferir o intervalo; Gemini implícito não tem TTL documentado. */
export const TTL_ASSUMED: Readonly<Record<Provider, { seconds: number; status: 'DOCUMENTED' | 'NOT_VERIFIED'; note: string }>> = Object.freeze({
  anthropic: { seconds: 300, status: 'DOCUMENTED', note: 'padrão 5 min (1 h com ttl "1h"); renova a cada uso' },
  openai: { seconds: 300, status: 'DOCUMENTED', note: 'in_memory: 5 a 10 min de inatividade (usa-se o limite inferior)' },
  google: { seconds: 300, status: 'NOT_VERIFIED', note: 'cache implícito sem TTL documentado; 300 s é suposição conservadora' },
});

export interface TtlPlan { offsetsSeconds: number[]; gapsSeconds: number[]; ttlSeconds: number; ttlStatus: 'DOCUMENTED' | 'NOT_VERIFIED'; safety: number; withinTtl: boolean }

/** Confere que cada intervalo entre chamadas fica abaixo de `safety × TTL` (padrão 0,5). `gaps` pode ser dado para simular expiração. */
export function checkTtl(provider: Provider, o: { intervalSeconds?: number; gapsSeconds?: number[]; ttlSeconds?: number; safety?: number; calls?: number } = {}): TtlPlan {
  const calls = o.calls ?? 3; const gaps = o.gapsSeconds ?? Array.from({ length: calls - 1 }, () => o.intervalSeconds ?? 20);
  const offsets = [0]; for (const g of gaps) offsets.push(offsets[offsets.length - 1]! + g);
  const ttl = o.ttlSeconds ?? TTL_ASSUMED[provider].seconds; const safety = o.safety ?? 0.5;
  return { offsetsSeconds: offsets, gapsSeconds: gaps, ttlSeconds: ttl, ttlStatus: TTL_ASSUMED[provider].status, safety, withinTtl: gaps.every((g) => g <= ttl * safety) };
}

// ------------------------------------------------------------------ auditoria do nonce (S2)

export interface NonceAudit { callIndex: number; nonce: string; tokensWith: number | 'UNKNOWN'; tokensWithout: number | 'UNKNOWN'; delta: number | 'UNKNOWN' }

/**
 * Diferença de tokens causada SÓ pelo nonce: texto do pedido S2 com nonce x o mesmo texto sem a linha do nonce. O contador é injetado
 * (js-tiktoken nos testes/CLI). Sem contador => 'UNKNOWN' (nunca 0).
 */
export function auditNonceTokens(d: Dialog, counter: ((text: string) => number) | null): NonceAudit[] {
  if (d.arm !== 'S2_NOHIT') throw new Error('auditoria de nonce só vale para o braço S2');
  return [1, 2, 3].map((call) => {
    const nonce = d.nonces[call - 1]!; const withText = `[ref ${nonce}]\n${d.prefix}`;
    if (!counter) return { callIndex: call, nonce, tokensWith: 'UNKNOWN', tokensWithout: 'UNKNOWN', delta: 'UNKNOWN' } as NonceAudit;
    const a = counter(withText); const b = counter(d.prefix);
    return { callIndex: call, nonce, tokensWith: a, tokensWithout: b, delta: a - b };
  });
}
