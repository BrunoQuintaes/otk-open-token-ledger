#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
bash scripts/ops/besu_harness_check.sh
docker compose -f tools/besu/docker/docker-compose.ibft.yml up -d
