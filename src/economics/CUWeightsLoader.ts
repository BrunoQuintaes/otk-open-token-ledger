/**
 * CUWeightsLoader — Dynamic CU Weights Governance (ADR-0203 Phase 1)
 *
 * Loads a versioned, EIP-191-signed JSON file (v1 schema).
 *
 * D5 / S0-F01: the v1 schema (inputWeight/outputWeight/latencyWeight per model) expresses a
 * weighted sum and is no longer used to compute CU (CUEngine.computePublishedCUWithCW refuses
 * it). It is still parsed by cwRuntime, whose version string current consumers record. The
 * multiplicative schema is otk.cu_weights.v2 (cuWeightsV2.ts, cuWeightsRuntimeV2.ts).
 *
 * Phase 1 (this implementation): JSON signed by single operator key.
 * Phase 2 (roadmap): Multisig 2/3 or 3/5 approval.
 * Phase 3 (roadmap): DAO on-chain governance.
 *
 * JSON schema (CW JSON):
 * {
 *   "version": "2.0.0",
 *   "validFrom": "2026-01-01T00:00:00Z",
 *   "validUntil": "2026-12-31T23:59:59Z",
 *   "weights": {
 *     "openai": {
 *       "gpt-4o": { "inputWeight": 1.2, "outputWeight": 2.4, "latencyWeight": 0.001 }
 *     }
 *   },
 *   "signedBy": "0x...",
 *   "signature": "0x..."
 * }
 *
 * Invariants (CORE.md §1):
 *   - CU ≠ USD: weights are normalization ratios, not prices
 *   - CUEngine remains deterministic given the same CW JSON
 *   - Receipts validated against the CW version at time of issuance
 *
 * @module economics/CUWeightsLoader
 * @since U12.POST-CLAIM-CLOSURE (ADR-0203 Phase 1)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelWeights = {
  inputWeight: number;
  outputWeight: number;
  latencyWeight: number;
};

export type ProviderWeights = Record<string, ModelWeights>;

export type CWJson = {
  version: string;
  validFrom: string;
  validUntil: string;
  weights: Record<string, ProviderWeights>;
  signedBy: string;
  signature: string;
};

export type CWLoadResult =
  | { ok: true; cw: CWJson }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate CW JSON structure and temporal validity.
 * Does NOT verify the EIP-191 signature (requires ethers — import at call site).
 */
export function validateCWJson(raw: unknown): CWLoadResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'CW JSON must be an object' };
  }
  const cw = raw as Record<string, unknown>;

  if (typeof cw['version'] !== 'string') return { ok: false, error: 'missing version' };
  if (typeof cw['validFrom'] !== 'string') return { ok: false, error: 'missing validFrom' };
  if (typeof cw['validUntil'] !== 'string') return { ok: false, error: 'missing validUntil' };
  if (typeof cw['weights'] !== 'object' || !cw['weights']) return { ok: false, error: 'missing weights' };
  if (typeof cw['signedBy'] !== 'string') return { ok: false, error: 'missing signedBy' };
  if (typeof cw['signature'] !== 'string') return { ok: false, error: 'missing signature' };

  const now = new Date();
  const validFrom = new Date(cw['validFrom'] as string);
  const validUntil = new Date(cw['validUntil'] as string);

  if (isNaN(validFrom.getTime())) return { ok: false, error: 'invalid validFrom date' };
  if (isNaN(validUntil.getTime())) return { ok: false, error: 'invalid validUntil date' };
  if (now < validFrom) return { ok: false, error: `CW not yet valid (validFrom: ${cw['validFrom']})` };
  if (now > validUntil) return { ok: false, error: `CW expired (validUntil: ${cw['validUntil']})` };

  // Validate weights structure
  const weights = cw['weights'] as Record<string, unknown>;
  for (const [provider, models] of Object.entries(weights)) {
    if (typeof models !== 'object' || !models) {
      return { ok: false, error: `weights.${provider} must be an object` };
    }
    for (const [model, mw] of Object.entries(models as Record<string, unknown>)) {
      if (typeof mw !== 'object' || !mw) {
        return { ok: false, error: `weights.${provider}.${model} must be an object` };
      }
      const w = mw as Record<string, unknown>;
      for (const field of ['inputWeight', 'outputWeight', 'latencyWeight']) {
        if (typeof w[field] !== 'number' || !Number.isFinite(w[field]) || (w[field] as number) < 0) {
          return { ok: false, error: `weights.${provider}.${model}.${field} must be a non-negative number` };
        }
      }
    }
  }

  return { ok: true, cw: cw as unknown as CWJson };
}

