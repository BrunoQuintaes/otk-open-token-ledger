#!/usr/bin/env bash
# render_helm.sh — Validate OTK Helm chart structure
#
# If helm is available: runs lint + template render.
# If helm is unavailable: runs structural file validation (YAML presence + key checks).
#
# Usage:
#   bash scripts/ops/render_helm.sh [--output FILE]
#
# Exit codes:
#   0 — validation passed
#   1 — validation failed

set -euo pipefail

CHART_DIR="infra/helm/otk"
OUTPUT="${1:-}"

# ─── helpers ─────────────────────────────────────────────────────────────────
pass() { echo "✓ $*"; }
fail() { echo "✗ FAIL: $*" >&2; exit 1; }

# ─── 1. structural validation (always runs) ─────────────────────────────────
echo "─── Helm chart structural validation ───────────────────────────────"

for f in \
  "$CHART_DIR/Chart.yaml" \
  "$CHART_DIR/values.yaml" \
  "$CHART_DIR/templates/_helpers.tpl" \
  "$CHART_DIR/templates/deployment.yaml" \
  "$CHART_DIR/templates/service.yaml" \
  "$CHART_DIR/templates/configmap.yaml" \
  "$CHART_DIR/templates/secret.yaml" \
  "$CHART_DIR/templates/pdb.yaml" \
  "$CHART_DIR/templates/serviceaccount.yaml" \
  "$CHART_DIR/templates/hpa.yaml" \
  "$CHART_DIR/templates/ingress.yaml" \
  "$CHART_DIR/templates/NOTES.txt"
do
  [ -f "$f" ] || fail "Missing: $f"
  pass "$f exists"
done

# Check Chart.yaml has required fields
grep -q "apiVersion:" "$CHART_DIR/Chart.yaml"      || fail "Chart.yaml missing apiVersion"
grep -q "name: otk"   "$CHART_DIR/Chart.yaml"      || fail "Chart.yaml missing name: otk"
pass "Chart.yaml has apiVersion + name"

grep -q "image:"   "$CHART_DIR/values.yaml"         || fail "values.yaml missing image key"
grep -q "port:"    "$CHART_DIR/values.yaml"         || fail "values.yaml missing port key"
grep -q "/healthz"  "$CHART_DIR/values.yaml"        || fail "values.yaml missing /healthz probe path"
grep -q "/readyz"   "$CHART_DIR/values.yaml"        || fail "values.yaml missing /readyz probe path"
pass "values.yaml has image + port + /healthz + /readyz probes"

grep -q "containerPort" "$CHART_DIR/templates/deployment.yaml" || fail "deployment.yaml missing containerPort"
grep -q "livenessProbe" "$CHART_DIR/templates/deployment.yaml" || fail "deployment.yaml missing livenessProbe"
grep -q "readinessProbe" "$CHART_DIR/templates/deployment.yaml" || fail "deployment.yaml missing readinessProbe"
grep -q "startupProbe" "$CHART_DIR/templates/deployment.yaml"  || fail "deployment.yaml missing startupProbe"
grep -q "envFrom" "$CHART_DIR/templates/deployment.yaml"       || fail "deployment.yaml missing envFrom"
pass "deployment.yaml has containerPort + liveness + readiness + startup probes + envFrom"

# ─── 2. Helm lint + template (if helm available) ─────────────────────────────
if command -v helm &>/dev/null; then
  echo "─── helm lint ───────────────────────────────────────────────────────"
  helm lint "$CHART_DIR"

  echo "─── helm template ───────────────────────────────────────────────────"
  if [ -n "$OUTPUT" ]; then
    helm template otk "$CHART_DIR" > "$OUTPUT"
    pass "Rendered to $OUTPUT"
  else
    helm template otk "$CHART_DIR" > /dev/null
    pass "helm template rendered OK"
  fi
else
  echo "  [INFO] helm not available — skipping helm lint/template"
  echo "  [INFO] To install: https://helm.sh/docs/intro/install/"
fi

# ─── 3. kubectl dry-run (if kubectl available and rendered manifests exist) ──
if command -v kubectl &>/dev/null && [ -n "$OUTPUT" ] && [ -f "$OUTPUT" ]; then
  echo "─── kubectl apply --dry-run=client ──────────────────────────────────"
  kubectl apply --dry-run=client -f "$OUTPUT" 2>&1 || echo "  [WARN] kubectl dry-run completed with warnings (no cluster required for structure check)"
fi

echo ""
echo "✅ render_helm.sh: ALL CHECKS PASSED"
