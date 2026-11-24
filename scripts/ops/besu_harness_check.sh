#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NET="$ROOT/tools/besu/docker/network"
ok=1

echo "Besu harness check: $NET"
for n in node1 node2 node3 node4; do
  if [ ! -d "$NET/$n" ]; then echo "MISSING: $NET/$n"; ok=0; continue; fi
  if [ ! -f "$NET/$n/genesis.json" ]; then echo "MISSING: $NET/$n/genesis.json"; ok=0; fi
  if [ ! -f "$NET/$n/data/key" ]; then echo "MISSING: $NET/$n/data/key"; ok=0; fi
done

if [ "$ok" -ne 1 ]; then
  echo ""
  echo "FAIL: network not prepared. Provide genesis + keys (do NOT commit secrets)."
  exit 2
fi

echo "OK: network folder prepared"
