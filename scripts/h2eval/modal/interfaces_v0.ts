/**
 * MIRROR of the adapter-facing part of scripts/h2eval/types.ts published by BOT-02 (core worktree, head 24d9f186,
 * sha256 9ca057b12ae7c0be47320ecd9aa06a1345cd508f9c306c419a83a87a8e60ab25; INTERFACES.md b066f533...).
 * That file lives in the core branch and is not in this worktree; the shapes below are copied VERBATIM so the modal
 * adapters compile and test here. At integration BOT-02 replaces this import by `../types.js` (structurally identical).
 *
 * Current state: `modal/index.ts` still imports and re-exports these types. The mirror is narrower than
 * `scripts/h2eval/types.ts` in places (for example `Phase` and `Split` lack the paired-comparison values, and the plan
 * has no `opId`/`econSeq`); see that file for the field meanings, which are the same here.
 *
 * @module scripts/h2eval/modal/interfaces_v0
 */
import type { UsageApi } from '../../../src/types/d1d8/index.js';

/** Lowercase hex SHA-256 digest (64 characters). */
export type Hex64 = string;
/** Integer count, or the two honest non-numbers. Never 0 for "absent". */
export type Count = number | 'UNKNOWN' | 'NOT_APPLICABLE';
/** Provider. */
export type Provider = 'openai' | 'anthropic' | 'google';
/** Study phase. */
export type Phase = 'PILOT' | 'CONFIRMATORY' | 'EXPLORATORY_MODALITY';
/** Data split. */
export type Split = 'train' | 'validation' | 'holdout' | 'NONE';
/** Task kind. */
export type Task = 'summary' | 'code_fix' | 'analysis' | 'code_gen';
/** Prompt size class. */
export type SizeBucket = 'S' | 'L';
/** Call structure (S1 single message, S2/S3 dialogs). */
export type Structure = 'S1' | 'S2' | 'S3';
/** Input modality. */
export type Modality = 'text' | 'image' | 'audio';
/** Planned cache arm. */
export type CacheArm = 'S1' | 'S2_NOHIT' | 'S3_HITATTEMPT';
/** Cache outcome derived from the usage counts. */
export type CacheObserved = 'HIT' | 'CREATION' | 'NO_HIT' | 'UNKNOWN';

/** Published as mandatory in types.ts (core head ed426830); optional here so the pure adapters also accept v0 plans. */
/** EXEC-ECON C160 (delta v3.1 item 1): 'omit' = NOTHING about reasoning is sent (H-2 (i)); only valid with params.bodyProfile 'H_PARITY'. */
export interface ThinkingParams { mode: 'none' | 'adaptive' | 'manual' | 'minimal' | 'omit'; effort?: string; budgetTokens?: number; thinkingLevel?: string }
/** Cache write TTL requested. */
export type CacheTtlRequested = '5m' | '1h' | 'NOT_APPLICABLE';
/** Request parameters of an operation; `maxTokens` is the output ceiling in tokens. */
export interface OperationParams {
  maxTokens: number;
  temperature: number | 'DEFAULT';
  reasoning: Record<string, string | number | boolean> | 'NONE';
  serviceTier: string | 'NONE';
  cacheDirectives: Record<string, string | number | boolean> | 'NONE';
  serviceTierRequested?: string | 'NONE';
  thinking?: ThinkingParams;
  cacheTtlRequested?: CacheTtlRequested;
  /** EXEC-ECON C160 (delta v3.1 items 1, 2, 10): 'H_PARITY' = the body of the H path (BOT-02 clients, protocol §2.1); absent = unchanged legacy bodies. */
  bodyProfile?: 'H_PARITY';
}

/** One planned call (identity, routing, content hashes and parameters). */
export interface OperationPlan {
  schema: 'h2eval.plan.v0';
  studyId: string; protocolHash: Hex64; manifestSha256: Hex64; batchId: string; phase: Phase;
  cellId: string; groupId: string; promptId: string; rep: number; variant: string; split: Split;
  provider: Provider; api: UsageApi; endpoint: string; modelRequested: string;
  task: Task; sizeBucket: SizeBucket; structure: Structure; modality: Modality; plannedCacheArm: CacheArm;
  promptSha256: Hex64; prefixSha256: Hex64 | 'NOT_APPLICABLE'; nonce: string | 'NOT_APPLICABLE';
  params: OperationParams;
}

/** HTTP request built by an adapter without the credential, plus the text and non-text parts for the local counter. */
export interface BuiltRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  credentialHeader: string;
  credentialFormat: 'raw' | 'bearer';
  body: unknown;
  textParts: string[];
  nonTextParts: Array<{ kind: 'image' | 'audio' | 'tool' | 'other'; units: Count; unit: string }>;
}

/** Usage normalised by an adapter into disjoint categories; `U` is the total prompt length in tokens. */
export interface NormalizedUsageH2 {
  schema: 'h2eval.usage.v0';
  inputUncached: Count; cacheRead: Count; cacheWrite5m: Count; cacheWrite1h: Count; cacheWrite: Count;
  outputVisible: Count; reasoning: Count; imageUnits: Count; audioUnits: Count; toolTokens: Count;
  U: Count;
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'MISSING';
  usageSource: 'provider_response';
  rawUsageSanitized: Record<string, number>;
  modelServed: string | 'UNKNOWN';
  serviceTierServed: string | 'UNKNOWN';
  cacheObserved: CacheObserved;
  /** VNEXT-1 (C151): provider stop/finish reason (identifier) and the completion derived from it; total output as reported. */
  stopReason: string | 'UNKNOWN';
  completion: 'COMPLETE' | 'TRUNCATED_MAX_TOKENS' | 'REFUSED' | 'OTHER' | 'UNKNOWN';
  outputTotal: Count;
}

/** Refusal or filter detected in a response (closed code, never provider text). */
export interface ParsedRefusal { refused: boolean; code: string | 'NONE'; httpStatus: number | 'UNKNOWN'; usagePresent: boolean }

/** One message part: text, or an image/audio part addressed by hash (bytes inline only after resolution). */
export type ResolvedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; bytesSha256: Hex64; width: number; height: number; bytesBase64?: string }
  | { type: 'audio'; mime: string; bytesSha256: Hex64; seconds: number; bytesBase64?: string };
/** `bytesBase64` is an ADDITION of this mirror (see README: the published ResolvedContent carries only the hash; a pure adapter cannot fetch bytes). */
export interface ResolvedContent { promptSha256: Hex64; messages: Array<{ role: 'system' | 'user' | 'assistant'; parts: ResolvedPart[] }>; prefixMessages: number | 'NOT_APPLICABLE' }

/** Pure per-API adapter: builds the request, and parses refusals and usage from the response. No I/O. */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly api: UsageApi;
  readonly adapterVersion: string;
  readonly officialHosts: readonly string[];
  buildRequest(plan: OperationPlan, content: ResolvedContent): BuiltRequest;
  parseRefusal(httpStatus: number, body: unknown): ParsedRefusal;
  /** VNEXT-2: `ctx.thinkingRequested=false` tells the parser the request disabled thinking (reasoning NOT_APPLICABLE when the detail is absent). */
  parseUsage(body: unknown, ctx?: { thinkingRequested?: boolean; textOnly?: boolean }): NormalizedUsageH2;
  modelSupport(modelRequested: string): import('../../../src/types/d1d8/index.js').ModelSupport;
  modelDeprecation?(modelServed: string): 'DEPRECATED_SHUTDOWN_2027-01-14' | 'LEGACY' | 'ACTIVE' | 'UNKNOWN';
}
