#!/usr/bin/env bash
# zk_clean.sh — Remove ZK build artifacts (keep ptau/zkey — expensive to regenerate)
#
# Usage: bash scripts/zk/zk_clean.sh [--all]
#   --all  Also removes .ptau and .zkey files (full clean — requires re-ceremony)
#
# Safe by default: only removes witness/proof/log artifacts.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$REPO_ROOT/zk/build"

ALL=false
[[ "${1:-}" == "--all" ]] && ALL=true

echo "🧹 ZK clean — BUILD=$BUILD"

# Always safe to remove
rm -f "$BUILD"/*.wtns
rm -f "$BUILD"/proof.json
rm -f "$BUILD"/public.json
rm -f "$BUILD"/run_zk_demo*.log
rm -f "$BUILD"/binding_test_witness.wtns

if $ALL; then
  echo "⚠️  --all: removing .ptau and .zkey (re-ceremony required)"
  rm -f "$BUILD"/*.ptau "$BUILD"/*.zkey
fi

echo "✅ Clean complete."
