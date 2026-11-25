/**
 * Chaveiro público otk.keyring.public.v1: só keyId, endereço, estado e retiredAt. A validação de
 * regras (endereço único, aposentada exige retiredAt) é a do createKeyRing existente, sem cópia.
 *
 * Também aceita o anel público do bot (otk.bridge.keyring_file.v1, C160 B5F-2): os mesmos campos
 * {keyId, address, status, retiredAt?}, sem nome de operador. Ele é convertido sem perder nada
 * (convertBridgeKeyRing) e validado pelas mesmas regras (F4, DEFESA_CIRCUITO).
 *
 * Impressão digital = sha256 dos bytes exatos do arquivo carregado (hex minúsculo), nos dois
 * formatos. Assim qualquer pessoa confere com `sha256sum chaveiro.json` / `Get-FileHash`, sem o
 * verificador; para o anel do bot é o mesmo sha256 que o bot já declara.
 *
 * (English) Public key ring file of the verifier (key ID, address, status, retiredAt only) and conversion
 * from the bot's public key ring format. The fingerprint is the SHA-256 of the exact file bytes.
 *
 * @module src/verifier/keyring
 */
import { ethers } from 'ethers';
import { createKeyRing, ISO_UTC, type KeyRing } from '../receipt/v3/keyRing.js';
import type { PublicKeyEntry, PublicKeyRingFile } from './types.js';

/**
 * Schema identifier of the public key ring file.
 */
export const KEYRING_SCHEMA = 'otk.keyring.public.v1' as const;
/** Anel público do bot (C160 B5F-2): {schema, keys:[{keyId,address,status,retiredAt?}]}, sem operator. */
export const BRIDGE_KEYRING_SCHEMA = 'otk.bridge.keyring_file.v1' as const;
/**
 * Key ring formats this verifier reads.
 */
export type KeyRingFormat = typeof KEYRING_SCHEMA | typeof BRIDGE_KEYRING_SCHEMA;

/** Mensagem do formato desconhecido (página e comando): nunca diz que o arquivo foi mexido. */
export const UNKNOWN_KEYRING_FORMAT = 'formato de chaveiro não reconhecido';

/**
 * SHA-256 of raw bytes.
 *
 * @param bytes - Data to hash.
 * @returns Lowercase hex digest without `0x` (64 characters).
 */
export function sha256Hex(bytes: Uint8Array): string {
  return ethers.sha256(bytes).slice(2);
}

/**
 * Normaliza a impressão digital digitada: tira 0x, espaços, ':' e '-'; minúsculas. null se vazia.
 *
 * @param s - Fingerprint as typed by a person.
 * @returns The normalized text (not validated), or `null` when empty.
 */
export function normalizeFingerprint(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim().toLowerCase().replace(/^0x/, '').replace(/[\s:-]/g, '');
  return t === '' ? null : t;
}

/**
 * Tells whether a normalized fingerprint has the SHA-256 shape.
 *
 * @param s - Normalized fingerprint.
 * @returns `true` for exactly 64 lowercase hex characters.
 */
export function isValidFingerprint(s: string | null): boolean {
  return s !== null && /^[0-9a-f]{64}$/.test(s);
}

/**
 * Result of {@link parsePublicKeyRing}: the file and key ring, or the error message; the fingerprint is always set.
 */
export type ParsedKeyRing =
  | { ok: true; file: PublicKeyRingFile; ring: KeyRing; fingerprint: string; format: KeyRingFormat }
  | { ok: false; error: string; fingerprint: string; unknownFormat: boolean };

const ENTRY_FIELDS = new Set(['keyId', 'address', 'status', 'retiredAt']);
const FILE_FIELDS = new Set(['schema', 'operator', 'keys']);
const BRIDGE_FILE_FIELDS = new Set(['schema', 'keys']);

/**
 * Formato do chaveiro pelo campo de formato do arquivo; null = formato não reconhecido.
 *
 * @param v - Parsed JSON value.
 * @returns The format named by its `schema` member, or `null`.
 */
