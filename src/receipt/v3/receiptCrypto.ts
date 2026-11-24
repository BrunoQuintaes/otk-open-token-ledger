/**
 * ReceiptCrypto (src/types/d1d8/modules.ts) — digest, signature and verification of the private
 * receipt v3 and of the conference report v1, plus verification of the historical formats with
 * their original algorithms (D1 §4, D3 §3/§5).
 *
 * What a valid signature means: an authorized OPERATOR key signed exactly these bytes, under this
 * domain. It does not mean the provider signed anything, that the usage was measured correctly,
 * or that the local counter was right (D3 resultado exigido).
 *
 * Envelope (alg eip191-secp256k1): EIP-191 personal_sign over
 *   envelopeDigest = keccak256("OTK_ENVELOPE_V1" ‖ 00 ‖ CE1({alg, domain, keyId, payloadDigest, schema, signedAt, signer}))
 * so the payload kind, key id and signing time are authenticated together with the payload digest.
 */
import { ethers } from 'ethers';
import type {
  AttributionStatementV1, ConferenceReport, CuReferenceStatementV1, Hex32, LegacyReceiptFormat, PrivateReceiptV3, ReceiptCrypto, SignedEnvelope, VerifyFailure, VerifyResult,
} from '../../types/d1d8/index.js';
import type { RawReceipt, ReceiptSignature } from '../../types/receipt.js';
import { verify as verifyRawReceipt } from '../../metering/SignatureManager.js';
import { hashCanonicalReceiptV1, type CanonicalReceiptV1 } from '../canonicalReceiptV1.js';
import { hashCanonicalReceiptV2, type CanonicalReceiptV2 } from '../canonicalReceiptV2.js';
import { CanonicalEncodingError, domainDigest } from './canonicalEncoding.js';
import { ISO_UTC, type KeyRing } from './keyRing.js';

export const RECEIPT_V3_DOMAIN = 'OTK_PRIVATE_RECEIPT_V3' as const;
export const CONFERENCE_V1_DOMAIN = 'OTK_CONFERENCE_V1' as const;
/** v1.4 (OVERNIGHT 20261005, Phase 7): attribution statement bound to a receipt. */
export const ATTRIBUTION_V1_DOMAIN = 'OTK_ATTRIBUTION_V1' as const;
/** v1.5 (OVERNIGHT 2): CU-reference statement bound to a receipt (the receipt v3 schema is untouched). */
export const CU_REFERENCE_V1_DOMAIN = 'OTK_CU_REFERENCE_V1' as const;
export const ENVELOPE_V1_DOMAIN = 'OTK_ENVELOPE_V1' as const;

type EnvelopeDomain = SignedEnvelope['domain'];

export interface ReceiptCryptoOptions {
  keyRing: KeyRing;
  /** Signing key; omitted for verify-only instances. The wallet comes from the secrets boundary. */
  signer?: { keyId: string; wallet: ethers.Signer };
  /** Clock for signedAt (tests inject a fixed one). */
  now?: () => Date;
}

class MalformedPayload extends Error {}

function requireSchema(obj: unknown, schema: string, what: string): void {
  if (!obj || typeof obj !== 'object') throw new MalformedPayload(`${what} must be an object`);
  if ((obj as { schema?: unknown }).schema !== schema) throw new UnsupportedVersion(`${what}.schema must be ${schema}`);
}
class UnsupportedVersion extends Error {}

function requireKey(key: unknown, what: string): void {
  const k = key as { tenantId?: unknown; operationId?: unknown } | null;
  if (!k || typeof k.tenantId !== 'string' || !k.tenantId || typeof k.operationId !== 'string' || !k.operationId) {
    throw new MalformedPayload(`${what}.key must have non-empty tenantId and operationId`);
  }
}

/** keccak256 over CE1 of the receipt, domain OTK_PRIVATE_RECEIPT_V3. */
export function digestReceiptV3(r: PrivateReceiptV3): Hex32 {
  requireSchema(r, 'otk.receipt.v3', 'receipt');
  requireKey(r.key, 'receipt');
  // D2 §6: deterministic content hashes of small-domain texts leak; v3 never carries them.
  if (r.contentDigests !== null) throw new MalformedPayload('receipt.contentDigests must be null in otk.receipt.v3');
  return domainDigest(RECEIPT_V3_DOMAIN, r);
}

