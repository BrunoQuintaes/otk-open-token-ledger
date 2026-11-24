/**
 * PROXY-02 — ProxyForwarder
 * HTTP relay to upstream LLM provider APIs using native fetch.
 */

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: string;
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

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  isStream: boolean;
  /** Unread body; the caller relays it chunk by chunk (R10). */
  body: ReadableStream<Uint8Array> | null;
}

/**
 * R10 — open the upstream request and return as soon as headers arrive, without
 * buffering the body. The timeout covers only the wait for headers, so long
 * streamed generations are not cut; the caller cancels the body on client abort.
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
