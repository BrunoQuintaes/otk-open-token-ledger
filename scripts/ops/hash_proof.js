#!/usr/bin/env node
/**
 * hash_proof.js — SHA-256 hash of zk/build/proof.json (A6.7)
 *
 * Computes a deterministic hash of the proof artifact for integrity verification.
 *
 * Output: { proofHash, timestamp, circuitVersion, proofPath }
 *
 * Usage: node scripts/ops/hash_proof.js [path/to/proof.json]
 *
 * @since A6.7 — Wave 1 Pack 12
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const DEFAULT_PROOF_PATH = path.join(ROOT, 'zk/build/proof.json');

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of a file's contents.
 * @param {string} filePath Absolute path to the file
 * @returns {string} Hex-encoded SHA-256 hash
 */
function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detect circuit version from proof.json or nearby public.json.
 * Heuristic: check for v2 signals (minUsageBucket/maxUsageBucket) in public.json.
 * @param {string} proofDir Directory containing proof.json
 * @returns {string} 'v1' | 'v2' | 'unknown'
 */
function detectCircuitVersion(proofDir) {
  const publicPath = path.join(proofDir, 'public.json');
  if (!fs.existsSync(publicPath)) return 'unknown';

  try {
    const pubSignals = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
    // v2 has 4 public signals (commitment, epoch, minUsageBucket, maxUsageBucket)
    // v1 has 3 public signals (commitment, epoch, maxUsage)
    if (Array.isArray(pubSignals)) {
      if (pubSignals.length === 4) return 'v2';
      if (pubSignals.length === 3) return 'v1';
    }
  } catch { /* ignore parse errors */ }

  return 'unknown';
}

// ─── Main ──────────────────────────────────────────────────────────────

/**
 * Generate a proof hash record.
 * @param {string} [proofPath] Path to proof.json (default: zk/build/proof.json)
 * @returns {{ proofHash: string, timestamp: string, circuitVersion: string, proofPath: string }}
 */
function hashProof(proofPath = DEFAULT_PROOF_PATH) {
  if (!fs.existsSync(proofPath)) {
    throw new Error(`Proof file not found: ${proofPath}`);
  }

  const proofHash = sha256File(proofPath);
  const timestamp = new Date().toISOString();
  const circuitVersion = detectCircuitVersion(path.dirname(proofPath));

  return {
    proofHash,
    timestamp,
    circuitVersion,
    proofPath: path.relative(ROOT, proofPath),
  };
}

// Export for programmatic use
export { hashProof, sha256File, detectCircuitVersion };

// Run if invoked directly
const isMain = process.argv[1] &&
  (process.argv[1].endsWith('hash_proof.js') ||
   process.argv[1] === fileURLToPath(import.meta.url));

if (isMain) {
  const proofPath = process.argv[2] || DEFAULT_PROOF_PATH;

  try {
    const result = hashProof(proofPath);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