/**
 * Load CW JSON from a plain object (e.g., parsed from file or API response).
 * Falls back to null if invalid, allowing callers to use static weights.
 *
 * @param raw - Parsed JSON object (use JSON.parse before calling)
 * @param opts - Options
 * @param opts.strict - If true, throw on validation failure instead of returning null
 */
export function loadCWJson(raw: unknown, opts: { strict?: boolean } = {}): CWJson | null {
  const result = validateCWJson(raw);
  if (result.ok) return result.cw;
  if (opts.strict) throw new Error(`CW JSON invalid: ${result.error}`);
  return null;
}

/**
 * Extract model weights from a loaded CWJson for a given provider+model.
 * Returns null if the provider/model is not in the CW JSON (caller uses static fallback).
 */
export function getModelWeights(cw: CWJson, provider: string, model: string): ModelWeights | null {
  return cw.weights[provider]?.[model] ?? null;
}

/**
 * Deterministic JSON: object keys sorted at every depth, no whitespace.
 * Throws on values JSON cannot represent faithfully (NaN/Infinity → null collision).
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CW canonical form: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`CW canonical form: unsupported type ${typeof value}`);
}

/**
 * Build the canonical message that was signed (for EIP-191 verification).
 * Format: "CW-WEIGHTS-V2:" + canonicalJson({ signedBy, validFrom, validUntil, version, weights })
 *
 * V2 covers every weight value, model and provider name (R01). V1 serialized weights
 * with an array replacer that dropped all nested keys, so its signature did not bind
 * the weight values; V1 messages are no longer produced or accepted.
 *
 * Note: actual signature verification requires ethers.verifyMessage — do this at integration point.
 */
export function buildSignedMessage(cw: CWJson): string {
  const body = canonicalJson({
    signedBy: cw.signedBy.toLowerCase(),
    validFrom: cw.validFrom,
    validUntil: cw.validUntil,
    version: cw.version,
    weights: cw.weights,
  });
  return `CW-WEIGHTS-V2:${body}`;
}

/**
 * Trusted CW signers whitelist (ADR-0203 Phase 1 security hardening — GAP-B-003).
 *
 * Populated from OTK_TRUSTED_SIGNERS env (comma-separated lowercase Ethereum addresses).
 * If unset: dev-mode fallback (match cw.signedBy only — NOT for production).
 * In production, OTK_TRUSTED_SIGNERS MUST be set.
 *
 * Example: OTK_TRUSTED_SIGNERS=0xabc...def,0x123...456
 */
export const TRUSTED_CW_SIGNERS: readonly string[] = (process.env['OTK_TRUSTED_SIGNERS'] ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Verify the EIP-191 signature on a CW JSON (ADR-0203 Phase 1 integrity).
 *
 * Security model:
 *   1. Recovers signer address from cw.signature via ethers.verifyMessage.
 *   2. If OTK_TRUSTED_SIGNERS is set: recovered signer MUST be in the whitelist.
 *      Prevents acceptance of CW JSON signed by any arbitrary key.
 *   3. If OTK_TRUSTED_SIGNERS is unset (dev mode): matches cw.signedBy only.
 *   4. Explicit expectedSigner overrides the whitelist check.
 *
 * @param cw             Loaded and validated CW JSON
 * @param expectedSigner Optional explicit signer address to enforce (overrides whitelist)
 * @returns true if signature is valid and signer is trusted; false on any error
 */
export async function verifyCWSignature(
  cw: CWJson,
  expectedSigner?: string,
): Promise<boolean> {
  try {
    const { ethers } = await import('ethers');
    const message = buildSignedMessage(cw);
    const recovered = ethers.verifyMessage(message, cw.signature);
    const recoveredLower = recovered.toLowerCase();

    // Explicit override takes precedence
    if (expectedSigner) return recoveredLower === expectedSigner.toLowerCase();

    // Production: whitelist enforcement
    if (TRUSTED_CW_SIGNERS.length > 0) return TRUSTED_CW_SIGNERS.includes(recoveredLower);

    // Dev mode fallback: match cw.signedBy (no whitelist configured)
    return recoveredLower === cw.signedBy.toLowerCase();
  } catch {
    return false;
  }
}
