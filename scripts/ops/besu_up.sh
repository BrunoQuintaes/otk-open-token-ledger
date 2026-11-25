#!/usr/bin/env bash
# Starts all nodes of the local Besu IBFT network in the background, after besu_harness_check.sh confirms
# that the genesis and node keys exist. Uses tools/besu/docker/docker-compose.ibft.yml.
# For a start that waits for node1 and passes its enode to the other nodes as bootnode, use besu_up_full.sh.
# Usage: bash scripts/ops/besu_up.sh
# Exit codes: 2 = network folder not prepared; otherwise the exit code of `docker compose up`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
bash scripts/ops/besu_harness_check.sh
docker compose -f tools/besu/docker/docker-compose.ibft.yml up -d
