/**
 * Local stand-in for the Anthropic Messages API used by R11/N8 tests and by the pilot
 * runner's offline rehearsal. It is NOT the provider: it only applies the request rules
 * documented at platform.claude.com (consulted 2026-09-29) that the proxy must satisfy:
 *   - authentication by `x-api-key` (an API key sent as `Authorization: Bearer` is refused);
 *   - `anthropic-version` header required;
 *   - response `model` is the dated snapshot id; `usage` carries cache categories;
 *   - streaming: message_start carries input usage, message_delta carries cumulative usage.
 * Every received request is recorded so tests can check what left the proxy.
 *
 * Imported by `test/integration/anthropic_proxy_auth_model_r11.test.ts`, `scripts/pilot/anthropic/runPilot.ts`
 * and `scripts/rehearsal/proxy_services.ts`. It listens on 127.0.0.1 only, never calls the real provider, and
 * produces no real usage: the returned token counts are whatever the caller puts in `reply`.
 *
 * @module test/integration/fixtures/anthropicLikeServer
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Usage block the stand-in returns, in tokens, with the Anthropic field names. */
export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written to the prompt cache; sent as 0 when omitted. */
  cache_creation_input_tokens?: number;
  /** Tokens read from the prompt cache; sent as 0 when omitted. */
  cache_read_input_tokens?: number;
}

/** One request exactly as the stand-in received it (recorded before any validation). */
export interface ReceivedRequest {
  method: string;
  /** Request path including the query string. */
  path: string;
  /** Copy of the request headers, lower-case names as Node.js delivers them. */
  headers: Record<string, string | string[] | undefined>;
  /** Raw request body as UTF-8 text. */
  body: string;
}

/** Handle to a running stand-in; tests mutate `reply` and read `received`. */
export interface AnthropicLikeServer {
  /** Base URL, `http://127.0.0.1:<port>`, without a trailing slash. */
  url: string;
  /** Every request received, in arrival order; callers may clear it between tests. */
  received: ReceivedRequest[];
  /** Usage and model returned by the next responses. */
  reply: { model: string; usage: FakeUsage; text: string; omitUsage?: boolean };
  /** Closes all connections and stops listening. */
  close(): Promise<void>;
}

// Provider message ids are unique; the receipt store deduplicates on them.
let seq = 0;

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/**
 * Starts the stand-in on a free 127.0.0.1 port.
 *
 * Answers only POST requests whose path starts with the Messages path: 404 otherwise, 401 when the provider key
 * header does not equal `expectedKey`, 400 without the version header or with a body that is not JSON. A body with
 * `stream: true` gets a server-sent event stream; any other body gets one JSON message. `reply.omitUsage` removes
 * the usage block from either form.
 *
 * @param expectedKey - The only provider key accepted.
 * @returns The running server handle; call `close()` when done.
 */
export async function startAnthropicLikeServer(expectedKey: string): Promise<AnthropicLikeServer> {
  const received: ReceivedRequest[] = [];
  const state: AnthropicLikeServer = {
    url: '',
    received,
    reply: {
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 25, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      text: 'ok',
    },
    close: async () => {},
  };

  const server: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      received.push({ method: req.method ?? '', path: req.url ?? '', headers: { ...req.headers }, body });
      const send = (status: number, payload: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type, 'request-id': `req_fixture_${received.length}` });
        res.end(payload);
      };
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) {
        return send(404, errorBody('not_found_error', 'Not found'));
      }
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== expectedKey) {
        return send(401, errorBody('authentication_error', 'invalid x-api-key'));
      }
      if (!req.headers['anthropic-version']) {
        return send(400, errorBody('invalid_request_error', 'anthropic-version: header is required'));
      }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {
        return send(400, errorBody('invalid_request_error', 'invalid JSON'));
      }
      const { model, usage, text, omitUsage } = state.reply;
      const id = `msg_fixture_${process.pid}_${++seq}`;
      if (parsed['stream'] === true) {
        const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        const startUsage = {
          input_tokens: usage.input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          output_tokens: 1,
        };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_fixture_${received.length}` });
        res.write(ev('message_start', { type: 'message_start', message: {
          id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null,
          ...(omitUsage ? {} : { usage: startUsage }),
        } }));
        res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        res.write(ev('ping', { type: 'ping' }));
        res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
        res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
        // message_delta usage is cumulative (documented)
        res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
          ...(omitUsage ? {} : { usage: { ...startUsage, output_tokens: usage.output_tokens } }) }));
        res.end(ev('message_stop', { type: 'message_stop' }));
        return;
      }
      send(200, JSON.stringify({
        id, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null,
        ...(omitUsage ? {} : { usage: {
          input_tokens: usage.input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          output_tokens: usage.output_tokens,
          service_tier: 'standard',
        } }),
      }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
