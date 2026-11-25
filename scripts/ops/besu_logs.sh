#!/usr/bin/env bash
# Follows the logs of the local Besu IBFT network containers (last 200 lines, then live; Ctrl+C stops).
# Uses the compose file tools/besu/docker/docker-compose.ibft.yml, the same as besu_up.sh.
# Usage: bash scripts/ops/besu_logs.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
docker compose -f tools/besu/docker/docker-compose.ibft.yml logs --tail=200 -f
