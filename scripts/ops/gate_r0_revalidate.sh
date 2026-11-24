#!/usr/bin/env bash
# gate_r0_revalidate.sh — U6 Gate R0 Revalidation Routine
# Purpose: Mandatory pre-flight check before starting new execution-heavy phases
# Usage: ./scripts/ops/gate_r0_revalidate.sh

set -euo pipefail

# Determine script directory (path-robust)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         U6 GATE R0 REVALIDATION ROUTINE                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Repo Root: $REPO_ROOT"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Create evidence directory
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
EVIDENCE_DIR="$REPO_ROOT/docs/_ops/revalidation/REVALIDATION_$TIMESTAMP"
mkdir -p "$EVIDENCE_DIR"

echo "Evidence Dir: $EVIDENCE_DIR"
echo ""

# ============================================================================
# CHECK 0: Repository State
# ============================================================================
echo "─────────────────────────────────────────────────────────────"
echo "CHECK 0: Repository State"
echo "─────────────────────────────────────────────────────────────"

cd "$REPO_ROOT"
git status -sb > "$EVIDENCE_DIR/00_repo.txt" 2>&1
git log -n 10 --oneline >> "$EVIDENCE_DIR/00_repo.txt" 2>&1

echo "✓ Repository state captured"

# ============================================================================
# CHECK 1: Secrets Scan (tracked files only, with exclusions + allowlist)
# ============================================================================
echo ""
echo "─────────────────────────────────────────────────────────────"
echo "CHECK 1: Secrets Scan (CRITICAL)"
echo "─────────────────────────────────────────────────────────────"

SECRETS_FOUND=0

# Build list of tracked files (excluding noisy/evidence/listing dirs + gate scripts themselves)
EXCLUDE_RE='^(docs/_ops/|docs/_canonical/|docs/D1_SPLIT/|docs/FILES_ALL\.txt|zk/build/|node_modules/|\.git/|.*r0_revalidation\.(sh|ps1)$)'
TRACKED_FILES=$(git ls-files | grep -vE "$EXCLUDE_RE" || true)
TRACKED_COUNT=$(echo "$TRACKED_FILES" | wc -l)

echo "Scanning tracked files only (excluding evidence/build dirs)" > "$EVIDENCE_DIR/01_secret_scan.txt"
echo "Total tracked files to scan: $TRACKED_COUNT" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"

# Secret patterns (regex for grep -E)
SECRET_RE='(BEGIN (RSA |EC )?PRIVATE KEY|-----BEGIN.*PRIVATE KEY-----|mnemonic|seed phrase|api[_-]?key.*=.*['\''"][a-zA-Z0-9]{20,}|secret[_-]?key.*=.*['\''"][a-zA-Z0-9]{20,}|xprv|AWS_SECRET_ACCESS_KEY)'

# Allowlist: known safe patterns in docs/code (NOT actual secrets)
# - Variable/type names: process.env, Object.keys, interface, export const
# - Documentation: @param, comments, examples, CLAUDE.md instructions
# - Script self-references: SECRET_RE=, ALLOWLIST_RE=
# - Secret-name classifier line of scripts/ops/secret_env_boundary.mjs (RUN-S: a list of name suffixes, no values)
# - Library references: mnemonic.ts, mnemonic.js (ethers lib file names)
ALLOWLIST_RE='(process\.env|Object\.keys\(|export const|interface|TODO.*SECRET|example.*secret|sample.*key|dummy.*key|placeholder|test.*key|mock.*key|// secret|documentation|@param.*key|KeyPair|PublicKey|SECRET_RE=|ALLOWLIST_RE=|const SECRET_NAME = /\(SECRET\||PATTERNS=|file:///|mnemonic\.(ts|js|d\.ts)|/wallet/mnemonic|Never print or commit|CLAUDE\.md.*private keys|\.claude/rules/.*NUNCA.*commitar|# Patterns:|echo.*Patterns|Patterns: API|mnemonic \/ |seed phrase \/ |xprv \/ |\/ seed phrase|\/ xprv|Secrets Scan.*private keys|Scans tracked files for API keys|SENSITIVE_FIELDS|maskSensitiveFields|StructuredLogger\.ts)'

