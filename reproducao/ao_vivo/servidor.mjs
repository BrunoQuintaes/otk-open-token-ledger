/**
 * Local HTTP server of the live reproduction page: serves the single-file page, the summaries of the two
 * collection days as JSON, the original receipt verifier page (byte for byte), the progress of every step
 * as Server-Sent Events (SSE), and one fixed action: start the optional automated test suite.
 *
 * Where it fits: `reproduzir_ao_vivo.mjs` creates it with {@link startLiveServer}, publishes one event per
 * line printed by the steps it runs, and closes it at the end.
 *
 * Safety properties (checked by `test/reproducao_ao_vivo/servidor.test.mjs`):
 * - it listens on 127.0.0.1 only, on a port chosen by the operating system, so no other machine can reach it;
 * - it answers only when the `Host` header names the loopback address it listens on, which stops a web page
 *   on another site from reading it through a DNS-rebinding trick;
 * - the test-suite action (`POST /api/testes`) also requires the request to come from 127.0.0.1 and to carry
 *   `Origin: http://127.0.0.1:<port>` or `http://localhost:<port>` (the page itself, opened either way), so
 *   another site open in the browser cannot trigger it; it takes no
 *   parameters, and the command it starts is fixed by the caller at start-up;
 * - the page is sent with a restrictive `Content-Security-Policy` (see {@link buildPageCsp}: no external script,
 *   style, font, image, frame or connection, and inline code only by hash), so the browser itself refuses to
 *   load anything from outside the machine;
 * - it serves a fixed set of paths; there is no generic file serving from disk.
 *
 * Environment variables: none.
 *
 * @module reproducao/ao_vivo/servidor
 */
import crypto from 'node:crypto';
import http from 'node:http';

/** Address the server binds to; the loopback interface only. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Path where the original verifier page is served, unchanged. */
export const VERIFIER_PAGE_PATH = '/verificador/verificador-otk.html';

/**
 * Builds the Content-Security-Policy of the live page. The inline `<script>` and `<style>` blocks are allowed by
 * their SHA-256 hash (no `'unsafe-inline'`), so any other inline code, injected or not, is refused by the
 * browser; the only connections and frames allowed are back to this same local server (`'self'`).
 *
 * @param pageHtml - The page exactly as it will be served.
 * @returns The header value.
 * @throws {Error} When the page has no `<script>` block (the hash list would be empty and the page would not run).
 * @example
 * buildPageCsp('<style>a{}</style><script>1</script>'); // "default-src 'none'; script-src 'sha256-...'; ..."
 */
