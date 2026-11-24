#!/usr/bin/env bash
# zk_prove.sh — Generate witness + Groth16 proof for metering_v1
#
# Prerequisites:
#   - Circuit built (zk_build.sh)
#   - zkey finalized (metering_v1_final.zkey in zk/build/)
#   - snarkjs installed (npm i -g snarkjs)
#
# Usage: bash scripts/zk/zk_prove.sh [input.json]
#   Default input: zk/build/input.json

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$REPO_ROOT/zk/build"
INPUT="${1:-$BUILD/input.json}"

WASM="$BUILD/metering_v1_js/metering_v1.wasm"
ZKEY="$BUILD/metering_v1_final.zkey"
WITNESS="$BUILD/metering_witness.wtns"
PROOF="$BUILD/proof.json"
PUBLIC="$BUILD/public.json"

echo "═══════════════════════════════════════════"
echo "  ZK Prove — metering_v1 (Groth16)"
echo "═══════════════════════════════════════════"
echo "  Input:   $INPUT"
echo "  WASM:    $WASM"
echo "  ZKey:    $ZKEY"
echo ""

for f in "$WASM" "$ZKEY" "$INPUT"; do
  [[ -f "$f" ]] || { echo "❌ Missing: $f"; exit 1; }
done

if ! command -v snarkjs &>/dev/null; then
  echo "❌ snarkjs not found. Install: npm i -g snarkjs"
  exit 1
fi

echo "Step 1/2 — Generating witness..."
node "$REPO_ROOT/scripts/zk/generate_witness.cjs" "$WASM" "$INPUT" "$WITNESS"

echo "Step 2/2 — Generating Groth16 proof..."
snarkjs groth16 prove "$ZKEY" "$WITNESS" "$PROOF" "$PUBLIC"

echo ""
echo "✅ Proof generated."
echo "   proof.json:  $PROOF"
echo "   public.json: $PUBLIC"
echo ""
echo "pubSignals order (metering_v1):"
echo "  [0] commitment  [1] epoch  [2] maxUsage"
echo ""
echo "Next: bash scripts/zk/zk_verify.sh"
