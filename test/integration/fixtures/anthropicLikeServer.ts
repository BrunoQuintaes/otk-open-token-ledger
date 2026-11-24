/**
 * Local stand-in for the Anthropic Messages API used by R11/N8 tests and by the pilot
 * runner's offline rehearsal. It is NOT the provider: it only applies the request rules
 * documented at platform.claude.com (consulted 2026-09-29) that the proxy must satisfy:
 *   - authentication by `x-api-key` (an API key sent as `Authorization: Bearer` is refused);
 *   - `anthropic-version` header required;
 *   - response `model` is the dated snapshot id; `usage` carries cache categories;
 *   - streaming: message_start carries input usage, message_delta carries cumulative usage.
 * Every received request is recorded so tests can check what left the proxy.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface AnthropicLikeServer {
  url: string;
  received: ReceivedRequest[];
  /** Usage and model returned by the next responses. */
  reply: { model: string; usage: FakeUsage; text: string; omitUsage?: boolean };
  close(): Promise<void>;
}

// Provider message ids are unique; the receipt store deduplicates on them.
let seq = 0;

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

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