echo "Running scan..." | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"

# Scan tracked files for secrets
if [ -n "$TRACKED_FILES" ]; then
  MATCHES=$(echo "$TRACKED_FILES" | xargs grep -nEi "$SECRET_RE" 2>/dev/null || true)

  if [ -n "$MATCHES" ]; then
    echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"
    echo "─── Raw matches (before allowlist filter) ───" >> "$EVIDENCE_DIR/01_secret_scan.txt"
    echo "$MATCHES" >> "$EVIDENCE_DIR/01_secret_scan.txt"

    # Apply allowlist filter
    FILTERED=$(echo "$MATCHES" | grep -vEi "$ALLOWLIST_RE" || true)

    if [ -n "$FILTERED" ]; then
      echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"
      echo "─── ⚠️  POTENTIAL SECRETS (after allowlist filter) ───" >> "$EVIDENCE_DIR/01_secret_scan.txt"
      echo "$FILTERED" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
      SECRETS_FOUND=$(($(echo "$FILTERED" | wc -l)))
      echo "    ⚠️  FOUND $SECRETS_FOUND potential secret(s)" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
    else
      echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"
      echo "✓ All matches filtered by allowlist (safe patterns)" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
    fi
  else
    echo "✓ No secret patterns found in tracked files" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
  fi
else
  echo "⚠️  No tracked files to scan" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
fi

echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"
echo "─── Checking IBFT key directories are ignored ───" >> "$EVIDENCE_DIR/01_secret_scan.txt"

# Check that IBFT node data is NOT tracked
if git ls-files --error-unmatch infra/ibft/node1/data/key 2>/dev/null; then
  echo "❌ ERROR: infra/ibft/node1/data/key is tracked!" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
  SECRETS_FOUND=$((SECRETS_FOUND + 1))
else
  echo "✓ infra/ibft/node1/data/key is not tracked" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
fi

if git ls-files --error-unmatch infra/ibft/node2/data/key 2>/dev/null; then
  echo "❌ ERROR: infra/ibft/node2/data/key is tracked!" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
  SECRETS_FOUND=$((SECRETS_FOUND + 1))
else
  echo "✓ infra/ibft/node2/data/key is not tracked" | tee -a "$EVIDENCE_DIR/01_secret_scan.txt"
fi

if [[ $SECRETS_FOUND -gt 0 ]]; then
  echo "❌ FAIL: Secrets scan found $SECRETS_FOUND potential issues"
  echo "   Review: $EVIDENCE_DIR/01_secret_scan.txt"
  SECRET_SCAN_STATUS="FAIL"
else
  echo "✓ PASS: No secrets detected"
  SECRET_SCAN_STATUS="PASS"
fi

# CHECK 1a (RV2-03): session cookies in tracked files — locations only, values never written
echo "" >> "$EVIDENCE_DIR/01_secret_scan.txt"
echo "─── Session cookie scan (scripts/ops/session_secret_scan.sh, locations only) ───" >> "$EVIDENCE_DIR/01_secret_scan.txt"
if (cd "$REPO_ROOT" && bash scripts/ops/session_secret_scan.sh) >> "$EVIDENCE_DIR/01_secret_scan.txt" 2>&1; then
  echo "✓ PASS: No session cookies in tracked files"
else
  echo "❌ FAIL: session cookie pattern in tracked files (see locations in $EVIDENCE_DIR/01_secret_scan.txt)"
  SECRET_SCAN_STATUS="FAIL"
fi

# ============================================================================
# CHECK 1b: Secret env vars boundary scan (security.md rule §7)
# Enforces: specific secret env vars must only be read in secretsBootstrap.ts
# or ProviderGateway. Config vars (ports, timeouts, flags) are exempt.
# Secret vars watched: OTK_ADMIN_KEY, OTK_JWT_SECRET, OTK_VAULT_MASTER_KEY,
#                      OTK_STRIPE_SECRET_KEY, OTK_STRIPE_WEBHOOK_SECRET,
#                      OTK_STRIPE_PRICE_IDS
# ============================================================================
echo ""
echo "─────────────────────────────────────────────────────────────"
echo "CHECK 1b: Secret env vars boundary scan (rule §7)"
echo "─────────────────────────────────────────────────────────────"

