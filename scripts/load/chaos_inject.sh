#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# chaos_inject.sh — Chaos injection for resilience testing (E5.4)
#
# Simulates infrastructure failures:
#   1. PostgreSQL restart (docker restart / systemctl)
#   2. Redis restart
#   3. Brief network partition (iptables DROP — root required)
#
# Usage:
#   bash scripts/load/chaos_inject.sh [pg|redis|network|all]
#
# Env vars:
#   OTK_PG_CONTAINER    — Docker container name for PG (default: otk-postgres)
#   OTK_REDIS_CONTAINER — Docker container name for Redis (default: otk-redis)
#   CHAOS_DURATION_S    — Duration of chaos in seconds (default: 10)
#
# Exit code: 1 for an unknown mode, otherwise 0; a failed docker restart is logged as a warning, not fatal.
# The "network" mode does not change anything: it only prints the iptables commands to run by hand.
#
# @since Wave 4 (4B-PACK-4B03 / E5.4)
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

PG_CONTAINER="${OTK_PG_CONTAINER:-otk-postgres}"
REDIS_CONTAINER="${OTK_REDIS_CONTAINER:-otk-redis}"
CHAOS_DURATION="${CHAOS_DURATION_S:-10}"
MODE="${1:-all}"

log() { echo "[chaos] $(date -u +%H:%M:%SZ) $*"; }

inject_pg() {
  log "Injecting PG chaos: restarting $PG_CONTAINER for ${CHAOS_DURATION}s"
  if command -v docker &>/dev/null; then
    docker restart "$PG_CONTAINER" 2>/dev/null && log "PG restarted" || log "WARNING: docker restart failed (PG may not be running in Docker)"
    sleep "$CHAOS_DURATION"
    log "PG chaos complete"
  else
    log "WARNING: docker not found — skipping PG chaos"
  fi
}

inject_redis() {
  log "Injecting Redis chaos: restarting $REDIS_CONTAINER for ${CHAOS_DURATION}s"
  if command -v docker &>/dev/null; then
    docker restart "$REDIS_CONTAINER" 2>/dev/null && log "Redis restarted" || log "WARNING: docker restart failed (Redis may not be running in Docker)"
    sleep "$CHAOS_DURATION"
    log "Redis chaos complete"
  else
    log "WARNING: docker not found — skipping Redis chaos"
  fi
}

inject_network() {
  log "Injecting network chaos: not implemented without root (iptables required)"
  log "Manual: iptables -A INPUT -p tcp --dport 5432 -j DROP && sleep ${CHAOS_DURATION} && iptables -D INPUT -p tcp --dport 5432 -j DROP"
}

case "$MODE" in
  pg)      inject_pg ;;
  redis)   inject_redis ;;
  network) inject_network ;;
  all)
    inject_pg
    inject_redis
    inject_network
    ;;
  *)
    echo "Usage: $0 [pg|redis|network|all]"
    exit 1
    ;;
esac

log "Chaos injection complete (mode: $MODE)"
