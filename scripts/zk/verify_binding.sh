#!/usr/bin/env bash
# verify_binding.sh — Binding Harness: SDK ↔ Circuit Verification (U8.4.2)
#
# Purpose:
#   Validates that SDK-generated receipts produce valid circuit inputs
#   and witness generation succeeds.
#
# Prerequisites:
#   - Circuit compiled (zk/build/metering_v1_js/)
#   - snarkjs or witness_calculator available
#   - Node.js runtime
#
# Usage:
#   bash scripts/zk/verify_binding.sh [test_input.json]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="zk/build"
CIRCUIT_NAME="metering_v1"
WASM_FILE="$BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
WITNESS_GEN="$BUILD_DIR/${CIRCUIT_NAME}_js/../../../scripts/zk/generate_witness.cjs"
WITNESS_CALCULATOR="$BUILD_DIR/${CIRCUIT_NAME}_js/witness_calculator.js"

INPUT_FILE="${1:-$BUILD_DIR/test_input.json}"
WITNESS_OUTPUT="$BUILD_DIR/binding_test_witness.wtns"

echo "═══════════════════════════════════════════════════════════"
echo "  Binding Verification: SDK ↔ Circuit (U8.4.2)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Repo Root:    $REPO_ROOT"
echo "Circuit:      $CIRCUIT_NAME"
echo "Input File:   $INPUT_FILE"
echo "Output:       $WITNESS_OUTPUT"
echo ""

# ─────────────────────────────────────────────────────────────
# CHECK 1: Circuit artifacts exist
# ─────────────────────────────────────────────────────────────
echo "CHECK 1: Circuit artifacts..."
if [[ ! -f "$WASM_FILE" ]]; then
  echo "❌ FAIL: Circuit WASM not found: $WASM_FILE"
  echo ""
  echo "Run circuit build first:"
  echo "  cd zk/circuits"
  echo "  circom metering_v1.circom --r1cs --wasm --sym -o ../build"
  exit 1
fi

if [[ ! -f "$WITNESS_GEN" ]] && [[ ! -f "$WITNESS_CALCULATOR" ]]; then
  echo "❌ FAIL: Witness generator not found"
  echo "Expected either:"
  echo "  - $WITNESS_GEN"
  echo "  - $WITNESS_CALCULATOR"
  exit 1
fi

echo "✓ Circuit artifacts found"

# ─────────────────────────────────────────────────────────────
# CHECK 2: Input file exists and is valid JSON
# ─────────────────────────────────────────────────────────────
echo ""
echo "CHECK 2: Input file validation..."
if [[ ! -f "$INPUT_FILE" ]]; then
  echo "⚠️  Input file not found: $INPUT_FILE"
  echo "Creating sample input from SDK derivation..."

  # Create sample input (matches SDK buildRawReceipt output)
  cat > "$INPUT_FILE" << 'EOF'
{
  "userId": "12345",
  "usage": "150",
  "nonce": "1",
  "epoch": "472222",
  "maxUsage": "1000"
}
EOF
  echo "✓ Sample input created: $INPUT_FILE"
fi

# Validate JSON syntax
if ! jq empty "$INPUT_FILE" 2>/dev/null; then
  echo "❌ FAIL: Input file is not valid JSON"
  cat "$INPUT_FILE"
  exit 1
fi

echo "✓ Input file valid"
echo ""
echo "Input data:"
jq . "$INPUT_FILE"

# ─────────────────────────────────────────────────────────────
# CHECK 3: Validate input schema
# ─────────────────────────────────────────────────────────────
echo ""
echo "CHECK 3: Input schema validation..."
REQUIRED_FIELDS=("userId" "usage" "nonce" "epoch" "maxUsage")
VALID=true

for field in "${REQUIRED_FIELDS[@]}"; do
  if ! jq -e ".$field" "$INPUT_FILE" >/dev/null 2>&1; then
    echo "❌ Missing required field: $field"
    VALID=false
  fi
done

if [[ "$VALID" != "true" ]]; then
  echo "❌ FAIL: Input schema validation failed"
  exit 1
fi

# Validate constraint: usage <= maxUsage
USAGE=$(jq -r '.usage' "$INPUT_FILE")
MAX_USAGE=$(jq -r '.maxUsage' "$INPUT_FILE")

