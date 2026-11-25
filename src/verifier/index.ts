/**
 * Interface pública do verificador offline de recibos OTK (desenho §3(a), VERIFICADOR_MVP C160).
 * Sem dependência de Node (nada de node:fs/node:crypto): bundle para o navegador pelo esbuild.
 *
 *   verifyBundle(input, keyRing, opts) → VerificationReport (schema otk.verification_report.v1)
 *   serializeReport / reportSha256     → bytes e sha256 determinísticos (paridade comando × página)
 *   reportToCsv / renderHuman          → planilha e saída de terminal
 *   parsePublicKeyRing / serializePublicKeyRing → chaveiro otk.keyring.public.v1 (impressão digital = sha256 do arquivo)
 *   convertBridgeKeyRing(Bytes)        → anel público do bot (otk.bridge.keyring_file.v1) convertido sem perda
 *
 * (English) Public API of the offline OTK receipt verifier. It only re-exports; the same code runs in Node
 * (the `otk verify` command in `scripts/verify/otk.ts`) and in the browser (esbuild bundle), so nothing in
 * this folder may import Node modules.
 *
 * @module src/verifier/index
 */
export { verifyBundle, verifyBundleDetailed, VerifierUsageError, VERIFIER_VERSION } from './core.js';
export { serializeReport, reportSha256, reportToCsv, renderHuman } from './report.js';
export {
  KEYRING_SCHEMA, parsePublicKeyRing, serializePublicKeyRing, validatePublicKeyRing, normalizeFingerprint, isValidFingerprint, sha256Hex,
  BRIDGE_KEYRING_SCHEMA, UNKNOWN_KEYRING_FORMAT, convertBridgeKeyRing, convertBridgeKeyRingBytes, keyRingFormatOf,
} from './keyring.js';
export type { ParsedKeyRing, KeyRingFormat } from './keyring.js';
export { TEXTOS, NAO_GARANTE, VERDICT_LABEL } from './textos.js';
export type { CodeText } from './textos.js';
export type * from './types.js';
