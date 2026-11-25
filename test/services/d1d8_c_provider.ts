/**
 * D1–D8 / C — local controllable provider (no network, no paid call). Speaks the OpenAI Chat
 * Completions and Anthropic Messages wire formats closely enough for the proxy's parsers, with
 * deterministic control points instead of sleeps:
 *
 *   x-test-script: ok            non-stream JSON with usage {P, C}
 *                  stream        SSE: N text deltas, then waits on barrier `final` (if armed),
 *                                then the usage chunk, then waits on barrier `done` (if armed), [DONE]
 *                  cut           SSE: some deltas, then the socket is destroyed (no usage)
 *                  endless       SSE deltas until the proxy aborts the request
 *                  error500      HTTP 500 without usage
 *   x-test-tokens: "P,C"         usage reported (default 100,50)
 *
 * Gemini wire format (FECHAMENTO_GEMINI_AD) when the path ends in :generateContent / :streamGenerateContent:
 *   scripts ok | stream | cut | error401 | error403 | blocked (prompt blocked, no candidate) | maxtokens (finishReason MAX_TOKENS)
 *   x-test-gemini-cached: "<n>"  cachedContentTokenCount (implicit cache hit, inside promptTokenCount)
 *   x-test-gemini-thoughts: "<n>" thoughtsTokenCount (counted in totalTokenCount)
 *   x-test-gemini-tier: "<v>"    usageMetadata.serviceTier (absent by default)
 *   x-test-gemini-omit-candidates-count: "1"  candidatesTokenCount omitted (proto3 zero omission / derivation)
 *   streams use CRLF event separators, split one event across two writes, and have no [DONE] sentinel.
 * OpenAI bodies and chunks always name their service tier (x-test-openai-tier, default "default"), as the real
 * API does when the request sets service_tier; x-test-openai-tier: "none" omits it.
 *
 * Every request is recorded (script, body, whether the proxy aborted it before the end).
 *
 * The server listens on an OS-assigned loopback port; point the proxy's provider base URL at {@link ControllableProvider.url}.
 *
 * @module test/services/d1d8_c_provider
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One request received by the fake provider: the script it asked for, the path, the parsed JSON body, the two
 * credential headers exactly as received (so tests can check what the proxy forwarded), all headers, whether the
 * client aborted before the end, and whether the provider finished answering.
 */
export interface ProviderCall {
  script: string;
  path: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
  apiKeyHeader: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  abortedByClient: boolean;
  finished: boolean;
}

/** A one-shot gate: the provider waits on `promise` until the test calls `release()`. */
export class Barrier {
  private resolveFn: (() => void) | null = null;
  readonly promise: Promise<void>;
  constructor() { this.promise = new Promise((r) => { this.resolveFn = r; }); }
  /** Opens the gate; later calls do nothing. */
  release(): void { this.resolveFn?.(); }
}

/**
 * Local HTTP server that imitates the OpenAI, Anthropic and Gemini APIs under test control (see the file header
 * for the request headers that select each behaviour).
 */
export class ControllableProvider {
  private server: Server | null = null;
  readonly calls: ProviderCall[] = [];
  /** Barriers armed by the test; consumed in order of arrival. */
  readonly finalBarriers: Barrier[] = [];
  readonly doneBarriers: Barrier[] = [];
  /** Resolves each time a request arrives (index = arrival order). */
  private arrivals: Array<(c: ProviderCall) => void> = [];
  /** Hook called when a request arrives, before any byte is answered. */
  onArrive: ((c: ProviderCall) => Promise<void> | void) | null = null;
  port = 0;

  /**
   * Base URL of the running server (valid after {@link ControllableProvider.start}).
   *
   * @returns `http://127.0.0.1:<port>`.
   */
  get url(): string { return `http://127.0.0.1:${this.port}`; }

  /**
   * Waits for the next request to arrive after this call (earlier requests are not replayed; several waiters are
   * served in the order they called).
   *
   * @returns The call, as soon as it arrives.
   */
  nextArrival(): Promise<ProviderCall> {
    return new Promise((r) => this.arrivals.push(r));
  }

