/**
 * D1–D8 / C — shared context of the durable operation runtime (types only + small helpers),
 * kept apart from runtime.ts so the proxy flow, the effect handlers and the routes do not import
 * each other.
 *
 * @module operations/context
 */
import type { AdmissionGate } from './admissionGate.js';
import type {
  ChainDomain, CommitmentOpening, FrozenConfigRef, NewCommitmentOpeningFn, OperationKey, OutboxEffect, ReceiptCrypto,
} from '../types/d1d8/index.js';
import type { MeasurementPorts } from './measurementPorts.js';
import type { PgOperationStore } from './PgOperationStore.js';
import type { PgEffectOutbox } from './PgEffectOutbox.js';
import type { PgOpeningStore } from './PgOpeningStore.js';
import type { ReceiptV3Store } from './receiptV3Store.js';
import type { MeasurementSpool } from './spool.js';
import type { MoneyBoundPolicy } from './moneyBound.js';
import type { PgPoolLike } from './schema.js';
import type { ProofPorts } from './proofPipeline.js';

/**
 * A's modules (src/zk/v3, src/receipt/v3) as C consumes them. Absent in this branch's entrypoint:
 * then the durable proxy writes the legacy receipt row instead of a v3 receipt (no double debit).
 */
export interface CryptoPorts {
  receiptCrypto: ReceiptCrypto;
  newOpening: NewCommitmentOpeningFn;
  /** A's commitmentOf(opening): the public commitment placed in receipt.publicCommitment. */
  commitmentOf(opening: CommitmentOpening): Promise<string>;
  /** Pseudonymous user reference inside the tenant (decimal string, circuit input). */
  userRefOf(key: OperationKey): string;
  /** Destination frozen into the proof job; null = no on-chain effect configured. */
  proofTarget(cfg: FrozenConfigRef): OutboxEffect['target'] | null;
  /** Chain domain for the public authorization (from deploy_v3.js output), if any. */
  domain: ChainDomain | null;
}

export interface ProxyPolicy {
  /** Injected when the request names no output limit (D7 §2: limits are frozen at admission). */
  defaultMaxOutputTokens: bigint;
  /** A request above this cap is refused before the provider is called. */
  maxOutputTokensCap: bigint;
  /** Upstream is aborted past this duration even if the client is gone. */
  maxDurationMs: bigint;
  /** Execution lease of the instance that streams the operation. */
  leaseMs: number;
  /** Lease renewal and cross-instance cancel check period. */
  cancelPollMs: number;
  /** Non-stream bodies above this size are relayed but not parsed (measurement uncertain). */
  maxResponseBytes: number;
  /** Bound of the stream parser buffers. */
  maxStreamBufferBytes: number;
  /** Text kept in memory for the auxiliary counter (never persisted). */
  maxCounterTextBytes: number;
  /** A client that does not drain for this long is treated as gone (the upstream keeps going). */
  clientStallMs: number;
  /** Extra request headers forwarded upstream (lower case; operator configuration). */
  extraForwardHeaders: string[];
}

export interface InflightOperation {
  abort(reason: 'cancel' | 'limit'): void;
}

export interface OperationsContext {
  pool: PgPoolLike;
  store: PgOperationStore;
  outbox: PgEffectOutbox;
  openings: PgOpeningStore;
  receiptsV3: ReceiptV3Store;
  measurement: MeasurementPorts;
  crypto: CryptoPorts | null;
  /** A's proof adapter + chain submitter (v3 proofs); null = v3 proof jobs wait, visible. */
  proof: ProofPorts | null;
  spool: MeasurementSpool | null;
  /** Strict money ceiling: which requests have a defensible cost bound (S4, ABC-04). */
  moneyBoundPolicy: MoneyBoundPolicy;
  instanceId: string;
  policy: ProxyPolicy;
  /** Operations streamed by this process, by keyString(key). */
  inflight: Map<string, InflightOperation>;
  /** Whether the legacy prover is enabled (legacy receipts get an enqueue_proof effect). */
  legacyProverEnabled(): boolean;
  /** OVERNIGHT 20261005 (F-P1-04): per-process admission limit; absent = no limit (embedded/test contexts). */
  admission?: AdmissionGate;
  /** Structured log sink (no secrets, no payloads). */
  log(event: string, fields: Record<string, unknown>): void;
}

export const keyString = (k: OperationKey): string => JSON.stringify([k.tenantId, k.operationId]);

/** Legacy receipt id of an operation (otk_receipts.request_id is global, not per tenant). */
export const legacyReceiptId = (k: OperationKey): string => `op:${encodeURIComponent(k.tenantId)}:${encodeURIComponent(k.operationId)}`;
