#!/usr/bin/env bash
# =============================================================================
# 03_finalize.sh — Phase 1 finalize + Phase 2 (circuit-specific) setup
#
# Usage:
#   bash scripts/setup/03_finalize.sh [POWER] [PHASE1_DIR] [CIRCUIT_DIR]
#
# Arguments:
#   POWER       — Tau power (default: 12)
#   PHASE1_DIR  — Directory with ptau contributions (default: zk/ceremony/phase1)
#   CIRCUIT_DIR — Directory with compiled circuit (default: zk/build)
#
# Outputs:
#   <PHASE1_DIR>/pot<POWER>_final.ptau    — finalized Phase 1 ptau
#   <CIRCUIT_DIR>/metering_v1_0000.zkey   — initial Phase 2 zkey
#   <CIRCUIT_DIR>/metering_v1_final.zkey  — finalized zkey (after Phase 2 contribution)
#   <CIRCUIT_DIR>/verification_key.json   — exported verification key for Solidity
#   <CIRCUIT_DIR>/MeteringVerifier.sol    — Solidity verifier contract
#
# Environment: CEREMONY_BEACON (hex beacon for the Phase 1 finalize; a fixed, public development value when
#   unset) and PHASE2_ENTROPY (Phase 2 entropy; read from /dev/urandom when unset). Development setup only:
#   a single Phase 2 participant. The Solidity verifier is written as MeteringVerifier_generated.sol.
#   Requires git and snarkjs. Exit code 1 when no Phase 1 contribution or the R1CS file is found.
# =============================================================================

set -euo pipefail

POWER="${1:-12}"
PHASE1_DIR="${2:-zk/ceremony/phase1}"
CIRCUIT_DIR="${3:-zk/build}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

cd "$REPO_ROOT"

echo "== OTK Trusted Setup — Finalize Phase 1 + Phase 2 =="

LOG="$PHASE1_DIR/ceremony_log.txt"

# --- Detect last contribution ---
LAST_IDX=$(ls "$PHASE1_DIR"/pot${POWER}_*.ptau 2>/dev/null | grep -oP '(?<=pot'${POWER}'_)\d+' | grep -v 'final' | sort -n | tail -1 || echo "")
if [ -z "$LAST_IDX" ]; then
  # Try to use existing ptau from build directory
  if [ -f "$CIRCUIT_DIR/pot${POWER}_final.ptau" ]; then
    echo "Using existing finalized ptau from $CIRCUIT_DIR"
    FINAL_PTAU="$CIRCUIT_DIR/pot${POWER}_final.ptau"
  else
    echo "ERROR: No contributions found in $PHASE1_DIR and no fallback in $CIRCUIT_DIR" >&2
    exit 1
  fi
else
  LAST_PTAU="$PHASE1_DIR/pot${POWER}_$(printf '%04d' $((10#$LAST_IDX))).ptau"

  # Step 1: Apply random beacon
  echo "Step 1: Apply random beacon (Phase 1 finalize) ..."
  # Beacon: use current block hash or fixed known value for reproducibility
  # In production, use a public randomness beacon (drand, Ethereum block hash, etc.)
  BEACON="${CEREMONY_BEACON:-0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20}"
  FINAL_PTAU="$PHASE1_DIR/pot${POWER}_final.ptau"
  snarkjs powersoftau beacon "$LAST_PTAU" "$FINAL_PTAU" \
    "$BEACON" 10 --name="Final Beacon" -v 2>&1 | tee -a "$LOG"

  # Step 2: Prepare for Phase 2
  PREP_PTAU="$PHASE1_DIR/pot${POWER}_final_prep.ptau"
  echo "Step 2: Prepare phase 2 ..."
  snarkjs powersoftau preparephase2 "$FINAL_PTAU" "$PREP_PTAU" -v 2>&1 | tee -a "$LOG"
  FINAL_PTAU="$PREP_PTAU"
fi

# --- Phase 2: Circuit-specific setup ---
R1CS="$CIRCUIT_DIR/metering_v1.r1cs"
ZKEY_0="$CIRCUIT_DIR/metering_v1_0000.zkey"
ZKEY_FINAL="$CIRCUIT_DIR/metering_v1_final.zkey"
VK_JSON="$CIRCUIT_DIR/verification_key.json"

if [ ! -f "$R1CS" ]; then
  echo "ERROR: R1CS not found: $R1CS" >&2
  echo "Compile the circuit first: cd zk && circom circuits/metering_v1.circom --r1cs --wasm" >&2
  exit 1
fi

echo "Step 3: Phase 2 setup for metering_v1 ..."
snarkjs groth16 setup "$R1CS" "$FINAL_PTAU" "$ZKEY_0" 2>&1 | tee -a "$LOG"

echo "Step 4: Phase 2 contribution (single-participant for development) ..."
# In production, multiple participants should contribute to Phase 2
PHASE2_ENTROPY="${PHASE2_ENTROPY:-$(head -c 32 /dev/urandom | base64 2>/dev/null || echo 'dev-placeholder-entropy')}"
echo "$PHASE2_ENTROPY" | snarkjs zkey contribute "$ZKEY_0" "$ZKEY_FINAL" \
  --name="Phase2_Dev" -v 2>&1 | tee -a "$LOG"

echo "Step 5: Export verification key ..."
snarkjs zkey export verificationkey "$ZKEY_FINAL" "$VK_JSON" 2>&1 | tee -a "$LOG"

echo "Step 6: Export Solidity verifier ..."
SOL_OUT="$CIRCUIT_DIR/MeteringVerifier_generated.sol"
snarkjs zkey export solidityverifier "$ZKEY_FINAL" "$SOL_OUT" 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "✅ Trusted setup complete" | tee -a "$LOG"
echo "   Final zkey: $ZKEY_FINAL" | tee -a "$LOG"
echo "   VK:         $VK_JSON" | tee -a "$LOG"
echo "   Verifier:   $SOL_OUT" | tee -a "$LOG"

# Record final hashes
for f in "$ZKEY_FINAL" "$VK_JSON"; do
  if [ -f "$f" ]; then
    if command -v sha256sum &>/dev/null; then
      SHA=$(sha256sum "$f" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
      SHA=$(shasum -a 256 "$f" | awk '{print $1}')
    else
      SHA="n/a"
    fi
    echo "sha256_$(basename $f): $SHA" >> "$LOG"
  fi
done

echo ""
echo "🔒 SECURITY REMINDER:"
echo "   This setup used $(ls "$PHASE1_DIR"/pot${POWER}_00*.ptau 2>/dev/null | wc -l | tr -d ' ') Phase 1 contribution(s)."
echo "   For production, run a multi-party ceremony with ≥ 3 independent participants."
echo "   See docs/architecture/adr/ADR-oracle-truth-model.md for ceremony requirements."
