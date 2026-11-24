#!/usr/bin/env bash
# =============================================================================
# 02_contribute.sh — Phase 1: Add participant contribution to Powers of Tau
#
# Each participant runs this script independently.
# The entropy is derived from PARTICIPANT_ENTROPY env var or interactive input.
#
# Usage:
#   PARTICIPANT_NAME="alice" \
#   PARTICIPANT_ENTROPY="<random-string>" \
#   bash scripts/setup/02_contribute.sh [POWER] [PHASE1_DIR] [CONTRIBUTION_INDEX]
#
# Arguments:
#   POWER             — Tau power (default: 12)
#   PHASE1_DIR        — Directory with ptau files (default: zk/ceremony/phase1)
#   CONTRIBUTION_INDEX — Contribution number (default: auto-detected from dir)
#
# Security: PARTICIPANT_ENTROPY must be unique per participant and destroyed
#           after the contribution. Never commit it to the repo.
# =============================================================================

set -euo pipefail

POWER="${1:-12}"
PHASE1_DIR="${2:-zk/ceremony/phase1}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

cd "$REPO_ROOT"

# Auto-detect next contribution index
LAST_IDX=$(ls "$PHASE1_DIR"/pot${POWER}_*.ptau 2>/dev/null | grep -oP '(?<=pot'${POWER}'_)\d+' | sort -n | tail -1 || echo "0")
NEXT_IDX=$(printf "%04d" $((10#$LAST_IDX + 1)))
CONTRIB_IDX="${3:-$NEXT_IDX}"

PARTICIPANT="${PARTICIPANT_NAME:-anonymous_$(date +%s)}"
ENTROPY="${PARTICIPANT_ENTROPY:-}"

INPUT_PTAU="$PHASE1_DIR/pot${POWER}_$(printf '%04d' $((10#$CONTRIB_IDX - 1))).ptau"
OUTPUT_PTAU="$PHASE1_DIR/pot${POWER}_${CONTRIB_IDX}.ptau"

echo "== OTK Trusted Setup — Phase 1 Contribution =="
echo "Participant: $PARTICIPANT"
echo "Input:       $INPUT_PTAU"
echo "Output:      $OUTPUT_PTAU"
echo ""

if [ ! -f "$INPUT_PTAU" ]; then
  echo "ERROR: Input ptau not found: $INPUT_PTAU" >&2
  echo "Run 01_init_ceremony.sh first." >&2
  exit 1
fi

if ! command -v snarkjs &>/dev/null; then
  echo "ERROR: snarkjs not found." >&2
  exit 1
fi

LOG="$PHASE1_DIR/ceremony_log.txt"
echo "" >> "$LOG"
echo "=== Contribution by $PARTICIPANT at $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

if [ -n "$ENTROPY" ]; then
  # Non-interactive mode with provided entropy
  echo "$ENTROPY" | snarkjs powersoftau contribute "$INPUT_PTAU" "$OUTPUT_PTAU" \
    --name="$PARTICIPANT" -v 2>&1 | tee -a "$LOG"
else
  # Interactive mode — participant types entropy manually
  echo "⚠️  No PARTICIPANT_ENTROPY set. You will be prompted to type random text."
  snarkjs powersoftau contribute "$INPUT_PTAU" "$OUTPUT_PTAU" \
    --name="$PARTICIPANT" -v 2>&1 | tee -a "$LOG"
fi

echo "✅ Contribution written: $OUTPUT_PTAU" | tee -a "$LOG"

# Record hash
if command -v sha256sum &>/dev/null; then
  SHA=$(sha256sum "$OUTPUT_PTAU" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  SHA=$(shasum -a 256 "$OUTPUT_PTAU" | awk '{print $1}')
else
  SHA="(sha256 not available)"
fi
echo "sha256_contribution_${CONTRIB_IDX}: $SHA" >> "$LOG"
echo "sha256: $SHA"

echo ""
echo "Next step (after all participants contribute):"
echo "  bash scripts/setup/03_finalize.sh $POWER \"$PHASE1_DIR\""
