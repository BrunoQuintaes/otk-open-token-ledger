/**
 * Reads image dimensions from a PNG header, without an image library; used by the image estimators.
 *
 * @module scripts/h2eval/modal/estimators/png_dims
 */
/** Width/height from a PNG IHDR chunk (no image library). Returns null when the buffer is not a PNG. */
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * Reads width and height from the IHDR chunk of a PNG.
 *
 * @param buf - File bytes.
 * @returns Width and height in pixels, or `null` when the bytes are not a PNG with a non-zero IHDR size.
 */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
