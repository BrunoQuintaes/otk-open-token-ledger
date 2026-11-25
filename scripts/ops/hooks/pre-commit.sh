#!/usr/bin/env bash
# pre-commit.sh — OTK zk-Metering Secret Guard (U6.2)
#
# Lightweight secret scan over staged changes only.
# Mirrors the pattern set from gate_r0_revalidate.sh (CHECK 1) but
# scans staged diff only (fast, no evidence dirs, no Hardhat compile).
#
# Patterns: API keys, private keys, mnemonics, seed phrases, xprv
# Allowlist: variable names, env var references, docs, mocks, test helpers
#
# Usage: installed as .git/hooks/pre-commit by scripts/ops/install-hooks.sh; git runs it before each
# commit. To run it by hand on the staged changes: bash scripts/ops/hooks/pre-commit.sh
# Exit codes: 0 = nothing suspicious (or every hit allowlisted); 1 = commit blocked, suspicious lines printed.
# Comments added to other files are scanned too, so they must not contain the pattern words.

set -euo pipefail

echo "Running secret scan..."

STAGED=$(git diff --cached)

if [ -z "$STAGED" ]; then
  echo "✅ No staged changes to scan."
  exit 0
fi

# ---------------------------------------------------------------------------
# Secret patterns (same family as gate_r0 CHECK 1)
# ---------------------------------------------------------------------------
SECRET_RE='(BEGIN (RSA |EC )?PRIVATE KEY|-----BEGIN.*PRIVATE KEY-----|mnemonic|seed phrase|api[_-]?key[[:space:]]*=[[:space:]]*['\''"][a-zA-Z0-9]{20,}|secret[_-]?key[[:space:]]*=[[:space:]]*['\''"][a-zA-Z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xprv|AWS_SECRET_ACCESS_KEY)'

# ---------------------------------------------------------------------------
# Allowlist: known safe patterns (variable names, docs, test helpers, scripts)
# ---------------------------------------------------------------------------
ALLOWLIST_RE="(process\\.env|Object\\.keys\\(|export const|interface|TODO.*SECRET|example.*secret|sample.*key|dummy.*key|placeholder|test.*key|mock.*key|//.*secret|documentation|@param.*key|KeyPair|PublicKey|SECRET_RE=|ALLOWLIST_RE=|file:///|mnemonic\\.(ts|js|d\\.ts)|/wallet/mnemonic|Never print or commit|CLAUDE\\.md.*private keys|pre.commit\\.sh|gate_r0|install.hooks|Patterns: API|# Patterns:|echo.*Patterns|echo.*seed phrase|echo.*private key|echo.*mnemonic|echo.*xprv|mnemonic \\/ |seed phrase \\/ |xprv \\/ |AWS_SECRET_ACCESS_KEY \\/ |\\/ seed phrase|\\/ xprv|\\/ AWS_SECRET|'mnemonic'|\"mnemonic\"|palavra.*mnemonic|allowlist.*mnemonic|mnemonic.*allowlist|word.*mnemonic|the word mnemonic|NUNCA.*commitar|NUNCA.*commit|commitar.*mnemonic|Anti.Secrets|## SECURITY|policy.*mnemonic|mnemonic.*policy|security.*rule|## 11\\)|Anti-Secrets Policy|padr[oõ]es|Secret scan \(git grep|git grep contra|API tokens|private keys.*mnemonics|mnemonics.*tokens|git grep.*secrets|para secrets|keys.*mnemonics|DEFENSE_QUESTIONS|demo.*script.*pack|U12_DEMO|Searching: BEGIN|_secret_scan\\.txt:.*BEGIN|_secret_extra\\.txt:.*BEGIN|_secret_grep\\.txt:.*BEGIN|secret_grep.*BEGIN|hygiene.*BEGIN|EVD.*BEGIN)"

# ---------------------------------------------------------------------------
# Scan staged diff
# ---------------------------------------------------------------------------
MATCHES=$(echo "$STAGED" | grep -E "$SECRET_RE" || true)

if [ -z "$MATCHES" ]; then
  echo "✅ Secret scan passed."
  exit 0
fi

# Apply allowlist filter
FILTERED=$(echo "$MATCHES" | grep -vE "$ALLOWLIST_RE" || true)

if [ -z "$FILTERED" ]; then
  echo "✅ Secret scan passed (matches filtered by allowlist)."
  exit 0
fi

# Secrets found — block commit
echo ""
echo "❌ ERROR: Potential secrets detected in staged changes."
echo ""
echo "Suspicious lines:"
echo "$FILTERED"
echo ""
echo "If this is a false positive, update ALLOWLIST_RE in scripts/ops/hooks/pre-commit.sh"
echo "and re-run: bash scripts/ops/install-hooks.sh"
echo ""
exit 1
