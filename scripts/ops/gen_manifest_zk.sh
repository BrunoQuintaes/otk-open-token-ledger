#!/usr/bin/env bash
# gen_manifest_zk.sh — Generate deterministic run manifest for ZK artifacts
# Usage: ./scripts/ops/gen_manifest_zk.sh [optional_run_id]
# If run_id not provided, generates timestamp-based ID

set -euo pipefail

# Determine script directory (path-robust)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Generate or use provided run ID
RUN_ID="${1:-$(date +%Y%m%d_%H%M%S)}"
RUN_DIR="$REPO_ROOT/zk/build/$RUN_ID"

echo "=== ZK Manifest Generator ==="
echo "Run ID: $RUN_ID"
echo "Run Dir: $RUN_DIR"

# Create run directory
mkdir -p "$RUN_DIR"

# Define source artifacts (current layout)
PROOF_SRC="$REPO_ROOT/zk/build/proof.json"
PUBLIC_SRC="$REPO_ROOT/zk/build/public.json"

# Check if source artifacts exist
if [[ ! -f "$PROOF_SRC" ]]; then
  echo "ERROR: proof.json not found at $PROOF_SRC"
  exit 1
fi

if [[ ! -f "$PUBLIC_SRC" ]]; then
  echo "ERROR: public.json not found at $PUBLIC_SRC"
  exit 1
fi

# Copy artifacts to run directory
echo "Copying artifacts..."
cp "$PROOF_SRC" "$RUN_DIR/proof.json"
cp "$PUBLIC_SRC" "$RUN_DIR/public.json"

# Generate hashes (if sha256sum available)
HASH_PROOF=""
HASH_PUBLIC=""

if command -v sha256sum &> /dev/null; then
  echo "Calculating SHA256 hashes..."
  HASH_PROOF=$(sha256sum "$RUN_DIR/proof.json" | awk '{print $1}')
  HASH_PUBLIC=$(sha256sum "$RUN_DIR/public.json" | awk '{print $1}')
elif command -v shasum &> /dev/null; then
  echo "Calculating SHA256 hashes (using shasum)..."
  HASH_PROOF=$(shasum -a 256 "$RUN_DIR/proof.json" | awk '{print $1}')
  HASH_PUBLIC=$(shasum -a 256 "$RUN_DIR/public.json" | awk '{print $1}')
else
  echo "WARNING: sha256sum/shasum not available, skipping hash calculation"
fi

# Generate manifest.json
MANIFEST_FILE="$RUN_DIR/manifest.json"
cat > "$MANIFEST_FILE" <<EOF
{
  "run_id": "$RUN_ID",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "artifacts": {
    "proof.json": {
      "path": "proof.json",
      "sha256": "$HASH_PROOF"
    },
    "public.json": {
      "path": "public.json",
      "sha256": "$HASH_PUBLIC"
    }
  },
  "source": {
    "proof": "$PROOF_SRC",
    "public": "$PUBLIC_SRC"
  }
}
EOF

echo "Manifest generated: $MANIFEST_FILE"
cat "$MANIFEST_FILE"

# Optional: save evidence to docs/_ops
EVIDENCE_DIR="$REPO_ROOT/docs/_ops/u_pre_u8_5/PRE_U8_5_CONSOLIDATION_20260215_171928"
if [[ -d "$EVIDENCE_DIR" ]]; then
  echo "Saving manifest demo to evidence folder..."
  cp "$MANIFEST_FILE" "$EVIDENCE_DIR/manifest_demo.txt"
  echo "Evidence saved: $EVIDENCE_DIR/manifest_demo.txt"
fi

echo "=== Manifest generation complete ==="
echo "Run directory: $RUN_DIR"
