/**
 * EVM bytecode helpers shared by the PUSH0 detectors (detect_push0.js, check_berlin_compliance.mjs).
 *
 * solc appends a CBOR metadata trailer to the runtime code: <cbor map> <2-byte big-endian length>.
 * The trailer is never executed, but it holds a source hash (IPFS/bzzr) whose bytes are random, so a
 * 0x5f byte there was reported as a PUSH0 opcode (request A 20260930-2217). The trailer is skipped only
 * when the declared length fits and the first trailer byte is a CBOR map header (0xa0–0xbf); otherwise
 * the whole code is scanned, as before. Limitation: trailers of contracts embedded by `new X()` sit in
 * the middle of the creation code and are still scanned (conservative: can only over-report).
 */

/** End offset (exclusive) of the executable part of `bytes`, excluding a well-formed metadata trailer. */
export function executableEnd(bytes) {
  if (bytes.length < 2) return bytes.length;
  const metaLen = bytes.readUInt16BE(bytes.length - 2);
  const start = bytes.length - 2 - metaLen;
  if (metaLen === 0 || start < 0) return bytes.length;
  const head = bytes[start];
  if (head < 0xa0 || head > 0xbf) return bytes.length;
  return start;
}

/**
 * Offsets where 0x5f appears as an OPCODE in the executable part of `hex`.
 * PUSH1..PUSH32 operand bytes are skipped; the metadata trailer is not scanned.
 */
export function findPush0Opcodes(hex) {
  if (!hex || typeof hex !== 'string' || hex === '0x') return [];
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) return [];
  const bytes = Buffer.from(h, 'hex');
  const end = executableEnd(bytes);
  const positions = [];
  for (let i = 0; i < end; ) {
    const op = bytes[i];
    if (op === 0x5f) { positions.push(i); i += 1; }
    else if (op >= 0x60 && op <= 0x7f) i += 1 + (op - 0x5f);
    else i += 1;
  }
  return positions;
}
