#!/usr/bin/env bash
# Starts the local 4-node Besu IBFT network in two steps: node1 first, then, once node1 reports its
# enode (polled with besu_get_enode.sh, up to 90 tries 2 seconds apart), node2..node4 with
# NODE1_ENODE exported so compose can give them node1 as bootnode.
# Reads no configuration besides the compose file tools/besu/docker/docker-compose.ibft.yml; it sets
# NODE1_ENODE itself (the node1 public key, without the enode:// prefix or the @host:port part).
# Usage: bash scripts/ops/besu_up_full.sh
# Exit codes: 0 = all nodes started; 2 = network folder not prepared or node1 enode not available in time.
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
