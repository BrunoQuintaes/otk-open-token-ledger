/**
 * D1–D8 / C — v3 proof and on-chain submission of a settled operation (D7 §7, §11; D1-G04 C part;
 * A's request #1/#2: witness input and calldata come from A's ProofAdapter, C never re-encodes).
 *
 *   enqueue_proof (flavor v3, target frozen at creation)
 *     → public authorization (A) over the stored receipt + opening, bucket from A's policy
 *     → adapter.buildWitnessInput → prove → verifyLocal
 *     → submit_onchain effect with the SAME target and the public auth + bundle
 *   submit_onchain
 *     → the instance must be configured for exactly that target; otherwise the job waits
 *       (visible), it is never redirected to another registry/network/schema
 *     → registration check first (A's classifyRegistration): an earlier attempt whose answer was
 *       lost (timeout) is recognised and no second transaction is sent
 *     → send the encoded call as given; tx hash kept with the effect.
 * Proving runs where the opening store is reachable; the opening never travels in a job payload.
 *
 * @module operations/proofPipeline
 */
import type {
  BuildPublicAuthorizationFn, OutboxEffect, PrivateReceiptV3, ProofAdapter, ProofBundle, PublicAuthorization, PublicBucket,
} from '../types/d1d8/index.js';
import type { EffectOutcome } from './OutboxWorker.js';
import { enqueueTx, type ClaimedEffect } from './PgEffectOutbox.js';
import { effectId, payloadDigest } from './ids.js';
import { big, encodeJson } from './codec.js';
import type { OperationsContext } from './context.js';
import { RevisionConflictError } from './PgOperationStore.js';

export type Target = NonNullable<OutboxEffect['target']>;

export interface ChainSubmitter {
  /** A: classifyRegistration(registeredDigest(operationRef), auth) on the target registry. */
  registration(target: Target, auth: PublicAuthorization): Promise<'registered_same' | 'not_registered' | 'registered_other'>;
  /** Sends A's encoded call unchanged; resolves with the transaction hash once mined. */
  submit(target: Target, call: { abi: string[]; functionName: string; args: unknown[] }): Promise<{ txHash: string }>;
}

