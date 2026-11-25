#!/usr/bin/env bash
# Checks that the local Besu IBFT network folder is prepared before the network is started: for
# node1..node4 under tools/besu/docker/network/, the node folder, genesis.json and data/key must exist.
# Called by besu_up.sh and besu_up_full.sh. It only reads; it never generates keys or genesis files
# (see besu_network_init.sh), and those files must not be committed.
# Usage: bash scripts/ops/besu_harness_check.sh
# Exit codes: 0 = folder prepared; 2 = something is missing (each missing path is printed).
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
