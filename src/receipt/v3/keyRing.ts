/**
 * Operator signing keys known to a verifier (D1 §3: authorized signer, rotation, revocation).
 *
 *   active  — may sign new payloads; its signatures verify
 *   retired — rotated out at `retiredAt`: envelopes verify only if signedAt ≤ retiredAt; public
 *             authorizations from it are not accepted off-chain (their historical validity is the
 *             on-chain registration, `registeredDigest`)
 *   revoked — compromised or withdrawn: signatures are rejected, whatever their signedAt says
 *
 * One entry per address: two entries for the same key would let a signer pick the friendlier
 * status through the keyId it writes into the envelope (revocation bypass).
 *
 * Limit: signedAt is written by the key holder. Whoever holds a retired key can still backdate
 * an envelope to before retiredAt; only revocation stops that, or an external time anchor.
 *
 * Holds addresses only. Private keys are never stored here; signing uses an ethers Signer that
 * the caller obtained through the secrets boundary (secretsBootstrap / ProviderGateway).
 */
import type { Address, IsoTime } from '../../types/d1d8/index.js';

export type KeyStatus = 'active' | 'retired' | 'revoked';

export interface KeyEntry {
  keyId: string;
  address: Address;
  status: KeyStatus;
  /** Required when status is 'retired'. */
  retiredAt?: IsoTime;
}

export interface KeyRing {
  get(keyId: string): KeyEntry | null;
  /** The entry of an address, case-insensitively (legacy formats carry no keyId). */
  byAddress(address: string): KeyEntry | null;
}

/** Strict ISO-8601 UTC instant with milliseconds, as produced by Date.toISOString(). */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function createKeyRing(entries: readonly KeyEntry[]): KeyRing {
  const byId = new Map<string, KeyEntry>();
  const byAddr = new Map<string, KeyEntry>();
  for (const e of entries) {
    if (!e.keyId) throw new Error('keyRing: empty keyId');
    if (byId.has(e.keyId)) throw new Error(`keyRing: duplicate keyId ${e.keyId}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(e.address)) throw new Error(`keyRing: bad address for ${e.keyId}`);
    const addr = e.address.toLowerCase();
    if (byAddr.has(addr)) throw new Error(`keyRing: address of ${e.keyId} already registered as ${byAddr.get(addr)!.keyId}`);
    if (e.status === 'retired' && !(typeof e.retiredAt === 'string' && ISO_UTC.test(e.retiredAt))) {
      throw new Error(`keyRing: retired key ${e.keyId} needs retiredAt (ISO-8601 UTC)`);
    }
    const frozen = Object.freeze({ ...e });
    byId.set(e.keyId, frozen);
    byAddr.set(addr, frozen);
  }
  return {
    get: (keyId) => byId.get(keyId) ?? null,
    byAddress: (address) => byAddr.get(address.toLowerCase()) ?? null,
  };
}
