#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZK_DIR="$ROOT/zk"
CIRCUITS_DIR="$ZK_DIR/circuits"
BUILD_DIR="$ZK_DIR/build"
LOG_DIR="$ROOT/docs/_ops/u8"
TS="$(date +"%Y%m%d_%H%M%S")"

mkdir -p "$BUILD_DIR"
mkdir -p "$LOG_DIR"

CIRCUIT="$CIRCUITS_DIR/metering_v1.circom"
NAME="metering_v1"
INPUT_JSON="$BUILD_DIR/metering_input.json"

LOG="$LOG_DIR/U8_2_CIRCUIT_${TS}_run_metering_demo.log"
exec > >(tee -a "$LOG") 2>&1

echo "=== U8.2 metering demo ==="
echo "ROOT=$ROOT"
echo "CIRCUIT=$CIRCUIT"
echo "INPUT=$INPUT_JSON"

# Guardrails
command -v circom >/dev/null 2>&1 || { echo "ERR: circom not found"; exit 10; }
command -v snarkjs >/dev/null 2>&1 || { echo "ERR: snarkjs not found"; exit 11; }
command -v node   >/dev/null 2>&1 || { echo "ERR: node not found"; exit 12; }

test -f "$CIRCUIT" || { echo "ERR: missing circuit file"; exit 13; }
test -f "$INPUT_JSON" || { echo "ERR: missing input json"; exit 14; }

cd "$BUILD_DIR"

# Compile circuit
echo "--- compile ---"
circom "$CIRCUIT" --r1cs --wasm --sym -o "$BUILD_DIR"

# Inspect constraints (informational)
echo "--- r1cs info ---"
snarkjs r1cs info "$BUILD_DIR/${NAME}.r1cs" || true

# Witness
echo "--- witness ---"
node "$BUILD_DIR/${NAME}_js/generate_witness.js" "$BUILD_DIR/${NAME}_js/${NAME}.wasm" "$INPUT_JSON" "$BUILD_DIR/witness.wtns"

# Setup (Powers of Tau)
# NOTE: demo uses small pot; may need pot13/pot14 depending on constraints.
POT="$BUILD_DIR/pot12_final.ptau"
if [ ! -f "$POT" ]; then
  echo "--- powersoftau (pot12) ---"
  snarkjs powersoftau new bn128 12 "$BUILD_DIR/pot12_0000.ptau" -v
  snarkjs powersoftau contribute "$BUILD_DIR/pot12_0000.ptau" "$BUILD_DIR/pot12_0001.ptau" --name="first contribution" -v -e="random"
  snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot12_0001.ptau" "$POT" -v
fi

# Groth16 setup
echo "--- groth16 setup ---"
snarkjs groth16 setup "$BUILD_DIR/${NAME}.r1cs" "$POT" "$BUILD_DIR/${NAME}_0000.zkey"
snarkjs zkey contribute "$BUILD_DIR/${NAME}_0000.zkey" "$BUILD_DIR/${NAME}_final.zkey" --name="1st contributor" -v -e="random"
snarkjs zkey export verificationkey "$BUILD_DIR/${NAME}_final.zkey" "$BUILD_DIR/verification_key.json"

# Prove
echo "--- prove ---"
snarkjs groth16 prove "$BUILD_DIR/${NAME}_final.zkey" "$BUILD_DIR/witness.wtns" "$BUILD_DIR/proof.json" "$BUILD_DIR/public.json"

# Verify
echo "--- verify ---"
snarkjs groth16 verify "$BUILD_DIR/verification_key.json" "$BUILD_DIR/public.json" "$BUILD_DIR/proof.json"

echo "OK: metering demo completed."
echo "NOTE: public.json ordering (outputs first): [commitment, epoch, maxUsage]"