/** keccak256 over CE1 of the report, domain OTK_CONFERENCE_V1. */
export function digestConferenceV1(rep: ConferenceReport): Hex32 {
  requireSchema(rep, 'otk.conference.v1', 'conference');
  requireKey(rep.key, 'conference');
  if (rep.verdict !== 'not_applicable' && rep.state !== 'compared') {
    // Only 'compared' may carry a divergence verdict (conference.ts); anything else would read as a seal.
    throw new MalformedPayload(`conference.verdict ${rep.verdict} requires state 'compared'`);
  }
  return domainDigest(CONFERENCE_V1_DOMAIN, rep);
}

const LABEL = /^[A-Za-z0-9._:-]{1,128}$/;

/** keccak256 over CE1 of the attribution statement, domain OTK_ATTRIBUTION_V1. */
export function digestAttributionV1(st: AttributionStatementV1): Hex32 {
  requireSchema(st, 'otk.attribution.v1', 'attribution');
  requireKey(st.key, 'attribution');
  if (typeof st.receiptDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(st.receiptDigest)) throw new MalformedPayload('attribution.receiptDigest must be a 32-byte hex digest');
  const a = st.attribution as unknown as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') throw new MalformedPayload('attribution.attribution must be an object');
  for (const f of ['projectId', 'applicationId', 'taskType', 'taskRunId', 'teamId']) {
    const v = a[f];
    if (v !== null && (typeof v !== 'string' || !LABEL.test(v))) throw new MalformedPayload(`attribution.${f} must be null or a label`);
  }
  if (Object.keys(a).length !== 5) throw new MalformedPayload('attribution carries exactly projectId, applicationId, taskType, taskRunId, teamId');
  return domainDigest(ATTRIBUTION_V1_DOMAIN, st);
}

/** keccak256 over CE1 of the CU-reference statement, domain OTK_CU_REFERENCE_V1. */
export function digestCuReferenceV1(st: CuReferenceStatementV1): Hex32 {
  requireSchema(st, 'otk.cu_reference_statement.v1', 'cuReference');
  requireKey(st.key, 'cuReference');
  if (typeof st.receiptDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(st.receiptDigest)) throw new MalformedPayload('cuReference.receiptDigest must be a 32-byte hex digest');
  if (typeof st.profileDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(st.profileDigest)) throw new MalformedPayload('cuReference.profileDigest must be a 32-byte hex digest');
  if (st.kind !== 'issued_with_operation' && st.kind !== 'analytical_recomputation') throw new MalformedPayload('cuReference.kind');
  if (st.cuFormulaVersion !== 'CU_REF_SUM_v1') throw new UnsupportedVersion(`cuReference.cuFormulaVersion ${String(st.cuFormulaVersion)}`);
  if (st.label !== 'CU_REFERENCE_CANDIDATE' && st.label !== 'CU_REFERENCE_FINAL') throw new MalformedPayload('cuReference.label');
  // audit OVN2 (LOW): same field-format discipline as the other statements before anything is signed
  if (typeof st.basePeriod !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(st.basePeriod)) throw new MalformedPayload('cuReference.basePeriod must be YYYY-MM');
  if (typeof st.cuReferenceProfileId !== 'string' || !/^[A-Za-z0-9._:-]{3,128}$/.test(st.cuReferenceProfileId)) throw new MalformedPayload('cuReference.cuReferenceProfileId');
  if (typeof st.computedAt !== 'string' || !ISO_UTC.test(st.computedAt)) throw new MalformedPayload('cuReference.computedAt must be ISO-8601 UTC');
  const ex = st.exact as unknown as Record<string, unknown> | null;
  if (!ex || typeof ex.numerator !== 'string' || typeof ex.denominator !== 'string' || !/^[0-9]+$/.test(ex.numerator) || !/^[1-9][0-9]*$/.test(ex.denominator)) {
    throw new MalformedPayload('cuReference.exact must be {numerator, denominator} decimal strings, denominator > 0');
  }
  for (const [k, v] of Object.entries(st.quantities ?? {})) if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) throw new MalformedPayload(`cuReference.quantities.${k}`);
  return domainDigest(CU_REFERENCE_V1_DOMAIN, st);
}

export function envelopeDigest(env: Pick<SignedEnvelope, 'alg' | 'domain' | 'keyId' | 'payloadDigest' | 'schema' | 'signedAt' | 'signer'>): Hex32 {
  return domainDigest(ENVELOPE_V1_DOMAIN, {
    alg: env.alg, domain: env.domain, keyId: env.keyId, payloadDigest: env.payloadDigest.toLowerCase(),
    schema: env.schema, signedAt: env.signedAt, signer: env.signer.toLowerCase(),
  });
}

