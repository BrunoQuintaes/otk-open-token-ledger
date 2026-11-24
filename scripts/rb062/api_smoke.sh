#!/usr/bin/env bash
# RB-062 — API smoke test (curl)
# Usage: API_PORT=8787 bash scripts/rb062/api_smoke.sh
set -euo pipefail

PORT="${API_PORT:-8787}"
TSX="node_modules/.bin/tsx"

echo "[smoke] Starting API server on port ${PORT}..."
API_PORT="${PORT}" "${TSX}" src/api/server.ts &
SERVER_PID=$!
trap "kill ${SERVER_PID} 2>/dev/null || true" EXIT

# Wait up to 5 seconds for server to be ready
for i in $(seq 1 10); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo ""
echo "--- GET /health ---"
curl -s "http://127.0.0.1:${PORT}/health"
echo ""

echo "--- GET /version ---"
curl -s "http://127.0.0.1:${PORT}/version"
echo ""

echo "--- POST /ping ---"
curl -s -X POST "http://127.0.0.1:${PORT}/ping" \
  -H "content-type: text/plain" \
  -d "hello-rb062"
echo ""

echo "--- GET /notfound (expect 404) ---"
curl -s "http://127.0.0.1:${PORT}/notfound"
echo ""

echo ""
echo "SMOKE OK"