export function keyRingFormatOf(v: unknown): KeyRingFormat | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = (v as Record<string, unknown>)['schema'];
  return s === KEYRING_SCHEMA || s === BRIDGE_KEYRING_SCHEMA ? s : null;
}

/**
 * Chaves: campos fechados e regras do createKeyRing. Mensagens para leigo ("chave nº N" a partir de 1).
 *
 * @param list - The `keys` member of the file.
 * @throws {Error} With a message for non-specialists when an entry is invalid or the key ring rules fail.
 */
function validateEntries(list: unknown): PublicKeyEntry[] {
  if (!Array.isArray(list) || list.length === 0) throw new Error('o chaveiro não traz nenhuma chave');
  const keys: PublicKeyEntry[] = list.map((e, i) => {
    const n = `a chave nº ${i + 1} do chaveiro`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${n} não está no formato de chave`);
    const r = e as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!ENTRY_FIELDS.has(k)) throw new Error(`${n} tem um campo que não é permitido ("${k}")`);
    if (typeof r['keyId'] !== 'string' || !r['keyId']) throw new Error(`${n} não tem nome`);
    if (typeof r['address'] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r['address'])) throw new Error(`${n} tem endereço inválido`);
    if (r['status'] !== 'active' && r['status'] !== 'retired' && r['status'] !== 'revoked') throw new Error(`${n} tem estado inválido (só ativa, aposentada ou revogada)`);
    if (r['retiredAt'] !== undefined && (typeof r['retiredAt'] !== 'string' || !ISO_UTC.test(r['retiredAt']))) throw new Error(`${n} tem data de aposentadoria fora do padrão`);
    if (r['status'] !== 'retired' && r['retiredAt'] !== undefined) throw new Error(`${n} tem data de aposentadoria, mas não está aposentada`);
    const out: PublicKeyEntry = { keyId: r['keyId'], address: r['address'], status: r['status'] };
    if (r['retiredAt'] !== undefined) out.retiredAt = r['retiredAt'] as string;
    return out;
  });
  // regras de unicidade e retiredAt: as do createKeyRing (lança em caso de violação)
  try {
    createKeyRing(keys.map((k) => ({ ...k, address: k.address as `0x${string}` })));
  } catch (e) {
    throw new Error(`as chaves do chaveiro não seguem as regras (nome ou endereço repetido, ou aposentada sem data): ${e instanceof Error ? e.message : String(e)}`);
  }
  return keys;
}

/**
 * Valida a forma do chaveiro público (campos fechados: nada além de endereço e estado).
 *
 * @param v - Parsed JSON value.
 * @returns A new, validated key ring file object.
 * @throws {Error} When the format is unknown, a member is not allowed, or a key is invalid.
 */
export function validatePublicKeyRing(v: unknown): PublicKeyRingFile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(UNKNOWN_KEYRING_FORMAT);
  const o = v as Record<string, unknown>;
  if (o['schema'] !== KEYRING_SCHEMA) throw new Error(UNKNOWN_KEYRING_FORMAT);
  for (const k of Object.keys(o)) if (!FILE_FIELDS.has(k)) throw new Error(`o chaveiro tem um campo que não é permitido ("${k}")`);
  if (o['operator'] !== undefined && typeof o['operator'] !== 'string') throw new Error('o nome do operador no chaveiro tem de ser texto');
  const keys = validateEntries(o['keys']);
  const file: PublicKeyRingFile = { schema: KEYRING_SCHEMA, keys };
  if (typeof o['operator'] === 'string') file.operator = o['operator'];
  return file;
}

/**
 * Converte o anel público do bot (otk.bridge.keyring_file.v1) para otk.keyring.public.v1 sem perder
 * nada: cada chave leva keyId, endereço, estado e retiredAt exatamente como vieram, na mesma ordem.
 * O anel do bot não tem nome de operador; `operator` (opcional) é um rótulo que só o operador
 * escolhe e que entra nos bytes do chaveiro convertido (logo, na impressão digital dele).
 *
 * @param v - Parsed bot key ring file.
 * @param operator - Optional operator label to add.
 * @returns The converted, validated key ring file.
 * @throws {Error} When the format is unknown, a member is not allowed, a key is invalid, or `operator` is empty.
 */
export function convertBridgeKeyRing(v: unknown, operator?: string): PublicKeyRingFile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(UNKNOWN_KEYRING_FORMAT);
  const o = v as Record<string, unknown>;
  if (o['schema'] !== BRIDGE_KEYRING_SCHEMA) throw new Error(UNKNOWN_KEYRING_FORMAT);
  for (const k of Object.keys(o)) if (!BRIDGE_FILE_FIELDS.has(k)) throw new Error(`o anel do bot tem um campo que não é permitido ("${k}")`);
  const keys = validateEntries(o['keys']);
  const file: PublicKeyRingFile = { schema: KEYRING_SCHEMA, keys };
  if (operator !== undefined) {
    if (typeof operator !== 'string' || operator === '') throw new Error('o nome do operador tem de ser texto não vazio');
    file.operator = operator;
  }
  return validatePublicKeyRing(file);
}

/**
 * Bytes canônicos do chaveiro convertido a partir dos bytes do anel do bot (`otk keyring convert`).
 *
 * @param bytes - Bytes of the bot key ring file.
 * @param operator - Optional operator label to add.
 * @returns The canonical text of the converted key ring.
 * @throws {Error} When the bytes are not readable JSON, plus the errors of {@link convertBridgeKeyRing}.
 */
export function convertBridgeKeyRingBytes(bytes: Uint8Array, operator?: string): string {
  let v: unknown;
  try { v = JSON.parse(ethers.toUtf8String(bytes)); } catch { throw new Error(UNKNOWN_KEYRING_FORMAT); }
  return serializePublicKeyRing(convertBridgeKeyRing(v, operator));
}

/**
 * Lê o chaveiro carregado: otk.keyring.public.v1 ou o anel do bot (convertido). Formato que não é
 * nenhum dos dois (inclusive arquivo que não é JSON) → unknownFormat, com a mensagem
 * "formato de chaveiro não reconhecido" (não é sinal de adulteração).
 *
 * @param bytes - Bytes of the loaded key ring file.
 * @returns The parsed key ring or the reason it was refused; never throws.
 */
export function parsePublicKeyRing(bytes: Uint8Array): ParsedKeyRing {
  const fingerprint = sha256Hex(bytes);
  let v: unknown;
  try {
    v = JSON.parse(ethers.toUtf8String(bytes));
  } catch {
    return { ok: false, error: `${UNKNOWN_KEYRING_FORMAT}: o arquivo não é um JSON legível`, fingerprint, unknownFormat: true };
  }
  const format = keyRingFormatOf(v);
  if (format === null) {
    return { ok: false, error: `${UNKNOWN_KEYRING_FORMAT}: este verificador lê o chaveiro público do OTK e o anel público do bot`, fingerprint, unknownFormat: true };
  }
  try {
    const file = format === BRIDGE_KEYRING_SCHEMA ? convertBridgeKeyRing(v) : validatePublicKeyRing(v);
    const ring = createKeyRing(file.keys.map((k) => ({ ...k, address: k.address as `0x${string}` })));
    return { ok: true, file, ring, fingerprint, format };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), fingerprint, unknownFormat: false };
  }
}

/**
 * Bytes canônicos do chaveiro público (lado do operador: `otk keyring export`).
 *
 * @param file - Key ring file to write.
 * @returns Indented JSON with checksummed addresses and a final newline.
 * @throws {Error} The validation errors of {@link validatePublicKeyRing}, or an invalid address.
 */
export function serializePublicKeyRing(file: PublicKeyRingFile): string {
  const f = validatePublicKeyRing(file);
  const keys = f.keys.map((k) => {
    const o: Record<string, string> = { keyId: k.keyId, address: ethers.getAddress(k.address), status: k.status };
    if (k.retiredAt !== undefined) o['retiredAt'] = k.retiredAt;
    return o;
  });
  const out: Record<string, unknown> = { schema: KEYRING_SCHEMA };
  if (f.operator !== undefined) out['operator'] = f.operator;
  out['keys'] = keys;
  return JSON.stringify(out, null, 2) + '\n';
}