  /** Starts listening on a free loopback port and sets `port`. */
  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Releases every armed barrier, closes all open connections and stops the server. */
  async stop(): Promise<void> {
    for (const b of [...this.finalBarriers, ...this.doneBarriers]) b.release();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const c of req) raw += String(c);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    const script = String(req.headers['x-test-script'] ?? 'ok');
    const [p, c] = String(req.headers['x-test-tokens'] ?? '100,50').split(',').map(Number) as [number, number];
    const call: ProviderCall = { script, path: req.url ?? '', body, authorization: req.headers['authorization'] as string | undefined, apiKeyHeader: req.headers['x-api-key'] as string | undefined, headers: { ...req.headers }, abortedByClient: false, finished: false };
    this.calls.push(call);
    res.on('close', () => { if (!res.writableFinished) call.abortedByClient = true; });
    this.arrivals.shift()?.(call);
    if (this.onArrive) await this.onArrive(call);
    const anthropic = (req.url ?? '').includes('/v1/messages');
    if (/:(stream)?[gG]enerateContent(\?|$)/.test(req.url ?? '')) { await this.gemini(req, res, call, script, p, c); return; }
    const model = String(req.headers['x-test-model'] ?? body['model'] ?? 'gpt-4o');
    // x-test-cache: "<write>,<read>" adds the cache fields the real Anthropic usage carries (absent by default)
    const cacheHdr = req.headers['x-test-cache'];
    const cache = cacheHdr === undefined ? {} : (([w, r]) => ({ cache_creation_input_tokens: w, cache_read_input_tokens: r }))(String(cacheHdr).split(',').map(Number) as [number, number]);
    // x-test-openai-cached: "<n>" adds the details objects the real OpenAI usage carries (absent by default)
    const oaHdr = req.headers['x-test-openai-cached'];
    const oaDetails = oaHdr === undefined ? {} : { prompt_tokens_details: { cached_tokens: Number(oaHdr), audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
    // the same header makes every OpenAI body/chunk name its service tier, as the real API does
    const tierHdr = String(req.headers['x-test-openai-tier'] ?? 'default');
    const oaTier = tierHdr === 'none' ? {} : { service_tier: tierHdr };
    res.on('error', () => {});
    if (script === 'error429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      call.finished = true;
      return;
    }
    if (script === 'bigjson') {
      // usage at the very end of a body larger than the proxy's parse bound
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-big', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(20_000) } }], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } }));
      call.finished = true;
      return;
    }

    if (script === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic failure' } }));
      call.finished = true;
      return;
    }
    if (script === 'ok') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'operator=secret', 'openai-organization': 'org-operator', 'x-ratelimit-remaining-requests': '42' });
      res.end(JSON.stringify(anthropic
        ? { id: 'msg_test', type: 'message', model, content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: p, output_tokens: c, ...cache } }
        : { id: 'chatcmpl-test', object: 'chat.completion', model, ...oaTier, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, ...oaDetails } }));
      call.finished = true;
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const delta = (t: string) => (anthropic
      ? send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })
      : send({ id: 'chatcmpl-test', model, ...oaTier, choices: [{ index: 0, delta: { content: t } }] }));
    if (anthropic) send({ type: 'message_start', message: { id: 'msg_test', model, usage: { input_tokens: p, output_tokens: 1, ...cache } } });
    if (script === 'endless') {
      for (let i = 0; !call.abortedByClient && i < 100_000; i++) {
        delta(`w${i} `);
        await new Promise((r) => setTimeout(r, 20));
      }
      return;
    }
    if (script === 'bigstream') {
      // several MB so an unread client fills its buffers (backpressure)
      const big = 'y'.repeat(64 * 1024);
      for (let i = 0; i < 128 && !call.abortedByClient; i++) { if (!res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', model, choices: [{ index: 0, delta: { content: big } }] })}\n\n`)) await new Promise((r) => res.once('drain', r)); }
    }
    for (let i = 0; i < 3; i++) delta(`part${i} `);
    if (script === 'cut') {
      await new Promise((r) => setTimeout(r, 10));
      res.socket?.destroy();
      return;
    }
    const fb = this.finalBarriers.shift();
    if (fb) await fb.promise;
    if (anthropic) {
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: c } });
    } else {
      send({ id: 'chatcmpl-test', model, ...oaTier, choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, ...oaDetails } });
    }
    const db = this.doneBarriers.shift();
    if (db) await db.promise;
    if (anthropic) send({ type: 'message_stop' }); else res.write('data: [DONE]\n\n');
    res.end();
    call.finished = true;
  }

  /**
   * Gemini generateContent / streamGenerateContent (alt=sse) wire format.
   *
   * @param req - Incoming request (its URL selects stream or not; `x-test-gemini-*` headers shape the usage).
   * @param res - Response to write.
   * @param call - Record of this call; `finished` is set when the answer ends normally.
   * @param script - Behaviour requested by the test.
   * @param p - Prompt token count to report.
   * @param c - Candidate (output) token count to report.
   */
  private async gemini(req: IncomingMessage, res: ServerResponse, call: ProviderCall, script: string, p: number, c: number): Promise<void> {
    const h = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n] as string) : undefined);
    const model = h('x-test-model') ?? (req.url ?? '').match(/models\/([^/:?]+)/)?.[1] ?? 'gemini-2.5-flash-lite';
    const cached = h('x-test-gemini-cached'); const thoughts = h('x-test-gemini-thoughts'); const tier = h('x-test-gemini-tier');
    const omitC = h('x-test-gemini-omit-candidates-count') === '1';
    const t = thoughts === undefined ? 0 : Number(thoughts);
    const usage = (cand: number) => ({
      promptTokenCount: p,
      ...(omitC && cand === c ? {} : { candidatesTokenCount: cand }),
      totalTokenCount: p + cand + t,
      ...(cached === undefined ? {} : { cachedContentTokenCount: Number(cached) }),
      ...(thoughts === undefined ? {} : { thoughtsTokenCount: t }),
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: p }],
      ...(tier === undefined ? {} : { serviceTier: tier }),
    });
    const head = { modelVersion: model, responseId: 'gem-resp-test' };
    res.on('error', () => {});
    if (script === 'error401' || script === 'error403') {
      const code = script === 'error401' ? 401 : 403;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code, message: 'synthetic auth failure', status: code === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED' } }));
      call.finished = true;
      return;
    }
    const stream = (req.url ?? '').includes(':streamGenerateContent');
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      if (script === 'blocked') res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: p, totalTokenCount: p }, ...head }));
      else res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'olá ✓' }] }, finishReason: script === 'maxtokens' ? 'MAX_TOKENS' : 'STOP', index: 0 }], usageMetadata: usage(c), ...head }));
      call.finished = true;
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // CRLF separators; each event split in two writes (and a multi-byte character may be split between them)
    const send = (o: unknown) => { const raw = Buffer.from(`data: ${JSON.stringify(o)}\r\n\r\n`, 'utf8'); const cut = Math.floor(raw.length / 2); res.write(raw.subarray(0, cut)); res.write(raw.subarray(cut)); };
    if (script === 'blocked') { send({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: p, totalTokenCount: p }, ...head }); res.end(); call.finished = true; return; }
    // intermediate chunks carry the prompt count and the running candidate count (cumulative, never deltas)
    send({ candidates: [{ content: { role: 'model', parts: [{ text: 'olá ✓✓✓✓ ' }] }, index: 0 }], usageMetadata: usage(1), ...head });
    send({ candidates: [{ content: { role: 'model', parts: [{ text: 'mundo ✓ ' }] }, index: 0 }], usageMetadata: usage(Math.max(1, c - 1)), ...head });
    if (script === 'cut') { await new Promise((r) => setTimeout(r, 10)); res.socket?.destroy(); return; }
    const fb = this.finalBarriers.shift();
    if (fb) await fb.promise;
    send({ candidates: [{ content: { role: 'model', parts: [{ text: 'fim' }] }, finishReason: script === 'maxtokens' ? 'MAX_TOKENS' : 'STOP', index: 0 }], usageMetadata: usage(c), ...head });
    res.end();
    call.finished = true;
  }
}
