/**
 * PROXY-02 — ProxyForwarder
 * HTTP relay to upstream LLM provider APIs using native fetch.
 *
 * `openUpstream` is the function used by the proxy (`src/proxy/ProxyGateway.ts` and, through its
 * adapter, `src/operations/proxyDurable.ts`); `forwardRequest` buffers the whole answer. Both make one
 * network call to the URL given by the caller and never log the provider key. No retries, and the
 * caller chooses the upstream URL (this module does not validate it).
 *
 * @module src/proxy/ProxyForwarder
 */

/**
 * Buffered upstream answer returned by {@link forwardRequest}.
 */
export interface ForwardResult {
  status: number;
  /** Response headers, lowercase names (as given by `fetch`). */
  headers: Record<string, string>;
  body: string;
  /** `true` when the upstream content type is `text/event-stream`. */
  isStream: boolean;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
]);

// Returns a copy of the headers without connection-level (hop-by-hop) headers; the input is not modified.
function stripHopByHop(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Client credential headers. The client authenticates to the OTK (its token may arrive in
 * any of these, e.g. an unmodified Anthropic SDK sends `x-api-key`); none of them may
 * reach the provider (R11: before, `x-api-key` was forwarded with the OTK token).
 */
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']);

/** Anthropic API version sent when the client did not name one (documented stable value). */
const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';

/**
 * Headers sent upstream: hop-by-hop and client credentials removed, provider key injected
 * the way the provider authenticates. content-length is dropped because the proxy may
 * rewrite the body (PROXY-06); fetch recomputes it (R10).
 *
 * R11: Anthropic authenticates API keys with `x-api-key` and requires `anthropic-version`;
 * a key sent as `Authorization: Bearer` is refused (401). FECHAMENTO_GEMINI_AD: the Gemini Developer
 * API authenticates API keys with `x-goog-api-key` (not Bearer, which it refuses with 401; not the
 * `?key=` query, which would put the key in URLs and logs). Other providers keep Bearer.
 *
 * @param headers - Client request headers (not modified; a cleaned copy is returned).
 * @param apiKey - Provider API key to inject; callers must never log it.
 * @param provider - Lowercase provider ID; it selects the header used to send the key.
 * @returns The headers to send upstream.
 */
export function upstreamHeaders(headers: Record<string, string>, apiKey: string, provider: string): Record<string, string> {
  const clean = stripHopByHop(headers);
  for (const k of Object.keys(clean)) {
    const lower = k.toLowerCase();
    if (lower === 'content-length' || CLIENT_CREDENTIAL_HEADERS.has(lower)) delete clean[k];
  }
  if (provider === 'anthropic') {
    clean['x-api-key'] = apiKey;
    if (!Object.keys(clean).some(k => k.toLowerCase() === 'anthropic-version')) {
      clean['anthropic-version'] = ANTHROPIC_DEFAULT_VERSION;
    }
  } else if (provider === 'gemini') {
    clean['x-goog-api-key'] = apiKey;
  } else {
    clean['authorization'] = `Bearer ${apiKey}`;
  }
  return clean;
}

function collectResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Forwards an HTTP request to an upstream LLM provider API.
 *
 * Strips hop-by-hop headers, injects the provider API key as the provider expects,
 * and returns the full response including a stream indicator.
 *
 * @param upstreamUrl - Full URL of the upstream provider endpoint
 * @param method      - HTTP method (GET, POST, etc.)
 * @param headers     - Incoming request headers (hop-by-hop will be stripped)
 * @param body        - Raw request body string
 * @param apiKey      - Provider API key, injected as the provider expects (R11)
 * @param provider    - Provider id; selects how the key is sent (default Bearer)
 * @returns Status, headers, the whole body as text and whether the answer is an event stream.
 * @throws {Error} When `fetch` fails (network error) or the 30 s timeout aborts the request
 *   (`AbortError`); the timeout covers the wait for the response headers.
 */
export async function forwardRequest(
  upstreamUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  apiKey: string,
  provider = 'openai',
): Promise<ForwardResult> {
  const cleanHeaders = upstreamHeaders(headers, apiKey, provider.toLowerCase());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers: cleanHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseHeaders = collectResponseHeaders(response.headers);
  const contentType = responseHeaders['content-type'] ?? '';
  const isStream = contentType.includes('text/event-stream');
  const responseBody = await response.text();

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    isStream,
  };
}

/**
 * Upstream answer returned by {@link openUpstream} as soon as its headers arrive.
 */
export interface UpstreamResponse {
  status: number;
  /** Response headers, lowercase names (as given by `fetch`). */
  headers: Record<string, string>;
  /** `true` when the upstream content type is `text/event-stream`. */
  isStream: boolean;
  /** Unread body; the caller relays it chunk by chunk (R10). */
  body: ReadableStream<Uint8Array> | null;
}

/**
 * R10 — open the upstream request and return as soon as headers arrive, without
 * buffering the body. The timeout covers only the wait for headers, so long
 * streamed generations are not cut; the caller cancels the body on client abort.
 *
 * @param upstreamUrl - Full upstream URL, chosen by the caller.
 * @param method - HTTP method; no body is sent for GET and HEAD.
 * @param headers - Client request headers; cleaned by {@link upstreamHeaders}.
 * @param body - Request body text, possibly rewritten by the caller.
 * @param apiKey - Provider API key to inject; callers must never log it.
 * @param provider - Provider ID (any letter case); default `openai`.
 * @param headerTimeoutMs - Milliseconds to wait for the response headers (default 30000).
 * @param signal - Optional signal that aborts the whole request, body included.
 * @returns Status, headers, the stream flag and the unread body.
 * @throws {Error} When `fetch` fails, the header timeout fires, or `signal` aborts before the headers arrive.
 */
export async function openUpstream(
  upstreamUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  apiKey: string,
  provider = 'openai',
  headerTimeoutMs = 30_000,
  /** D7: aborts the whole upstream request (headers and body), e.g. explicit cancel or a limit. */
  signal?: AbortSignal,
): Promise<UpstreamResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), headerTimeoutMs);
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders(headers, apiKey, provider.toLowerCase()),
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const responseHeaders = collectResponseHeaders(response.headers);
  return {
    status: response.status,
    headers: responseHeaders,
    isStream: (responseHeaders['content-type'] ?? '').includes('text/event-stream'),
    body: response.body,
  };
}
