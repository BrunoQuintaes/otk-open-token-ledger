#!/usr/bin/env sh
# install-hooks.sh — Install versioned git hooks for OTK zk-Metering (U6.2)
#
# Usage: bash scripts/ops/install-hooks.sh
# Effect: Copies scripts/ops/hooks/pre-commit.sh to .git/hooks/pre-commit
#
# The hook source is version-controlled in scripts/ops/hooks/.
# Run this script after cloning or pulling hook updates.

set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK_DIR="$ROOT/.git/hooks"
HOOK_SRC="$ROOT/scripts/ops/hooks/pre-commit.sh"
HOOK_DEST="$HOOK_DIR/pre-commit"

mkdir -p "$HOOK_DIR"

if [ ! -f "$HOOK_SRC" ]; then
  echo "❌ ERROR: Hook source not found: $HOOK_SRC"
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"

echo "OK: installed .git/hooks/pre-commit from scripts/ops/hooks/pre-commit.sh"
echo "    Patterns: API keys, private keys, mnemonics, seed phrases, xprv"
echo "    Allowlist: variable names, env refs, docs, mocks, test helpers"
