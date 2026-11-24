/**
 * @otk/metering-sdk — TypeScript client for OTK zk-Metering API
 *
 * Provides typed methods for receipt submission, querying, balance, and invoice
 * generation against an OTK zk-Metering runtime instance.
 *
 * @since P1.5 — Wave 1 Pack 10
 */

// ─── Configuration ───────────────────────────────────────────────────

/** SDK configuration options */
export interface OTKClientConfig {
  /** Base URL of the OTK zk-Metering API (e.g. "http://localhost:8787") */
  baseUrl: string;
  /** Bearer token for authenticated requests (optional — only needed when auth is enabled) */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

// ─── Request / Response Types ────────────────────────────────────────

/** Receipt submission payload */
export interface SubmitReceiptRequest {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUnits: number;
  latencyMs: number;
  timestamp: number;
  requestId: string;
  userId: string;
  nonce: string;
  signature: string;
  epochId: string;
}

/** Response from POST /receipts */
export interface SubmitReceiptResponse {
  stored: boolean;
  duplicate?: boolean;
  requestId: string;
}

/** Receipt data returned by GET /receipts/:id */
export interface ReceiptResponse {
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUnits: number;
  latencyMs: number;
  timestamp: number;
  epochId: string;
  proofStatus?: string;
}

/** Balance data returned by GET /accounting/balance */
export interface BalanceResponse {
  tenantId: string;
  epochId: string;
  totalCU: string;
  entryCount: number;
}

/** Invoice data, under `invoice` in the answer of GET /invoices */
export interface InvoiceResponse {
  tenantId: string;
  epochId: string;
  totalCU: string;
  lineItems: Array<{
    provider: string;
    model: string;
    cuSubtotal: string;
    requestCount: number;
  }>;
  generatedAt: string;
}

/** Answer of GET /invoices (H1-S24: the invoice is wrapped, it is not the top-level object) */
export interface InvoiceEnvelope {
  ok: boolean;
  invoice: InvoiceResponse;
}

/** Health check response */
export interface HealthResponse {
  ok: boolean;
  uptime: string;
  ts: string;
}

// ─── Error Types ─────────────────────────────────────────────────────

/** Error thrown by SDK on API failures */
export class OTKApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OTKApiError';
  }
}

// ─── Client Class ────────────────────────────────────────────────────

/**
 * OTK Metering Client
 *
 * Usage:
 * ```ts
 * const client = new OTKMeteringClient({ baseUrl: 'http://localhost:8787', apiKey: 'tok_abc' });
 * const receipt = await client.getReceipt('req-123');
 * ```
 */
export class OTKMeteringClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(config: OTKClientConfig) {
    if (!config.baseUrl) {
      throw new Error('OTKMeteringClient: baseUrl is required');
    }
    // Strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30_000;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        let resBody: unknown;
        try { resBody = await res.json(); } catch { resBody = await res.text(); }
        throw new OTKApiError(`HTTP ${res.status} ${res.statusText}`, res.status, resBody);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  /** Check API health */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  /**
   * Submit a metering receipt
   *
   * @returns 201 on new receipt, 200 on duplicate (idempotent)
   */
  async submitReceipt(receipt: SubmitReceiptRequest): Promise<SubmitReceiptResponse> {
    return this.request<SubmitReceiptResponse>('POST', '/receipts', receipt);
  }

  /**
   * Retrieve a receipt by request ID
   *
   * @param requestId Unique request identifier
   */
  async getReceipt(requestId: string): Promise<ReceiptResponse> {
    return this.request<ReceiptResponse>('GET', `/receipts/${encodeURIComponent(requestId)}`);
  }

  /**
   * Get the CU balance for a tenant in a given epoch
   *
   * @param tenantId Tenant identifier
   * @param epochId Epoch identifier
   */
  async getBalance(tenantId: string, epochId: string): Promise<BalanceResponse> {
    const qs = new URLSearchParams({ tenantId, epochId });
    return this.request<BalanceResponse>('GET', `/accounting/balance?${qs.toString()}`);
  }

  /**
   * Generate an invoice for a tenant in a given epoch
   *
   * @param tenantId Tenant identifier
   * @param epochId Epoch identifier
   */
  async getInvoice(tenantId: string, epochId: string): Promise<InvoiceEnvelope> {
    const qs = new URLSearchParams({ tenantId, epochId });
    // H1-S24: the route is GET /invoices; /billing/invoice never existed (every call answered 404)
    return this.request<InvoiceEnvelope>('GET', `/invoices?${qs.toString()}`);
  }
}
