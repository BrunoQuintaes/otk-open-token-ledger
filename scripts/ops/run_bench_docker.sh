#!/usr/bin/env bash
# OTK Benchmark — 1-command Linux-controlled run
# Usage: bash scripts/ops/run_bench_docker.sh [--no-zk]
#
# Builds image, runs benchmark inside Docker (Linux, fixed CPU/RAM),
# outputs CSV/JSON to docs/_ops/u9/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/tools/bench/docker-compose.bench.yml"

echo "=== OTK Benchmark (Docker/Linux) ==="
echo "Repo: ${REPO_ROOT}"
echo "Compose: ${COMPOSE_FILE}"
echo ""

# Build
docker compose -f "${COMPOSE_FILE}" build bench

# Run with optional --no-zk override
if [[ "${1:-}" == "--no-zk" ]]; then
  echo "Running WITHOUT ZK proof generation..."
  docker compose -f "${COMPOSE_FILE}" run --rm \
    -e NO_ZK_OVERRIDE=1 bench \
    npx tsx scripts/benchmark/u9_bench_v2.ts --no-zk
else
  echo "Running WITH ZK proof generation (est. ~10min)..."
  docker compose -f "${COMPOSE_FILE}" run --rm bench
fi

echo ""
echo "=== Done. Results in: ${REPO_ROOT}/docs/_ops/u9/ ==="
ls -lh "${REPO_ROOT}/docs/_ops/u9/" | tail -5
