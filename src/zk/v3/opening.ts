/**
 * Commitment opening for metering_v3 (NewCommitmentOpeningFn, D2 §2/§5).
 *
 *   commitment   = Poseidon(TAG_V3, usage, blinding, userRef, epoch)
 *   operationRef = keccak256("OTK_OPREF_V1" ‖ 00 ‖ CE1({operationId, salt, tenantId}))
 *
 * `blinding` and `salt` are drawn here from the OS CSPRNG; callers cannot supply them. The opening
 * is private data: C persists it (tenant-scoped, backed up) BEFORE any dependent public effect and
 * never writes it to logs, Git, queue payloads in clear or dead-letter dumps.
 *
 * Unit mapping: CuResult.cu = units / scale (scale a power of ten). Circuit usage is micro-CU:
 * usage = units × (10⁶ / scale). A scale finer than 10⁶ is refused instead of rounded.
 */
import type { CommitmentOpening, FieldElement, Hex32, IsoTime, NewCommitmentOpeningFn, OperationKey, Scaled } from '../../types/d1d8/index.js';
import { domainDigest } from '../../receipt/v3/canonicalEncoding.js';
import { assertU64, FieldInputError, parseCanonicalDecimal, parseFieldElement, randomFieldElement } from './field.js';
import { poseidonHash } from './poseidon.js';

/** ASCII "otk.metering.v3" — must equal TAG_V3 in zk/circuits/metering_v3.circom. */
export const TAG_V3 = 0x6f746b2e6d65746572696e672e7633n;
export const CIRCUIT_USAGE_SCALE = 1_000_000n;
export const EPOCH_MS = 3_600_000n;
export const CIRCUIT_V3_PREFIX = 'metering_v3@';

const ALLOWED_CALLER_INPUTS = ['epoch', 'userRef'] as const;

function isPowerOfTen(x: bigint): boolean {
  if (x < 1n) return false;
  while (x % 10n === 0n) x /= 10n;
  return x === 1n;
}

/** Exact conversion of an accounting CU amount into circuit units (micro-CU). */
export function usageToCircuitUnits(cu: Scaled): bigint {
  if (typeof cu?.units !== 'bigint' || typeof cu?.scale !== 'bigint') throw new FieldInputError('usage', 'Scaled with bigint units/scale required');
  if (!isPowerOfTen(cu.scale)) throw new FieldInputError('usage.scale', 'must be a positive power of ten');
  if (cu.scale > CIRCUIT_USAGE_SCALE) throw new FieldInputError('usage.scale', 'finer than micro-CU; conversion would lose digits');
  if (cu.units < 0n) throw new FieldInputError('usage.units', 'negative usage');
  return assertU64('usage', cu.units * (CIRCUIT_USAGE_SCALE / cu.scale));
}

/** Hour epoch of an ISO-8601 UTC timestamp (…Z): floor(ms / 3 600 000). No host-timezone parsing. */
export function epochOf(t: IsoTime): bigint {
  if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(t)) throw new FieldInputError('epoch', `timestamp must be ISO-8601 UTC with Z: ${t}`);
  const ms = Date.parse(t);
  if (!Number.isFinite(ms) || ms < 0) throw new FieldInputError('epoch', `invalid timestamp ${t}`);
  return BigInt(ms) / EPOCH_MS;
}

export const newCommitmentOpening: NewCommitmentOpeningFn = (key, usage, circuitId, privateInputs) => {
  if (!key || !key.tenantId || !key.operationId) throw new FieldInputError('key', 'tenantId and operationId required');
  if (typeof circuitId !== 'string' || !circuitId.startsWith(CIRCUIT_V3_PREFIX)) {
    throw new FieldInputError('circuitId', `only ${CIRCUIT_V3_PREFIX}* is supported by this opening`);
  }
  const extra = Object.keys(privateInputs ?? {}).filter((k) => !(ALLOWED_CALLER_INPUTS as readonly string[]).includes(k));
  if (extra.length) throw new FieldInputError('privateInputs', `unexpected inputs ${extra.join(',')} (blinding/salt are generated here)`);
  const userRef = parseFieldElement('privateInputs.userRef', privateInputs['userRef'] ?? '');
  const epoch = assertU64('privateInputs.epoch', parseCanonicalDecimal('privateInputs.epoch', privateInputs['epoch'] ?? ''));
  const units = usageToCircuitUnits(usage);
  return {
    schema: 'otk.opening.v1',
    key: { tenantId: key.tenantId, operationId: key.operationId },
    circuitId,
    usage: { units, scale: CIRCUIT_USAGE_SCALE },
    blinding: randomFieldElement().toString(),
    privateInputs: { userRef: userRef.toString(), epoch: epoch.toString(), opRefSalt: randomFieldElement().toString() },
    createdAt: new Date().toISOString(),
  };
};

/** Validated circuit-side view of an opening. Throws FieldInputError on any inconsistency. */
export function openingValues(o: CommitmentOpening): { usage: bigint; blinding: bigint; userRef: bigint; epoch: bigint; salt: bigint } {
  if (o?.schema !== 'otk.opening.v1') throw new FieldInputError('opening.schema', 'otk.opening.v1 required');
  if (o.usage?.scale !== CIRCUIT_USAGE_SCALE) throw new FieldInputError('opening.usage.scale', 'must be micro-CU (10^6)');
  return {
    usage: assertU64('opening.usage', o.usage.units),
    blinding: parseFieldElement('opening.blinding', o.blinding),
    userRef: parseFieldElement('opening.privateInputs.userRef', o.privateInputs['userRef'] ?? ''),
    epoch: assertU64('opening.privateInputs.epoch', parseCanonicalDecimal('opening.privateInputs.epoch', o.privateInputs['epoch'] ?? '')),
    salt: parseFieldElement('opening.privateInputs.opRefSalt', o.privateInputs['opRefSalt'] ?? ''),
  };
}

/** Public commitment of an opening (decimal field element). */
export async function commitmentOf(o: CommitmentOpening): Promise<FieldElement> {
  const v = openingValues(o);
  return (await poseidonHash([TAG_V3, v.usage, v.blinding, v.userRef, v.epoch])).toString();
}

/** Hiding operation reference: binds tenant + operation without revealing them. */
export function operationRefOf(key: OperationKey, salt: bigint): Hex32 {
  return domainDigest('OTK_OPREF_V1', { operationId: key.operationId, salt, tenantId: key.tenantId });
}

export function operationRefOfOpening(o: CommitmentOpening): Hex32 {
  return operationRefOf(o.key, openingValues(o).salt);
}
