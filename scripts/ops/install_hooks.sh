#!/usr/bin/env bash
set -e
set -o pipefail

# install_hooks.sh — Configura git hooks via core.hooksPath (.githooks/)
# Uso: bash scripts/ops/install_hooks.sh
# Idempotente: seguro para re-executar

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "=== Installing canonical git hooks ==="
echo "Repo: $REPO_ROOT"

# 1) Verificar que .githooks/ existe
if [ ! -d ".githooks" ]; then
  echo "❌ .githooks/ missing. Clone repo fresh or run setup.step4 generator first."
  exit 1
fi

# 2) Verificar que pre-commit existe e é executável
if [ ! -f ".githooks/pre-commit" ]; then
  echo "❌ .githooks/pre-commit missing."
  exit 1
fi

if [ ! -x ".githooks/pre-commit" ]; then
  chmod +x .githooks/pre-commit
  echo "✓ Fixed: .githooks/pre-commit is now executable"
fi

# 3) Configurar core.hooksPath
git config core.hooksPath .githooks
echo "✓ core.hooksPath set to .githooks"
echo "  Current: $(git config --get core.hooksPath)"

# 4) Sanity check
echo ""
echo "=== Hooks instalados ==="
ls -la .githooks/
echo ""
echo "✅ Hook installation complete."
echo "   Todo commit agora rodará: bash scripts/ops/preflight_claude.sh"
echo ""
echo "   Bypass de emergência (somente local, com justificativa em EVD):"
echo "   SKIP_CLAUDE_PREFLIGHT=1 git commit -m 'msg'"
