/**
 * Local simulator of Anthropic POST /v1/messages/count_tokens for runner tests (front B).
 * Binds 127.0.0.1 on port 0 (or a port in B's range 58700–58799). It is NOT the provider: its
 * count is o200k_base(text) + 7, a synthetic rule. The accepted key is a fixed public test
 * string, not a credential.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { countWith, loadEncoding } from '../../src/tokenization/tokenizerIdentity.js';

export const SIMULATED_ENVELOPE = 7;

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startSimulatedAnthropic(opts: { port?: number; failEvery?: number } = {}) {
  const enc = loadEncoding('o200k_base').encoder;
  const acceptedKey = 'otk-simulator-public-test-key';
  let n = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages/count_tokens') { res.writeHead(404).end(); return; }
    if (req.headers['x-api-key'] !== acceptedKey || !req.headers['anthropic-version']) { res.writeHead(401).end('{}'); return; }
    n++;
    if (opts.failEvery && n % opts.failEvery === 0) { res.writeHead(529).end('{}'); return; }
    try {
      const parsed = JSON.parse(await body(req)) as { messages?: Array<{ content?: unknown }> };
      const text = (parsed.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `sim_${n}` });
      res.end(JSON.stringify({ input_tokens: countWith(enc, text) + SIMULATED_ENVELOPE }));
    } catch {
      res.writeHead(400).end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    acceptedKey,
    requests: () => n,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