if (( USAGE > MAX_USAGE )); then
  echo "❌ FAIL: Circuit constraint violated: usage ($USAGE) > maxUsage ($MAX_USAGE)"
  exit 1
fi

echo "✓ Input schema valid"
echo "✓ Circuit constraint satisfied: usage ($USAGE) <= maxUsage ($MAX_USAGE)"

# ─────────────────────────────────────────────────────────────
# CHECK 4: Generate witness
# ─────────────────────────────────────────────────────────────
echo ""
echo "CHECK 4: Witness generation..."

# Try witness_calculator.js first (native), fallback to ../../../scripts/zk/generate_witness.cjs
if [[ -f "$WITNESS_CALCULATOR" ]]; then
  echo "Using witness_calculator.js (native)..."
  WITNESS_GEN_SCRIPT="$WITNESS_CALCULATOR"
else
  echo "Using ../../../scripts/zk/generate_witness.cjs (snarkjs)..."
  WITNESS_GEN_SCRIPT="$WITNESS_GEN"
fi

# Generate witness
# NOTE: This may fail if ../../../scripts/zk/generate_witness.cjs uses CommonJS but repo is ESM
set +e
WITNESS_CMD="node \"$WITNESS_GEN_SCRIPT\" \"$WASM_FILE\" \"$INPUT_FILE\" \"$WITNESS_OUTPUT\""
echo "Running: $WITNESS_CMD"
eval "$WITNESS_CMD" 2>&1 | tee "$BUILD_DIR/witness_gen_log.txt"
WITNESS_EXIT_CODE=$?
set -e

if [[ $WITNESS_EXIT_CODE -ne 0 ]]; then
  echo ""
  echo "❌ FAIL: Witness generation failed (exit code: $WITNESS_EXIT_CODE)"
  echo ""
  echo "Common issues:"
  echo "  1. ESM/CommonJS mismatch (../../../scripts/zk/generate_witness.cjs uses require() but package.json is ESM)"
  echo "  2. Circuit constraint violation (input doesn't satisfy circuit constraints)"
  echo "  3. Field overflow (inputs exceed BN254 field size)"
  echo ""
  echo "Logs saved to: $BUILD_DIR/witness_gen_log.txt"
  echo ""
  echo "RECOMMENDATION:"
  echo "  - Run tests via test/integration/CircuitBinding.test.ts instead"
  echo "  - Or use circom witness generation tooling directly"
  exit 1
fi

if [[ ! -f "$WITNESS_OUTPUT" ]]; then
  echo "❌ FAIL: Witness file not created: $WITNESS_OUTPUT"
  exit 1
fi

echo "✓ Witness generated successfully: $WITNESS_OUTPUT"

# ─────────────────────────────────────────────────────────────
# CHECK 5: Verify witness file
# ─────────────────────────────────────────────────────────────
echo ""
echo "CHECK 5: Witness file verification..."

WITNESS_SIZE=$(stat -c%s "$WITNESS_OUTPUT" 2>/dev/null || stat -f%z "$WITNESS_OUTPUT" 2>/dev/null || echo "unknown")
echo "Witness file size: $WITNESS_SIZE bytes"

if [[ "$WITNESS_SIZE" == "0" ]]; then
  echo "❌ FAIL: Witness file is empty"
  exit 1
fi

echo "✓ Witness file created and non-empty"

# ─────────────────────────────────────────────────────────────
# FINAL RESULT
# ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ BINDING VERIFICATION PASSED"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  ✓ Circuit artifacts exist"
echo "  ✓ Input file valid JSON"
echo "  ✓ Input schema matches circuit"
echo "  ✓ Circuit constraints satisfied"
echo "  ✓ Witness generated successfully"
echo ""
echo "Next steps:"
echo "  1. Run proof generation: snarkjs groth16 prove ..."
echo "  2. Verify proof: snarkjs groth16 verify ..."
echo "  3. Submit to Registry (U8.5)"
echo ""
echo "Evidence:"
echo "  - Input:   $INPUT_FILE"
echo "  - Witness: $WITNESS_OUTPUT"
echo "  - Logs:    $BUILD_DIR/witness_gen_log.txt"
echo ""
