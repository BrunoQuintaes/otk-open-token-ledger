#!/usr/bin/env bash
# Usage: bash scripts/ops/session_secret_scan.sh [file...]   (details below)
# session_secret_scan.sh — detects HTTP session cookies in tracked files (RV2-03, fechamento pós-S5).
# Prints ONLY "path:line" for each hit, never the matched content, so evidence files cannot re-expose
# the secret. Exit 0 = no hit, 1 = hits.
#
#   bash scripts/ops/session_secret_scan.sh            # tracked files of the current git repo (git grep)
#   bash scripts/ops/session_secret_scan.sh <file>...  # explicit files (synthetic self-test)
#
# Patterns (case-insensitive): a "Cookie:"/"Set-Cookie:" header carrying a value of 16+ characters; any
# cookie whose name contains "session" with a signed value (s%3A… / s:…) of 16+ characters. Short
# placeholders (e.g. "session=abc") are ignored to limit false positives.
set -u
RE='(cookie:[[:space:]]*[a-z0-9_.-]+=[^[:space:];"'\'']{16,}|[a-z0-9_]*session[a-z0-9_]*=(s%3a|s:)[a-z0-9%._-]{16,})'
# this script and its synthetic test carry the pattern text, not a secret
EXCL=(':!scripts/ops/session_secret_scan.sh' ':!test/unit/d1d8_fps5_session_scan.test.ts')
hits=0
report() { # $1 = file label; line numbers on stdin
  while IFS= read -r n; do [ -n "$n" ] && { echo "$1:$n"; hits=$((hits + 1)); }; done
}
if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    [ -f "$f" ] || continue
    report "$f" < <(grep -niE "$RE" "$f" 2>/dev/null | cut -d: -f1)
  done
else
  while IFS= read -r f; do
    report "$f" < <(git grep -I -n -i -E "$RE" -- "$f" 2>/dev/null | cut -d: -f2)
  done < <(git grep -I -l -i -E "$RE" -- . "${EXCL[@]}" 2>/dev/null)
fi
echo "session_secret_scan: $hits hit(s) (locations only; values never printed)"
[ "$hits" -eq 0 ]
