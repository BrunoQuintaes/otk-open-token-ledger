#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# backup.sh — OTK zk-Metering backup script
#
# Backs up:
#   1. PostgreSQL database (pg_dump) if OTK_DB_URL is set
#   2. JSONL files: receipt log, dead-letter log, governance log, tenant log
#
# Output: timestamped directory in OTK_BACKUP_DIR (default: backups/)
#
# Usage:
#   bash scripts/ops/backup.sh
#   OTK_BACKUP_DIR=/mnt/backups bash scripts/ops/backup.sh
#
# @since Wave 2 Pack 15 (E3.3)
# ───────────────────────────────────────────────────────────────

set -euo pipefail
# RV-RUNS-10 (RUN-S review): backups hold data of every tenant; readable only by the owner
umask 077

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${OTK_BACKUP_DIR:-backups}"
BACKUP_PATH="${BACKUP_DIR}/backup_${TIMESTAMP}"

mkdir -p "$BACKUP_PATH"
# RV2-RUNS-03 (RUN-S review): any abnormal exit (including a set -e abort, e.g. a failing cp) marks the directory failed
# M24-O04 (RUN-M1-24H): after SIGTERM/SIGINT the EXIT trap sees $? = 0, so an interrupted backup kept the name of a good
# one; the decision now depends on reaching the end of the script, and the signals exit non-zero
COMPLETED=0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
_mark_failed_on_error() {
  local rc=$?
  if [ "$COMPLETED" -ne 1 ] && [ -d "$BACKUP_PATH" ]; then
    if mv "$BACKUP_PATH" "${BACKUP_PATH}.FAILED" 2>/dev/null; then
      echo "[backup] FAILED (exit $rc): partial files kept in ${BACKUP_PATH}.FAILED"
    else
      echo "[backup] FAILED (exit $rc): could not rename $BACKUP_PATH; it is NOT a complete backup"
    fi
  fi
}
trap _mark_failed_on_error EXIT
# NF-05 (RUN-S 2026-10-09): a backup that saved nothing, or missed a configured source, must not exit 0
FAILURES=0
fail_source() { echo "[backup] ERROR: $1"; FAILURES=$((FAILURES + 1)); }

echo "[backup] Starting backup → $BACKUP_PATH"

# ─── 1. PostgreSQL dump ─────────────────────────────────────
if [ -n "${OTK_DB_URL:-}" ]; then
  echo "[backup] Dumping PostgreSQL..."
  if command -v pg_dump &> /dev/null; then
    # stderr is not echoed: it can repeat the connection string
    if pg_dump "$OTK_DB_URL" --format=custom --file="${BACKUP_PATH}/pg_dump_${TIMESTAMP}.dump" 2>"${BACKUP_PATH}/.pg_dump.err"         && [ -s "${BACKUP_PATH}/pg_dump_${TIMESTAMP}.dump" ]; then
      echo "[backup] PostgreSQL dump complete"
    else
      rm -f "${BACKUP_PATH}/pg_dump_${TIMESTAMP}.dump"
      fail_source "pg_dump failed or produced an empty dump (OTK_DB_URL is set)"
    fi
    rm -f "${BACKUP_PATH}/.pg_dump.err"
  else
    fail_source "pg_dump not found but OTK_DB_URL is set: database not backed up"
  fi
else
  echo "[backup] OTK_DB_URL not set — skipping database backup"
fi

# ─── 2. JSONL log files ─────────────────────────────────────
copy_if_exists() {
  local src="$1"
  local dest_name="$2"
  if [ -z "${src:-}" ]; then
    echo "[backup] Skipped $dest_name (not configured)"
  elif [ -f "$src" ]; then
    cp "$src" "${BACKUP_PATH}/${dest_name}"
    echo "[backup] Copied $src → ${dest_name}"
    # RV-RUNS-03 (RUN-S review): a configured source that is empty is not a backup of that source
    [ -s "${BACKUP_PATH}/${dest_name}" ] || fail_source "configured source is empty: $src"
  else
    fail_source "configured source not found: $src"
  fi
}

copy_if_exists "${OTK_RECEIPT_LOG:-}" "receipt_log_${TIMESTAMP}.jsonl"
copy_if_exists "${OTK_DEAD_LETTER_LOG:-}" "dead_letter_log_${TIMESTAMP}.jsonl"
copy_if_exists "${OTK_GOVERNANCE_LOG:-}" "governance_log_${TIMESTAMP}.jsonl"
copy_if_exists "${OTK_TENANT_LOG:-}" "tenant_log_${TIMESTAMP}.jsonl"
copy_if_exists "${OTK_PROOF_QUEUE_LOG:-}" "proof_queue_log_${TIMESTAMP}.jsonl"

# ─── 3. Chain head ──────────────────────────────────────────
if [ -n "${OTK_RECEIPT_LOG:-}" ] && [ -f "${OTK_RECEIPT_LOG}.head" ]; then
  cp "${OTK_RECEIPT_LOG}.head" "${BACKUP_PATH}/chain_head_${TIMESTAMP}.txt"
  echo "[backup] Copied chain head"
fi

# ─── Summary ────────────────────────────────────────────────
# RV-RUNS-03 (RUN-S review): the primary source of truth must be part of the backup
if [ -z "${OTK_DB_URL:-}" ] && [ -z "${OTK_RECEIPT_LOG:-}" ]; then
  fail_source "no primary source configured (set OTK_DB_URL or OTK_RECEIPT_LOG)"
fi
FILE_COUNT=$(find "$BACKUP_PATH" -type f | wc -l)
NONEMPTY_COUNT=$(find "$BACKUP_PATH" -type f -size +0c | wc -l)
if [ "$NONEMPTY_COUNT" -eq 0 ]; then
  fail_source "no file with content was backed up (${FILE_COUNT} file(s))"
fi
if [ "$FILE_COUNT" -gt 0 ]; then
  # portable listing (RV-RUNS-10: no GNU-only find -printf)
  (cd "$BACKUP_PATH" && find . -type f ! -name SHA256SUMS | sed 's#^\./##' | sort | xargs sha256sum > SHA256SUMS \
    && sha256sum -c --quiet SHA256SUMS) || fail_source "checksum manifest could not be written or verified"
fi
if [ "$FAILURES" -gt 0 ]; then
  # RV-RUNS-10 (RUN-S review): a failed directory never keeps the name of a good backup
  mv "$BACKUP_PATH" "${BACKUP_PATH}.FAILED" 2>/dev/null || true
  echo "[backup] FAILED: ${FAILURES} problem(s); ${FILE_COUNT} file(s) in ${BACKUP_PATH}.FAILED are NOT a complete backup"
  exit 1
fi
COMPLETED=1
echo "[backup] Complete: ${FILE_COUNT} file(s) in $BACKUP_PATH (SHA256SUMS verified)"
echo "[backup] Timestamp: $TIMESTAMP"