ENV_SCAN_STATUS="PASS"

# NF-01 (RUN-S 2026-10-09): the previous grep saw only the process.env['X'] notation and 8 names. The detector covers
# bracket and dot notation and destructuring, classifies secret names by pattern, allows only the canonical boundaries
# (src/infra/secretsBootstrap.ts, src/providers/) and accepts existing reads only through
# scripts/ops/secret_env_allowlist.json (each entry with finding id and date). Prints names, never values.
if node "$REPO_ROOT/scripts/ops/secret_env_boundary.mjs" "$REPO_ROOT" > "$EVIDENCE_DIR/01b_env_scan.txt" 2>&1; then
  echo "✓ PASS: secret env vars read only at the boundaries or through the dated allowlist" | tee -a "$EVIDENCE_DIR/01b_env_scan.txt"
else
  grep -E "VIOLATION|INVALID|RESULT" "$EVIDENCE_DIR/01b_env_scan.txt"
  echo "❌ FAIL: secret env var(s) read outside secretsBootstrap boundary" | tee -a "$EVIDENCE_DIR/01b_env_scan.txt"
  echo "   Fix: route through secretsBootstrap getter (security.md rule §7)"
  ENV_SCAN_STATUS="FAIL"
  SECRET_SCAN_STATUS="FAIL"
fi
head -1 "$EVIDENCE_DIR/01b_env_scan.txt"

# ============================================================================
# CHECK 2: Build Checks
# ============================================================================
echo ""
echo "─────────────────────────────────────────────────────────────"
echo "CHECK 2: Build Checks"
echo "─────────────────────────────────────────────────────────────"

BUILD_STATUS="PASS"

# Check zk artifacts exist
echo "Checking ZK artifacts..." > "$EVIDENCE_DIR/02_build_checks.txt"
if [[ -f "$REPO_ROOT/zk/build/proof.json" ]]; then
  echo "✓ zk/build/proof.json exists" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
else
  echo "⚠️  zk/build/proof.json NOT found" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
  BUILD_STATUS="WARN"
fi

if [[ -f "$REPO_ROOT/zk/build/public.json" ]]; then
  echo "✓ zk/build/public.json exists" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
else
  echo "⚠️  zk/build/public.json NOT found" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
  BUILD_STATUS="WARN"
fi

# Check hardhat compile (if hardhat directory exists)
if [[ -d "$REPO_ROOT/tools/hardhat" ]]; then
  echo "" >> "$EVIDENCE_DIR/02_build_checks.txt"
  echo "Checking Hardhat compile..." | tee -a "$EVIDENCE_DIR/02_build_checks.txt"

  cd "$REPO_ROOT/tools/hardhat"
  # Ensure Hardhat deps are installed (node_modules is gitignored)
  if [[ ! -d "node_modules" ]]; then
    echo "Installing Hardhat dependencies..." | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
    # NF-08 (RUN-S): npm ci keeps package-lock.json untouched during the gate
    npm ci --no-audit --no-fund >> "$EVIDENCE_DIR/02_build_checks.txt" 2>&1 || true
  fi
  # Clean first to avoid cached "No contracts to compile" state
  npx hardhat clean >> "$EVIDENCE_DIR/02_build_checks.txt" 2>&1 || true
  if npx hardhat compile >> "$EVIDENCE_DIR/02_build_checks.txt" 2>&1; then
    echo "✓ Hardhat compile successful" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
  else
    echo "⚠️  Hardhat compile failed (see evidence)" | tee -a "$EVIDENCE_DIR/02_build_checks.txt"
    BUILD_STATUS="WARN"
  fi
fi

