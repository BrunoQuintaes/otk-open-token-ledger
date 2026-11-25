#!/usr/bin/env bash
# ingest_incremental.sh — ACE3 Incremental Evidence Collector
# Uso: bash scripts/ace3/ingest_incremental.sh [--full]
#
# Coleta evidências do delta entre o último commit analisado (ACE3 INDEX.md)
# e HEAD. Salva em docs/_ops/analysis/ACE3_INC_<TS>/.
# A análise de gaps é feita manualmente por Claude após a coleta.
#
# --full: força análise de toda a história (ignora last_analyzed_commit)
#
# English summary: collects evidence for an incremental code review of the commits made since the last
# reviewed commit (read from the "commit:" line of docs/ace3/INDEX.md; full history with --full or when that
# commit is missing). Writes 00_context.txt, 01_diff.patch, 02_new_files.txt, 03_test_status.txt (runs
# "npm test") and 04_gate_r0.txt (runs scripts/ops/gate_r0_revalidate.sh) into a new timestamped folder under
# docs/_ops/analysis/. The review itself is done by hand afterwards. Needs git; reads no environment variables.

set -e
set -o pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TS="$(date +%Y%m%d_%H%M%S)"
FULL_MODE=false
if [ "${1:-}" = "--full" ]; then
  FULL_MODE=true
fi

# Localizar último commit analisado no INDEX.md
INDEX_FILE="docs/ace3/INDEX.md"
LAST_COMMIT=""

if [ -f "$INDEX_FILE" ]; then
  # Extrai linha "commit:  <hash>" do INDEX.md
  LAST_COMMIT="$(grep -E '^\s*commit:\s+[0-9a-f]+' "$INDEX_FILE" | head -1 | awk '{print $NF}' || true)"
fi

if [ "$FULL_MODE" = true ] || [ -z "$LAST_COMMIT" ]; then
  echo "=== ACE3 FULL MODE (sem last_commit ou --full forçado) ==="
  EVD_NAME="ACE3_FULL_${TS}"
  RANGE_DESC="full history"
  GIT_RANGE=""
else
  echo "=== ACE3 INCREMENTAL — delta desde $LAST_COMMIT ==="
  EVD_NAME="ACE3_INC_${TS}"
  RANGE_DESC="$LAST_COMMIT..HEAD"
  GIT_RANGE="$LAST_COMMIT..HEAD"

  # Verificar que LAST_COMMIT existe
  if ! git cat-file -e "${LAST_COMMIT}^{commit}" 2>/dev/null; then
    echo "⚠️  Commit $LAST_COMMIT não encontrado — forçando FULL mode"
    EVD_NAME="ACE3_FULL_${TS}"
    RANGE_DESC="full history"
    GIT_RANGE=""
  fi
fi

EVD_DIR="docs/_ops/analysis/${EVD_NAME}"
mkdir -p "$EVD_DIR"

echo "Evidência: $EVD_DIR"
echo ""

# ── 00_context.txt ──────────────────────────────────────────────────────────
echo "=== [1/5] Coletando contexto git ==="
{
  echo "ACE3 Incremental Evidence"
  echo "Timestamp: $TS"
  echo "Mode: $([ "$FULL_MODE" = true ] && echo 'FULL' || echo 'INCREMENTAL')"
  echo "Range: $RANGE_DESC"
  echo "Branch: $(git branch --show-current)"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "Last analyzed: ${LAST_COMMIT:-N/A}"
  echo ""
  echo "=== git log ($RANGE_DESC) ==="
  if [ -n "$GIT_RANGE" ]; then
    git log "$GIT_RANGE" --oneline
  else
    git log --oneline -30
  fi
  echo ""
  echo "=== git status ==="
  git status -sb | head -20
} > "$EVD_DIR/00_context.txt"

echo "  ✓ 00_context.txt"

