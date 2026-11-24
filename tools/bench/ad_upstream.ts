/**
 * FECHAMENTO_GEMINI_AD / A — synthetic upstream for the overhead benchmark (own process, loopback only).
 * Fixed responses in three wire formats, no artificial delay, deterministic token counts:
 *   POST /v1/chat/completions                          OpenAI Chat Completions (JSON, or SSE when body.stream)
 *   POST /v1/messages                                  Anthropic Messages (JSON, or SSE when body.stream)
 *   POST /v1beta/models/<m>:generateContent            Gemini JSON
 *   POST /v1beta/models/<m>:streamGenerateContent      Gemini SSE (alt=sse, CRLF, no [DONE])
 * Prompt tokens are declared from the header x-bench-prompt-tokens; output is always 40 tokens.
 * Canary: BENCH_CANARY (env) must never appear in a received request; GET /stats reports how many did.
 *
 *   node --import tsx tools/bench/ad_upstream.ts --port <p>
 */
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] ?? 0);
const canary = process.env['BENCH_CANARY'] ?? '';
let requests = 0; let canarySeen = 0;
const OUT = 40;
const words = ['medido', 'em', 'bloco', 'sintético', 'sem', 'atraso'];

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ requests, canarySeen })); return; }
  if (req.method === 'POST' && req.url === '/reset') { requests = 0; canarySeen = 0; res.end('{}'); return; }
  let raw = '';
  req.on('data', (c) => { raw += String(c); });
  req.on('end', () => {
    requests++;
    if (canary && (raw.includes(canary) || JSON.stringify(req.headers).includes(canary) || (req.url ?? '').includes(canary))) canarySeen++;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* {} */ }
    const p = Number(req.headers['x-bench-prompt-tokens'] ?? 60);
    const url = req.url ?? '';
    res.on('error', () => {});
    if (url.startsWith('/v1/chat/completions')) {
      const base = { id: 'chatcmpl-bench', model: 'gpt-4o-mini-2024-07-18', service_tier: 'default' };
      const usage = { prompt_tokens: p, completion_tokens: OUT, total_tokens: p + OUT, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      if (body['stream'] !== true) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: words.join(' ') }, finish_reason: 'stop' }], usage })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of words.slice(0, 4)) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `${w} ` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    }
    if (url.startsWith('/v1/messages')) {
      const msg = { id: 'msg_bench', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001' };
      if (body['stream'] !== true) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: words.join(' ') }], stop_reason: 'end_turn', usage: { input_tokens: p, output_tokens: OUT, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, o: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(o)}\n\n`);
      ev('message_start', { type: 'message_start', message: { ...msg, content: [], usage: { input_tokens: p, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const w of words.slice(0, 4)) ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${w} ` } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: OUT } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    const gm = /\/v1beta\/models\/([^/:?]+):(stream)?generateContent/i.exec(url);
    if (gm) {
      const head = { modelVersion: 'gemini-2.5-flash-lite', responseId: 'gem-bench' };
      const usage = (c: number) => ({ promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: p + c, promptTokensDetails: [{ modality: 'TEXT', tokenCount: p }] });
      if (!gm[2]) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: words.join(' ') }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage(OUT), ...head })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ws = words.slice(0, 4);
      ws.forEach((w, i) => res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `${w} ` }] }, index: 0, ...(i === ws.length - 1 ? { finishReason: 'STOP' } : {}) }], usageMetadata: usage(i === ws.length - 1 ? OUT : (i + 1) * 10), ...head })}\r\n\r\n`));
      res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
server.listen(port, '127.0.0.1', () => { process.stdout.write(`listening ${(server.address() as import('node:net').AddressInfo).port}\n`); });