function fail(reason: VerifyFailure, detail?: string): VerifyResult {
  return detail ? { ok: false, reason, detail } : { ok: false, reason };
}

function classify(e: unknown): VerifyResult {
  if (e instanceof UnsupportedVersion) return fail('unsupported_version', e.message);
  if (e instanceof MalformedPayload || e instanceof CanonicalEncodingError) return fail('malformed', e.message);
  return fail('malformed', e instanceof Error ? e.message : String(e));
}

function recover(digest: string, signature: string): string | null {
  try {
    return ethers.verifyMessage(ethers.getBytes(digest), signature);
  } catch {
    return null;
  }
}

export function createReceiptCrypto(opts: ReceiptCryptoOptions): ReceiptCrypto {
  const now = opts.now ?? (() => new Date());

  async function signDigest(domain: EnvelopeDomain, payloadDigest: Hex32): Promise<SignedEnvelope> {
    if (!opts.signer) throw new Error('ReceiptCrypto: no signing key configured (verify-only instance)');
    const entry = opts.keyRing.get(opts.signer.keyId);
    const address = (await opts.signer.wallet.getAddress()) as `0x${string}`;
    if (!entry || entry.status !== 'active') throw new Error(`ReceiptCrypto: key ${opts.signer.keyId} is not active`);
    if (entry.address.toLowerCase() !== address.toLowerCase()) throw new Error(`ReceiptCrypto: key ${opts.signer.keyId} does not belong to the signer wallet`);
    const unsigned = {
      schema: 'otk.envelope.v1' as const, domain, payloadDigest, alg: 'eip191-secp256k1' as const,
      signer: address, keyId: entry.keyId, signedAt: now().toISOString(),
    };
    const signature = (await opts.signer.wallet.signMessage(ethers.getBytes(envelopeDigest(unsigned)))) as `0x${string}`;
    return { ...unsigned, signature };
  }

  function verifyEnvelope(expectedDomain: EnvelopeDomain, payloadDigest: Hex32, env: SignedEnvelope): VerifyResult {
    if (!env || typeof env !== 'object') return fail('malformed', 'envelope missing');
    if (env.schema !== 'otk.envelope.v1') return fail('unsupported_version', `envelope schema ${String(env.schema)}`);
    if (env.alg !== 'eip191-secp256k1') return fail('unsupported_version', `alg ${String(env.alg)} not accepted for ${expectedDomain}`);
    if (env.domain !== expectedDomain) return fail('wrong_domain', `expected ${expectedDomain}, got ${String(env.domain)}`);
    if (typeof env.payloadDigest !== 'string' || env.payloadDigest.toLowerCase() !== payloadDigest.toLowerCase()) return fail('digest_mismatch');
    const entry = opts.keyRing.get(env.keyId);
    if (!entry) return fail('unauthorized_signer', `unknown keyId ${String(env.keyId)}`);
    if (entry.address.toLowerCase() !== String(env.signer).toLowerCase()) return fail('unauthorized_signer', 'keyId does not belong to signer');
    if (entry.status === 'revoked') return fail('revoked_key', entry.keyId);
    if (typeof env.signedAt !== 'string' || !ISO_UTC.test(env.signedAt)) return fail('malformed', 'signedAt must be ISO-8601 UTC');
    // A retired key verifies only what it signed before retirement (signedAt is the signer's claim).
    if (entry.status === 'retired' && env.signedAt > entry.retiredAt!) return fail('revoked_key', `${entry.keyId} retired at ${entry.retiredAt}`);
    let digest: string;
    try { digest = envelopeDigest(env); } catch (e) { return classify(e); }
    const recovered = recover(digest, env.signature);
    if (!recovered || recovered.toLowerCase() !== entry.address.toLowerCase()) return fail('bad_signature');
    return { ok: true, signer: entry.address, keyId: entry.keyId };
  }

  function legacySigner(recovered: string | null): VerifyResult {
    if (!recovered) return fail('bad_signature');
    const entry = opts.keyRing.byAddress(recovered);
    if (!entry) return fail('unauthorized_signer', recovered);
    // Legacy formats carry no signing time, so a retired key cannot be time-bounded: only revocation applies.
    if (entry.status === 'revoked') return fail('revoked_key', entry.keyId);
    return { ok: true, signer: entry.address, keyId: entry.keyId };
  }

  return {
    digestReceipt: digestReceiptV3,
    digestConference: digestConferenceV1,

    signReceipt: async (r) => signDigest(RECEIPT_V3_DOMAIN, digestReceiptV3(r)),
    signConference: async (rep) => signDigest(CONFERENCE_V1_DOMAIN, digestConferenceV1(rep)),
    digestAttribution: digestAttributionV1,
    signAttribution: async (st) => signDigest(ATTRIBUTION_V1_DOMAIN, digestAttributionV1(st)),

    verifyAttribution(st, env, receipt) {
      let d: Hex32, rd: Hex32;
      try { d = digestAttributionV1(st); rd = digestReceiptV3(receipt); } catch (e) { return classify(e); }
      const sig = verifyEnvelope(ATTRIBUTION_V1_DOMAIN, d, env);
      if (!sig.ok) return sig;
      // a statement moved to another receipt, tenant or operation is refused (same rule as the conference)
      if (st.receiptDigest.toLowerCase() !== rd.toLowerCase()) return fail('binding_mismatch', 'receiptDigest does not match the receipt');
      if (st.key.tenantId !== receipt.key.tenantId || st.key.operationId !== receipt.key.operationId) return fail('binding_mismatch', 'statement key differs from receipt key');
      return sig;
    },

    digestCuReference: digestCuReferenceV1,
    signCuReference: async (st) => signDigest(CU_REFERENCE_V1_DOMAIN, digestCuReferenceV1(st)),

    verifyCuReference(st, env, receipt) {
      let d: Hex32, rd: Hex32;
      try { d = digestCuReferenceV1(st); rd = digestReceiptV3(receipt); } catch (e) { return classify(e); }
      const sig = verifyEnvelope(CU_REFERENCE_V1_DOMAIN, d, env);
      if (!sig.ok) return sig;
      if (st.receiptDigest.toLowerCase() !== rd.toLowerCase()) return fail('binding_mismatch', 'receiptDigest does not match the receipt');
      if (st.key.tenantId !== receipt.key.tenantId || st.key.operationId !== receipt.key.operationId) return fail('binding_mismatch', 'statement key differs from receipt key');
      return sig;
    },

    verifyReceipt(r, env) {
      let d: Hex32;
      try { d = digestReceiptV3(r); } catch (e) { return classify(e); }
      return verifyEnvelope(RECEIPT_V3_DOMAIN, d, env);
    },

    verifyConference(rep, env, receipt) {
      let d: Hex32, rd: Hex32;
      try { d = digestConferenceV1(rep); rd = digestReceiptV3(receipt); } catch (e) { return classify(e); }
      const sig = verifyEnvelope(CONFERENCE_V1_DOMAIN, d, env);
      if (!sig.ok) return sig;
      // D3-G06: a report moved to another receipt, tenant or operation is refused.
      if (rep.receiptDigest.toLowerCase() !== rd.toLowerCase()) return fail('binding_mismatch', 'receiptDigest does not match the receipt');
      if (rep.key.tenantId !== receipt.key.tenantId || rep.key.operationId !== receipt.key.operationId) {
        return fail('binding_mismatch', 'report key differs from receipt key');
      }
      return sig;
    },

    verifyLegacy(format: LegacyReceiptFormat, payload: unknown, signature: unknown): VerifyResult {
      try {
        if (format === 'raw_receipt_canonical_hash') {
          const sig = signature as ReceiptSignature;
          if (!sig || typeof sig.rawHash !== 'string') return fail('malformed', 'ReceiptSignature expected');
          // Original algorithm (SignatureManager.canonicalHash), unchanged.
          if (!verifyRawReceipt(payload as RawReceipt, sig)) return fail('bad_signature', 'canonicalHash/rawHash or signature mismatch');
          return legacySigner(sig.signer);
        }
        if (format === 'otk_receipt_v1' || format === 'otk_receipt_v2') {
          const s = signature as { rawHash?: string; signature?: string } | null;
          if (!s || typeof s.signature !== 'string') return fail('malformed', '{ signature, rawHash? } expected');
          const hash = format === 'otk_receipt_v1'
            ? hashCanonicalReceiptV1(payload as CanonicalReceiptV1)
            : hashCanonicalReceiptV2(payload as CanonicalReceiptV2);
          if (s.rawHash !== undefined && s.rawHash.toLowerCase() !== hash.toLowerCase()) return fail('digest_mismatch');
          return legacySigner(recover(hash, s.signature));
        }
        return fail('unsupported_version', `legacy format ${String(format)}`);
      } catch (e) {
        return fail('malformed', e instanceof Error ? e.message : String(e));
      }
    },
  };
}