echo ""
if [[ "$BUILD_STATUS" == "PASS" ]]; then
  echo "✓ PASS: All build checks passed"
else
  echo "⚠️  WARN: Some build checks failed (non-critical)"
fi

# ============================================================================
# CHECK 2b: PUSH0 Detector (Berlin EVM compatibility)
# ADR-EVM-0002: ensures no Shanghai-era PUSH0 opcode in Hardhat artifacts
# ============================================================================
echo ""
echo "─────────────────────────────────────────────────────────────"
echo "CHECK 2b: PUSH0 Detector (Berlin EVM — ADR-EVM-0002)"
echo "─────────────────────────────────────────────────────────────"

PUSH0_STATUS="PASS"
if [ -f "$REPO_ROOT/scripts/ops/detect_push0.js" ]; then
  if node "$REPO_ROOT/scripts/ops/detect_push0.js" >> "$EVIDENCE_DIR/02_build_checks.txt" 2>&1; then
    echo "✓ PASS: No PUSH0 opcode detected in Hardhat artifacts (Berlin safe)"
  else
    echo "⚠️  WARN: PUSH0 opcode detected — Berlin EVM incompatible (see evidence)"
    PUSH0_STATUS="WARN"
    BUILD_STATUS="WARN"
  fi
else
  echo "SKIP: scripts/ops/detect_push0.js not found" >> "$EVIDENCE_DIR/02_build_checks.txt"
  echo "ℹ  SKIP: detect_push0.js not found (non-blocking)"
fi

# ============================================================================
# CHECK 3: Final Result
# ============================================================================
echo ""
echo "─────────────────────────────────────────────────────────────"
echo "FINAL RESULT"
echo "─────────────────────────────────────────────────────────────"

cat > "$EVIDENCE_DIR/03_result.md" <<EOF
# Gate R0 Revalidation Result
**Timestamp:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Summary
- **Secrets Scan:** $SECRET_SCAN_STATUS
- **process.env Boundary (§7):** $ENV_SCAN_STATUS
- **Build Checks:** $BUILD_STATUS
- **PUSH0 Detector:** $PUSH0_STATUS

## Checks Performed
1. Repository state captured
2. Secrets scan (git grep for sensitive patterns)
3. IBFT key directories verified as not tracked
4. process.env boundary scan (rule §7 — secretsBootstrap enforcement)
5. ZK artifacts existence check
6. Hardhat compile test
7. PUSH0 opcode detector (Berlin EVM compat — ADR-EVM-0002)

## Evidence Files
- \`00_repo.txt\` — Git status and recent commits
- \`01_secret_scan.txt\` — Secrets scan results
- \`02_build_checks.txt\` — Build validation results
- \`03_result.md\` — This summary

## Decision
EOF

if [[ "$SECRET_SCAN_STATUS" == "PASS" && "$BUILD_STATUS" == "PASS" ]]; then
  echo "**✅ GO** — Safe to proceed with next phase" >> "$EVIDENCE_DIR/03_result.md"
  echo ""
  echo "✅ GATE R0 RESULT: GO"
  echo "   Safe to proceed with next phase"
  EXIT_CODE=0
elif [[ "$SECRET_SCAN_STATUS" == "FAIL" ]]; then
  echo "**❌ NO-GO** — Secrets detected, must remediate before proceeding" >> "$EVIDENCE_DIR/03_result.md"
  echo ""
  echo "❌ GATE R0 RESULT: NO-GO"
  echo "   Secrets detected — review evidence and remediate"
  EXIT_CODE=1
else
  echo "**⚠️  CAUTION** — Build warnings present, review before proceeding" >> "$EVIDENCE_DIR/03_result.md"
  echo ""
  echo "⚠️  GATE R0 RESULT: CAUTION"
  echo "   Build warnings present — review before proceeding"
  EXIT_CODE=0
fi

echo ""
echo "─────────────────────────────────────────────────────────────"
echo "Evidence saved to: $EVIDENCE_DIR"
echo "─────────────────────────────────────────────────────────────"

exit $EXIT_CODE
