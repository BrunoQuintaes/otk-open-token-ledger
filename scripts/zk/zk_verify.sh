#!/usr/bin/env bash
# zk_verify.sh — Verify a Groth16 proof for metering_v1
#
# Prerequisites: snarkjs installed (npm i -g snarkjs)
# Usage: bash scripts/zk/zk_verify.sh [verification_key.json] [public.json] [proof.json]
# Exit codes: 0 the proof is valid; non-zero when a file or snarkjs is missing or the proof is invalid
#   (snarkjs' own exit code, because set -e stops the script there). Read-only.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$REPO_ROOT/zk/build"

VKEY="${1:-$BUILD/verification_key.json}"
PUBLIC="${2:-$BUILD/public.json}"
PROOF="${3:-$BUILD/proof.json}"

echo "═══════════════════════════════════════════"
echo "  ZK Verify — metering_v1 (Groth16)"
echo "═══════════════════════════════════════════"
echo "  VKey:   $VKEY"
echo "  Public: $PUBLIC"
echo "  Proof:  $PROOF"
echo ""

for f in "$VKEY" "$PUBLIC" "$PROOF"; do
  [[ -f "$f" ]] || { echo "❌ Missing: $f"; exit 1; }
done

if ! command -v snarkjs &>/dev/null; then
  echo "❌ snarkjs not found. Install: npm i -g snarkjs"
  exit 1
fi

# Export vkey from zkey if not present
if [[ ! -f "$VKEY" ]]; then
  ZKEY="$BUILD/metering_v1_final.zkey"
  echo "⚠️  verification_key.json not found — exporting from zkey..."
  snarkjs zkey export verificationkey "$ZKEY" "$VKEY"
fi

snarkjs groth16 verify "$VKEY" "$PUBLIC" "$PROOF"
STATUS=$?

echo ""
if [[ $STATUS -eq 0 ]]; then
  echo "✅ Proof is VALID."
else
  echo "❌ Proof is INVALID."
  exit 1
fi