# ── 01_diff.patch ────────────────────────────────────────────────────────────
echo "=== [2/5] Coletando diff ==="
{
  if [ -n "$GIT_RANGE" ]; then
    git diff "$GIT_RANGE" || true
  else
    git diff HEAD~5..HEAD || true
  fi
} > "$EVD_DIR/01_diff.patch"

DIFF_LINES="$(wc -l < "$EVD_DIR/01_diff.patch" | tr -d ' ')"
echo "  ✓ 01_diff.patch ($DIFF_LINES linhas)"

# ── 02_new_files.txt ─────────────────────────────────────────────────────────
echo "=== [3/5] Listando arquivos modificados ==="
{
  echo "=== Arquivos modificados ($RANGE_DESC) ==="
  if [ -n "$GIT_RANGE" ]; then
    git diff --name-status "$GIT_RANGE" || true
  else
    git diff --name-status HEAD~5..HEAD || true
  fi
  echo ""
  echo "=== Arquivos não rastreados (untracked) ==="
  git ls-files --others --exclude-standard | grep -v node_modules | grep -v '.git' | head -30 || true
} > "$EVD_DIR/02_new_files.txt"

echo "  ✓ 02_new_files.txt"

# ── 03_test_status.txt ───────────────────────────────────────────────────────
echo "=== [4/5] Rodando testes ==="
{
  echo "=== npm test (SDK/unit) ==="
  echo "Timestamp: $(date)"
  if npm test --silent 2>&1; then
    echo "EXIT: 0 (PASS)"
  else
    echo "EXIT: $? (FAIL)"
  fi
} > "$EVD_DIR/03_test_status.txt" 2>&1

echo "  ✓ 03_test_status.txt"

# ── 04_gate_r0.txt ───────────────────────────────────────────────────────────
echo "=== [5/5] Gate R0 ==="
{
  echo "=== Gate R0 ==="
  echo "Timestamp: $(date)"
  if bash scripts/ops/gate_r0_revalidate.sh 2>&1; then
    echo "EXIT: 0 (GO)"
  else
    echo "EXIT: $? (FAIL)"
  fi
} > "$EVD_DIR/04_gate_r0.txt" 2>&1

# Verificar resultado do Gate R0
if grep -q "GATE R0: GO" "$EVD_DIR/04_gate_r0.txt" 2>/dev/null || grep -q "Gate R0: GO" "$EVD_DIR/04_gate_r0.txt" 2>/dev/null || grep -q "EXIT: 0" "$EVD_DIR/04_gate_r0.txt" 2>/dev/null; then
  GATE_STATUS="GO"
else
  GATE_STATUS="CHECK_REQUIRED"
fi

echo "  ✓ 04_gate_r0.txt (Gate: $GATE_STATUS)"

# ── Resumo ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  ACE3 INGEST COMPLETO"
echo "  Evidência: $EVD_DIR"
echo "  Range: $RANGE_DESC"
echo "  Gate R0: $GATE_STATUS"
echo "============================================"
echo ""
echo "PRÓXIMOS PASSOS:"
echo "  1. Peça ao Claude para analisar os arquivos em $EVD_DIR"
echo "  2. Prompt sugerido:"
echo "     'Analise ACE3 incremental em $EVD_DIR. Compare com gaps em docs/ace3/INDEX.md."
echo "      Identifique: gaps resolvidos, novos gaps, sem mudança.'"
echo "  3. Atualizar docs/ace3/INDEX.md (último commit analisado + status)"
echo "  4. Atualizar docs/_canonical/ACE3_MEMORY.md"
echo "  5. Commit: docs(ace3): análise incremental ACE3 — <resumo>"
echo ""

# ── Atualizar last_analyzed_commit sugerido ──────────────────────────────────
CURRENT_HEAD="$(git rev-parse --short HEAD)"
echo "  ℹ️  Quando atualizar INDEX.md, use:"
echo "     commit: $CURRENT_HEAD"
echo "     data:   $(date +%Y-%m-%d)"
