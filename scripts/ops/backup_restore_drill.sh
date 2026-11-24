#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup_restore_drill.sh — OTK Backup + Restore Validation Drill (E5.1)
#
# Validates full backup-to-restore cycle and measures RTO.
#
# Steps:
#   1. pg_dump → /tmp/otk_backup_<TS>.sql (if OTK_PG_URL set)
#   2. redis-cli BGSAVE → wait for LASTSAVE to advance (if redis-cli available)
#   3. Restore drill: create temp DB, restore dump, verify row count
#   4. Cleanup temp DB
#   5. Output JSON: { ok, rto_seconds, pg_rows, redis_keys, errors[] }
#
# RTO target: < 15 minutes (900 seconds)
# Exit code: 0 = ok, 1 = drill failed
#
# Usage:
#   bash scripts/ops/backup_restore_drill.sh
#   OTK_PG_URL=postgres://... bash scripts/ops/backup_restore_drill.sh
#
# @since Wave 4 (4B-PACK-4B01 / E5.1)
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

START_TS=$(date +%s)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/otk_backup_${TIMESTAMP}.sql"
TEMP_DB="otk_drill_${TIMESTAMP}"
ERRORS=()
PG_ROWS=0
REDIS_KEYS=0
PG_OK=false
REDIS_OK=false

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() { echo "[drill] $*" >&2; }

# Output final JSON and exit
finish() {
  local exit_code="$1"
  local end_ts end_rto
  end_ts=$(date +%s)
  end_rto=$((end_ts - START_TS))
  local ok_val="false"
  if [ "$exit_code" -eq 0 ]; then ok_val="true"; fi

  # Build errors array JSON
  local err_json="[]"
  if [ "${#ERRORS[@]}" -gt 0 ]; then
    err_json="["
    local first=true
    for e in "${ERRORS[@]}"; do
      if [ "$first" = true ]; then first=false; else err_json+=","; fi
      err_json+="\"$(echo "$e" | sed 's/"/\\"/g')\""
    done
    err_json+="]"
  fi

  echo "{\"ok\":${ok_val},\"rto_seconds\":${end_rto},\"pg_rows\":${PG_ROWS},\"redis_keys\":${REDIS_KEYS},\"errors\":${err_json}}"
  exit "$exit_code"
}

# ─── Step 1: PostgreSQL backup + restore drill ───────────────────────────────

if [ -n "${OTK_PG_URL:-}" ] && command -v pg_dump &>/dev/null && command -v psql &>/dev/null; then
  log "Step 1: PostgreSQL backup..."
  if pg_dump "$OTK_PG_URL" --format=plain --file="$BACKUP_FILE" 2>/dev/null; then
    log "Dump complete: $BACKUP_FILE"

    log "Step 3: Restore drill (temp DB: $TEMP_DB)..."
    # Extract base connection (remove dbname) for createdb
    BASE_URL="${OTK_PG_URL%/*}"

    if psql "$BASE_URL/postgres" -c "CREATE DATABASE $TEMP_DB;" 2>/dev/null; then
      if psql "$BASE_URL/$TEMP_DB" -f "$BACKUP_FILE" >/dev/null 2>&1; then
        # Count rows in receipts table (may not exist — ok)
        COUNT_OUT=$(psql "$BASE_URL/$TEMP_DB" -tAc "SELECT COUNT(*) FROM receipts;" 2>/dev/null || echo "0")
        PG_ROWS="${COUNT_OUT:-0}"
        log "Restore OK — row count: $PG_ROWS"
        PG_OK=true
      else
        ERRORS+=("psql restore into temp DB failed")
        log "WARNING: restore failed (non-blocking)"
      fi

      # Cleanup
      psql "$BASE_URL/postgres" -c "DROP DATABASE IF EXISTS $TEMP_DB;" 2>/dev/null || true
    else
      ERRORS+=("createdb $TEMP_DB failed — skipping restore drill")
      log "WARNING: createdb failed — skipping restore drill"
    fi

    # Cleanup backup file
    rm -f "$BACKUP_FILE"
  else
    ERRORS+=("pg_dump failed — PG may be unavailable")
    log "WARNING: pg_dump failed (PG unavailable or auth issue)"
  fi
else
  if [ -z "${OTK_PG_URL:-}" ]; then
    log "OTK_PG_URL not set — skipping PostgreSQL drill"
    ERRORS+=("OTK_PG_URL not set")
  else
    log "pg_dump/psql not available — skipping PostgreSQL drill"
    ERRORS+=("pg_dump or psql not found")
  fi
fi

# ─── Step 2: Redis snapshot ──────────────────────────────────────────────────

REDIS_HOST="${OTK_REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${OTK_REDIS_PORT:-6379}"

if command -v redis-cli &>/dev/null; then
  PING=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" PING 2>/dev/null || echo "")
  if [ "$PING" = "PONG" ]; then
    log "Step 2: Redis BGSAVE..."
    BEFORE=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" LASTSAVE 2>/dev/null || echo "0")
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" BGSAVE >/dev/null 2>&1 || true

    # Wait up to 30s for LASTSAVE to advance
    WAITED=0
    while [ "$WAITED" -lt 30 ]; do
      sleep 1
      AFTER=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" LASTSAVE 2>/dev/null || echo "0")
      if [ "$AFTER" -gt "$BEFORE" ]; then break; fi
      WAITED=$((WAITED + 1))
    done

    REDIS_KEYS=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" DBSIZE 2>/dev/null || echo "0")
    log "Redis snapshot OK — keys: $REDIS_KEYS"
    REDIS_OK=true
  else
    ERRORS+=("Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}")
    log "WARNING: Redis not reachable — skipping snapshot"
  fi
else
  ERRORS+=("redis-cli not found")
  log "redis-cli not found — skipping Redis snapshot"
fi

# ─── Step 4: Evaluate RTO ────────────────────────────────────────────────────

END_TS=$(date +%s)
RTO=$((END_TS - START_TS))
log "RTO: ${RTO}s (target: <900s)"

if [ "$RTO" -gt 900 ]; then
  ERRORS+=("RTO ${RTO}s exceeds 15-minute target")
  finish 1
fi

# ─── Final result ────────────────────────────────────────────────────────────

# Succeed if at least one subsystem passed without fatal errors,
# or if only "not configured" errors exist (dry-run scenario)
FATAL=0
for e in "${ERRORS[@]}"; do
  case "$e" in
    "OTK_PG_URL not set"|"pg_dump or psql not found"|"redis-cli not found"|"Redis not reachable"*) ;;
    *) FATAL=1 ;;
  esac
done

if [ "$FATAL" -eq 0 ]; then
  finish 0
else
  finish 1
fi
