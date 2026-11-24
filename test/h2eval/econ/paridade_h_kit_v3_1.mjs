// ECON-PREP C160: conferencia de PARIDADE COM O CAMINHO H (protocolo §0 e §2.1; H-1 (i) e H-2 (i) da DR-277).
// H = corpos que os clientes BOT-02 (src/providers3p @50178f8) mandam, como o protocolo os transcreve (§2.1, linha "toWire"):
//   Anthropic {model, max_tokens, messages, system?}
//   OpenAI    {model, messages, max_completion_tokens, n:1, stream:false, store:false}
//   Google    {contents, generationConfig:{maxOutputTokens, candidateCount:1}, systemInstruction?}
// Classes: VIOLA_H = chave que muda o estimando (amostragem, raciocinio, ferramenta, cache explicito) ou teto != 8192;
//          DIFERE_DE_H = chave fora do corpo de H que nao e amostragem/raciocinio/ferramenta/cache (ex.: service_tier, stream) -> decisao a julgar;
//          IGUAL_A_H.
// v3.1 (X1 item 10): tambem confere CHAVES AUSENTES do corpo de H (OpenAI n, stream, store; Google generationConfig.candidateCount):
//          ausencia = DIFERE_DE_H com a lista `ausentes` (equivalencia por default precisa ser declarada com fonte).
// Exporta conferirCorpo(provider, body, tetoSaida). CLI: node paridade_h.mjs <provider> <body.json>
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const H = {
  anthropic: { permitidas: ['model', 'max_tokens', 'messages', 'system'], exigidas: ['model', 'max_tokens', 'messages'], teto: (b) => b.max_tokens },
  openai: { permitidas: ['model', 'messages', 'max_completion_tokens', 'n', 'stream', 'store'], exigidas: ['model', 'messages', 'max_completion_tokens', 'n', 'stream', 'store'], teto: (b) => b.max_completion_tokens },
  google: { permitidas: ['contents', 'generationConfig', 'systemInstruction'], exigidas: ['contents', 'generationConfig'], gc: ['maxOutputTokens', 'candidateCount'], teto: (b) => b.generationConfig?.maxOutputTokens },
};
const ESTIMANDO = /^(temperature|top_p|top_k|topP|topK|seed|thinking|output_config|reasoning|reasoning_effort|thinkingConfig|tools|tool_choice|toolConfig|cachedContent|prompt_cache_key|prompt_cache_retention|frequency_penalty|presence_penalty|logit_bias|response_format|responseMimeType|responseSchema)$/;
function temCacheControl(v) { if (Array.isArray(v)) return v.some(temCacheControl); if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k === 'cache_control' || temCacheControl(x)); return false; }
export function conferirCorpo(provider, body, tetoSaida = 8192) {
  const spec = H[provider]; if (!spec) throw new Error(`PROVEDOR ${provider}`);
  const viola = [], difere = [], ausentes = [];
  for (const k of spec.exigidas) if (!(k in body)) ausentes.push(k);
  if (provider === 'google') for (const k of spec.gc) if (!(body.generationConfig && k in body.generationConfig)) ausentes.push(`generationConfig.${k}`);
  for (const k of Object.keys(body)) { if (spec.permitidas.includes(k)) continue; (ESTIMANDO.test(k) ? viola : difere).push(k); }
  if (provider === 'google' && body.generationConfig) for (const k of Object.keys(body.generationConfig)) { if (spec.gc.includes(k)) continue; (ESTIMANDO.test(k) ? viola : difere).push(`generationConfig.${k}`); }
  if (temCacheControl(body)) viola.push('cache_control');
  if (spec.teto(body) !== tetoSaida) viola.push(`teto_saida=${spec.teto(body)}`);
  if (provider === 'openai') { if (body.n !== undefined && body.n !== 1) viola.push('n!=1'); if (body.store === true) difere.push('store=true'); }
  return { classe: viola.length ? 'VIOLA_H' : difere.length || ausentes.length ? 'DIFERE_DE_H' : 'IGUAL_A_H', viola, difere, ausentes };
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) { const [pv, f] = process.argv.slice(2); const r = conferirCorpo(pv, JSON.parse(fs.readFileSync(f, 'utf8'))); console.log(JSON.stringify(r)); process.exit(r.classe === 'VIOLA_H' ? 4 : 0); }