export interface ProofPorts {
  buildPublicAuthorization: BuildPublicAuthorizationFn;
  /** A: bucketForReceipt(receipt, policy) — the public interval, never derived from exact usage by C. */
  bucketFor(receipt: PrivateReceiptV3): PublicBucket;
  /** A: createProofAdapterV3 for the circuit named in the frozen target; null = not available here. */
  adapterFor(circuitId: string): ProofAdapter | null;
  /** Destination this instance submits to now (deploy output). */
  currentTarget(): Target | null;
  chain: ChainSubmitter;
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const sameTarget = (a: Target, b: Target) => a.chainId === b.chainId && a.registry.toLowerCase() === b.registry.toLowerCase() && a.circuitId === b.circuitId && a.schemaVersion === b.schemaVersion;

/** Decode the public proof data stored with the effect (bigint as strings); no opening inside. */
function revivePublic(v: unknown): { auth: PublicAuthorization; bundle: ProofBundle } {
  const o = (v ?? {}) as Record<string, unknown>;
  const a = (o['auth'] ?? {}) as Record<string, unknown>;
  const d = (a['domain'] ?? {}) as Record<string, unknown>;
  const b = (a['bucket'] ?? {}) as Record<string, unknown>;
  const auth: PublicAuthorization = {
    schema: 'otk.public_authorization.v1',
    domain: { chainId: big(d['chainId'], 'auth.domain.chainId'), registry: String(d['registry']) as `0x${string}`, verifier: String(d['verifier']) as `0x${string}`, schemaVersion: String(d['schemaVersion']) },
    circuitId: String(a['circuitId']),
    commitment: String(a['commitment']),
    epoch: big(a['epoch'], 'auth.epoch'),
    bucket: { min: big(b['min'], 'auth.bucket.min'), max: big(b['max'], 'auth.bucket.max'), policyVersion: String(b['policyVersion']) },
    operationRef: String(a['operationRef']) as `0x${string}`,
    replayKey: String(a['replayKey']) as `0x${string}`,
    fields: Array.isArray(a['fields']) ? (a['fields'] as Array<{ name: string; value: string }>) : [],
    authorizationDigest: String(a['authorizationDigest']) as `0x${string}`,
    signature: a['signature'] as PublicAuthorization['signature'],
  };
  return { auth, bundle: o['bundle'] as ProofBundle };
}

export function proofHandlers(ctx: OperationsContext): {
  enqueue_proof: (e: ClaimedEffect) => Promise<EffectOutcome>;
  submit_onchain: (e: ClaimedEffect) => Promise<EffectOutcome>;
} {
  return {
    async enqueue_proof(e) {
      if (!ctx.proof) return { retryAt: later(30_000), reason: 'proof_ports_not_configured_here' };
      if (!e.target) return { retryAt: null, reason: 'v3 proof job without a frozen target' };
      const op = await ctx.store.get(e.key);
      const stored = await ctx.receiptsV3.getReceipt(e.key);
      const opening = await ctx.openings.get(e.key);
      if (!op || !stored || !opening) return { retryAt: later(5_000), reason: 'receipt_or_opening_not_stored_yet' };
      const domain = op.config.chain;
      if (!domain || domain.chainId !== e.target.chainId || domain.registry.toLowerCase() !== e.target.registry.toLowerCase() || domain.schemaVersion !== e.target.schemaVersion) {
        return { retryAt: null, reason: 'frozen configuration and job target disagree' };
      }
      const adapter = ctx.proof.adapterFor(e.target.circuitId);
      if (!adapter) return { retryAt: later(30_000), reason: `circuit ${e.target.circuitId} not available here` };
      const auth = await ctx.proof.buildPublicAuthorization({ receipt: stored.receipt, opening, domain, bucket: ctx.proof.bucketFor(stored.receipt) });
      const bundle = await adapter.prove(adapter.buildWitnessInput(opening, auth));
      if (!(await adapter.verifyLocal(bundle))) return { retryAt: null, reason: 'local proof verification failed' };
      const pub = JSON.parse(encodeJson({ auth, bundle })) as Record<string, unknown>;
      const payload = { flavor: 'v3', key: e.key, ...pub };
      const submitId = effectId('submit_onchain', e.key);
      await enqueueTx(ctx.pool, { schema: 'otk.outbox_effect.v1', effectId: submitId, key: e.key, kind: 'submit_onchain', payloadDigest: payloadDigest(pub), target: e.target, payload });
      for (let i = 0; i < 5; i++) {
        const cur = (await ctx.store.get(e.key))!;
        if (cur.effects.proofJobId === submitId) break;
        try { await ctx.store.transition(e.key, cur.revision, { effects: { ...cur.effects, proofJobId: submitId } }); break; } catch (err) { if (!(err instanceof RevisionConflictError)) throw err; }
      }
      return 'done';
    },

    async submit_onchain(e) {
      if (!ctx.proof) return { retryAt: later(30_000), reason: 'proof_ports_not_configured_here' };
      if (!e.target) return { retryAt: null, reason: 'submission without a frozen target' };
      const current = ctx.proof.currentTarget();
      // D7 §11 / N15: a job created for one destination is never sent to another
      if (!current || !sameTarget(current, e.target)) return { retryAt: later(60_000), reason: 'target_mismatch: waiting for an instance configured for the frozen target' };
      const adapter = ctx.proof.adapterFor(e.target.circuitId);
      if (!adapter) return { retryAt: later(30_000), reason: `circuit ${e.target.circuitId} not available here` };
      const { auth, bundle } = revivePublic(e.payload);
      const reg = await ctx.proof.chain.registration(e.target, auth);
      if (reg === 'registered_same') return { done: true, result: { registration: 'already_registered' } };
      if (reg === 'registered_other') return { retryAt: null, reason: 'replay key registered with a different authorization' };
      const { txHash } = await ctx.proof.chain.submit(e.target, adapter.encodeSubmission(auth, bundle));
      return { done: true, result: { txHash } };
    },
  };
}