export function buildPageCsp(pageHtml) {
  const blocks = { script: /<script>([^]*?)<\/script>/g, style: /<style>([^]*?)<\/style>/g };
  const hashesOf = (tag) => [...pageHtml.matchAll(blocks[tag])]
    .map((match) => `'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
  const scripts = hashesOf('script');
  if (scripts.length === 0) throw new Error('PAROU: a página não tem bloco <script>.');
  const styles = hashesOf('style');
  return [
    "default-src 'none'",
    `script-src ${scripts.join(' ')}`,
    `style-src ${styles.length ? styles.join(' ') : "'none'"}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Interval between SSE comment lines that keep idle connections open, in milliseconds. */
const SSE_KEEPALIVE_MS = 15_000;

/**
 * Tells whether a socket address is the IPv4 loopback (also in its IPv4-mapped IPv6 form).
 *
 * @param address - `req.socket.remoteAddress`.
 * @returns `true` for 127.0.0.1 and ::ffff:127.0.0.1.
 */
function isLoopbackAddress(address) {
  return address === LOOPBACK_HOST || address === `::ffff:${LOOPBACK_HOST}`;
}

/**
 * Starts the local server.
 *
 * @param options - Server content and callbacks.
 * @param options.pageHtml - The full HTML of the live page, served at `/`.
 * @param options.daysJson - The JSON text served at `/api/dias` (serialized once, at start-up).
 * @param options.verifierPageBytes - The original `web/verificador/verificador-otk.html`, served unchanged at
 *   {@link VERIFIER_PAGE_PATH}; `null` serves 404 there.
 * @param options.onClient - Called each time a page connects to the event stream.
 * @param options.onRunTests - Called for an accepted `POST /api/testes`; returns `{ started: boolean, message: string }`.
 *   When omitted, the action answers 404.
 * @returns A promise of `{ url, port, address, pageCsp, publish, close, eventCount }`:
 *   - `url` is `http://127.0.0.1:<port>/`; `address` is the bound address (always `127.0.0.1`);
 *   - `publish(type, data)` stores an event and sends it to every connected page; the event `id` grows by one
 *     each time, so a page that connects late (or reconnects) receives the whole history in order first;
 *   - `close()` ends open SSE streams and stops the server;
 *   - `eventCount()` is how many events were published so far.
 * @throws {Error} When the port cannot be opened (the promise rejects with the `listen` error).
 * @example
 * const server = await startLiveServer({ pageHtml, daysJson: JSON.stringify(days), verifierPageBytes });
 * server.publish('linha', { text: 'OK      A. ...' });
 */
export function startLiveServer({ pageHtml, daysJson, verifierPageBytes = null, onClient = () => {}, onRunTests = null }) {
  const history = [];
  const clients = new Set();
  let port = 0;
  const pageCsp = buildPageCsp(pageHtml);

  const isAllowedHost = (hostHeader) => hostHeader === `${LOOPBACK_HOST}:${port}` || hostHeader === `localhost:${port}`;
  const plain = (res, status, text, extra = {}) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }).end(text);
  const sendEvent = (res, event) => res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);

  const handleEvents = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const lastSeen = Number(req.headers['last-event-id'] ?? 0);
    for (const event of history) if (event.id > lastSeen) sendEvent(res, event);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    onClient();
  };

  const handleRunTests = (req, res) => {
    if (!onRunTests) return plain(res, 404, 'Não encontrado.\n');
    if (!isLoopbackAddress(req.socket.remoteAddress)) return plain(res, 403, 'Só aceito pedidos desta máquina.\n');
    const pageOrigins = [`http://${LOOPBACK_HOST}:${port}`, `http://localhost:${port}`];
    if (!pageOrigins.includes(req.headers.origin)) return plain(res, 403, 'Origem não permitida.\n');
    // The body is ignored on purpose: the page cannot choose what runs.
    req.resume();
    const outcome = onRunTests();
    return res.writeHead(outcome.started ? 202 : 409, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(outcome));
  };

  const server = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) return plain(res, 403, 'Endereço não permitido.\n');
    const pathname = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname;
    if (pathname === '/api/testes') {
      return req.method === 'POST' ? handleRunTests(req, res) : plain(res, 405, 'Só POST.\n', { Allow: 'POST' });
    }
    if (req.method !== 'GET') return plain(res, 405, 'Método não permitido.\n', { Allow: 'GET' });
    if (pathname === '/') {
      return res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pageCsp, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      }).end(pageHtml);
    }
    if (pathname === '/api/dias') {
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(daysJson);
    }
    if (pathname === '/eventos') return handleEvents(req, res);
    if (pathname === VERIFIER_PAGE_PATH && verifierPageBytes) {
      // Sent as stored: its own <meta> CSP still applies; the header only limits who may frame it.
      return res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'self'", 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Length': verifierPageBytes.length,
      }).end(verifierPageBytes);
    }
    // Browsers ask for a favicon on their own; 204 keeps the console free of a 404 error.
    if (pathname === '/favicon.ico') return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    return plain(res, 404, 'Não encontrado.\n');
  });

  const keepAlive = setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, SSE_KEEPALIVE_MS);
  keepAlive.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      port = server.address().port;
      resolve({
        url: `http://${LOOPBACK_HOST}:${port}/`,
        port,
        address: server.address().address,
        pageCsp,
        publish(type, data) {
          const event = { id: history.length + 1, type, data };
          history.push(event);
          for (const res of clients) sendEvent(res, event);
        },
        eventCount: () => history.length,
        close() {
          clearInterval(keepAlive);
          for (const res of clients) res.end();
          clients.clear();
          return new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); });
        },
      });
    });
  });
}
