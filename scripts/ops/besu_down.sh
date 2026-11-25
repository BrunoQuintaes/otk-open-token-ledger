#!/usr/bin/env bash
# Stops the local 4-node Hyperledger Besu IBFT network and removes its containers, network and
# Docker-managed volumes (`down -v`). It is the counterpart of besu_up.sh / besu_up_full.sh and uses
# the same compose file, tools/besu/docker/docker-compose.ibft.yml. The node folders under
# tools/besu/docker/network/ are bind mounts, so their genesis, keys and chain data are NOT deleted.
# Usage: bash scripts/ops/besu_down.sh
# Exit code: the exit code of `docker compose down`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
docker compose -f tools/besu/docker/docker-compose.ibft.yml down -v
