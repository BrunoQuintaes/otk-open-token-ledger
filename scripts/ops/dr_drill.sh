#!/usr/bin/env bash
# =============================================================================
# dr_drill.sh — OTK zk-Metering Disaster Recovery Drill
# =============================================================================
# Validates disaster recovery readiness:
#   1. PostgreSQL connection + backup dry-run
#   2. Redis PING
#   3. Prints DR checklist for manual execution
#
# Usage:
#   bash scripts/ops/dr_drill.sh
#
# Environment variables (optional — reads from shell or .env.dr):
#   OTK_DB_URL    — PostgreSQL connection string (postgres://user:pass@host:port/db)
#   OTK_REDIS_URL — Redis URL (redis://host:port)
#   PG_DUMP       — path to pg_dump binary (default: pg_dump)
#   REDIS_CLI     — path to redis-cli binary (default: redis-cli)
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
# =============================================================================

set -euo pipefail

# ─── Colour helpers ──────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $*"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $*"; }
info() { echo -e "  ${CYAN}[INFO]${NC} $*"; }

DRILL_TS=$(date -u +"%Y%m%dT%H%M%SZ")
FAILURES=0

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " OTK DR Drill — ${DRILL_TS}"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── 1. PostgreSQL ───────────────────────────────────────────────────────────

echo "── Step 1: PostgreSQL Backup Readiness ──"
echo ""

DB_URL="${OTK_DB_URL:-}"
PG_DUMP_BIN="${PG_DUMP:-pg_dump}"

if [[ -z "$DB_URL" ]]; then
  warn "OTK_DB_URL not set — skipping live PG check"
  warn "Set OTK_DB_URL=postgres://user:pass@host:port/dbname to enable"
else
  info "PG URL: ${DB_URL//:*@/:**@}"  # mask password

  # Check pg_dump binary exists
  if command -v "$PG_DUMP_BIN" &>/dev/null; then
    pass "pg_dump binary found: $(command -v "$PG_DUMP_BIN")"

    # Dry-run: list tables only (no actual data dump)
    info "Running pg_dump --schema-only dry-run..."
    if "$PG_DUMP_BIN" --schema-only --no-password "$DB_URL" > /dev/null 2>&1; then
      pass "pg_dump schema-only succeeded — connection and permissions OK"
    else
      fail "pg_dump schema-only failed — check DB_URL, credentials, and pg_dump version"
      FAILURES=$((FAILURES + 1))
    fi
  else
    warn "pg_dump not found in PATH — install postgresql-client to enable backup checks"
    warn "In production: ensure backup job has pg_dump + write access to backup storage"
  fi
fi

echo ""

# ─── 2. Redis ────────────────────────────────────────────────────────────────

echo "── Step 2: Redis Health Check ──"
echo ""

REDIS_URL="${OTK_REDIS_URL:-}"
REDIS_CLI_BIN="${REDIS_CLI:-redis-cli}"

if [[ -z "$REDIS_URL" ]]; then
  warn "OTK_REDIS_URL not set — skipping live Redis check"
  warn "Set OTK_REDIS_URL=redis://host:port to enable"
else
  info "Redis URL: $REDIS_URL"

  if command -v "$REDIS_CLI_BIN" &>/dev/null; then
    pass "redis-cli binary found: $(command -v "$REDIS_CLI_BIN")"

    # Parse host/port from URL (handles redis://host:port format)
    REDIS_HOST=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f1)
    REDIS_PORT=$(echo "$REDIS_URL" | sed 's|redis://||' | cut -d: -f2 | cut -d/ -f1)
    REDIS_PORT="${REDIS_PORT:-6379}"

    info "PING to ${REDIS_HOST}:${REDIS_PORT}..."
    PING_RESULT=$("$REDIS_CLI_BIN" -h "$REDIS_HOST" -p "$REDIS_PORT" PING 2>&1 || true)
    if [[ "$PING_RESULT" == "PONG" ]]; then
      pass "Redis PING → PONG"
    else
      fail "Redis PING failed: ${PING_RESULT}"
      FAILURES=$((FAILURES + 1))
    fi
  else
    warn "redis-cli not found in PATH — install redis-tools to enable Redis checks"
    warn "In production: use healthcheck endpoint or K8s liveness probe instead"
  fi
fi

echo ""

# ─── 3. DR Checklist ─────────────────────────────────────────────────────────

echo "── Step 3: Manual DR Checklist ──"
echo ""
echo "  The following steps require human execution in a real DR scenario."
echo "  Verify each item has been documented and tested in staging."
echo ""
echo "  CATEGORY A — Data Backup"
echo "  [ ] PostgreSQL: pg_dump to S3/GCS runs on schedule (check crontab or K8s CronJob)"
echo "  [ ] PostgreSQL: last successful backup timestamp < 24 hours ago"
echo "  [ ] PostgreSQL: backup file is non-empty and readable"
echo "  [ ] Redis: RDB snapshot (BGSAVE) or AOF persistence enabled"
echo "  [ ] ZK keys: zk/keys/metering_v2_final_mpc.zkey is backed up (immutable — MPC ceremony)"
echo ""
echo "  CATEGORY B — Recovery Procedure"
echo "  [ ] Clone DB: pg_restore --clean --if-exists from latest backup to standby instance"
echo "  [ ] Verify row counts: SELECT COUNT(*) FROM receipts; matches backup metadata"
echo "  [ ] Flush Redis: FLUSHALL on standby, then replay from RDB/AOF"
echo "  [ ] API restart: deploy with standby DB_URL + REDIS_URL → health check passes"
echo "  [ ] Smoke test: POST /receipts + GET /health on restored environment"
echo ""
echo "  CATEGORY C — Failover"
echo "  [ ] DNS/LB cutover: update ingress to point to standby environment"
echo "  [ ] RTO target: < 30 minutes from incident declaration to service restored"
echo "  [ ] RPO target: < 1 hour (maximum data loss acceptable)"
echo "  [ ] Notify stakeholders: incident comms via status page (/status)"
echo ""
echo "  CATEGORY D — Post-Drill"
echo "  [ ] Document actual RTO/RPO achieved in docs/_ops/ga/"
echo "  [ ] Update DR runbook if gaps were found"
echo "  [ ] Confirm backup schedule and retention policy (OTK_RECEIPT_RETENTION_DAYS)"
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════"
if [[ $FAILURES -eq 0 ]]; then
  echo -e "  ${GREEN}DR Drill: PASS${NC} — automated checks OK"
  echo "  Run the manual checklist above in staging to complete the drill."
  echo "  Archive results in: docs/_ops/ga/DR_DRILL_${DRILL_TS}/"
else
  echo -e "  ${RED}DR Drill: FAIL${NC} — ${FAILURES} check(s) failed"
  echo "  Fix the failures above before executing a live DR drill."
fi
echo "══════════════════════════════════════════════"
echo ""

exit $FAILURES
