#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# prereq: genesis + validator keys exist (generated locally; not committed)
bash scripts/ops/besu_harness_check.sh

# start ONLY node1 first (NODE1_ENODE=dummy silences compose env warnings at parse time)
NODE1_ENODE=dummy docker compose -f tools/besu/docker/docker-compose.ibft.yml up -d node1

# wait for admin_nodeInfo to return a valid enode (P2P layer must be ready)
echo "Waiting for node1 enode..."
raw=""
for i in $(seq 1 90); do
  raw=$(bash scripts/ops/besu_get_enode.sh http://127.0.0.1:8545 2>/dev/null || true)
  if echo "$raw" | grep -q '^enode://'; then
    echo "node1 enode ready (attempt $i)"
    break
  fi
  sleep 2
done
if ! echo "$raw" | grep -q '^enode://'; then
  echo "FAIL: node1 enode not available after timeout" >&2
  exit 2
fi
# enode://<pubkey>@<ip>:<port>...
pub="${raw#enode://}"; pub="${pub%@*}"
NODE1_ENODE="${pub}"

export NODE1_ENODE
echo "NODE1_ENODE=$NODE1_ENODE"

# now start remaining nodes with bootnodes
docker compose -f tools/besu/docker/docker-compose.ibft.yml up -d node2 node3 node4
