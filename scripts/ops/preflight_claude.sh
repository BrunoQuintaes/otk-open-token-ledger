#!/usr/bin/env bash
# preflight_claude.sh — Verificação canônica antes de qualquer bloco relevante
# Uso: bash scripts/ops/preflight_claude.sh
set -e
set -o pipefail

echo "=== CLAUDE PREFLIGHT START ==="

# 1) Verificar arquivos canônicos obrigatórios
REQUIRED_FILES=(
  "CLAUDE.md"
  "docs/DOCS_INDEX.md"
  "docs/_canonical/CORE.md"
  "docs/_canonical/ZK.md"
  "docs/_canonical/IBFT.md"
  "docs/_canonical/SECURITY_CANONICAL.md"
  "docs/_canonical/VSCODE_CLAUDECODE.md"
  "docs/_canonical/extensions/ACE3.md"
  "docs/_canonical/extensions/NEON.md"
  "docs/_canonical/extensions/GITHUB.md"
  "docs/_canonical/extensions/OVERLEAF.md"
)

ALL_OK=true
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "❌ MISSING REQUIRED FILE: $f"
    ALL_OK=false
  else
    echo "✓ $f"
  fi
done

if [ "$ALL_OK" = false ]; then
  echo "❌ PREFLIGHT FAILED: arquivos canônicos ausentes"
  exit 1
fi

echo ""
echo "=== Headers canônicos (sanity check) ==="
echo "--- CLAUDE.md ---"
head -3 CLAUDE.md
echo "--- DOCS_INDEX.md ---"
head -3 docs/DOCS_INDEX.md
echo ""

echo "=== Branch + status ==="
git branch --show-current
git status -sb | head -10
echo ""

echo "=== Gate R0 ==="
bash scripts/ops/gate_r0_revalidate.sh

echo ""
echo "✅ CLAUDE PREFLIGHT OK"
echo "   Branch: $(git branch --show-current)"
echo "   Commit: $(git rev-parse --short HEAD)"
