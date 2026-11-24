#!/usr/bin/env bash
# OVERNIGHT 2 — real campaign phases, strictly serial, through runPilotV3.ts (same safety rules as run_live_pv3.sh).
#   bash scripts/pilot/campaign/run_campaign_ovn2.sh --provider=anthropic|openai|gemini35 <phase> [runner args...]
#   phases: campaign | cacheprobe | besu | minimal
# Output root: docs/_ops/OVERNIGHT2_20261006/campaign/<provider>/<phase>[_<slice>]; canonical cumulative ledger per provider
# (<HOME>/otk-pilot/<provider>_budget_ledger.jsonl, US$ 3 cap each, already holding the 03-04/10 spend).
#
# Credential: the runner process gets the provider keys with `node --env-file=.env` (Node parses the file; this shell
# never reads, sources or prints it). The runner passes only its own provider's key to the OTK child.
#
# A phase MAY HAVE PAID iff the canonical ledger gained a reservation while it ran (counted by ledgerCounts.mjs):
#   exit 0 → <phase>.done (never run again); exit ≠ 0 with a new reservation → STOP (nothing more runs for this provider
#   until a human decides); exit ≠ 0 without a new reservation → nothing was called. Open or uncertain reservations in the
#   ledger block the run. One invocation at a time (mkdir lock).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/../../.."
PROVIDER=""
case "${1:-}" in --provider=*) PROVIDER="${1#--provider=}"; shift;; esac
PHASE="${1:-}"; shift || true
case "$PROVIDER" in anthropic) KEY_VAR=ANTHROPIC_API_KEY;; openai) KEY_VAR=OPENAI_API_KEY;; gemini35) KEY_VAR=GEMINI_API_KEY;; *) echo "provider must be anthropic|openai|gemini35" >&2; exit 4;; esac
case "$PHASE" in campaign|cacheprobe|besu|minimal) ;; *) echo "unknown phase '$PHASE' (nothing run)" >&2; exit 4;; esac
M=docs/_ops/OVERNIGHT2_20261006
LEDGER=<HOME>/otk-pilot/${PROVIDER%35}_budget_ledger.jsonl
SLICE=""; for a in "$@"; do case "$a" in --start-index=*|--max-calls=*) SLICE="${SLICE}_${a#--}";; esac; done
TAG="$PHASE${SLICE//=/-}"
OUT_ROOT=$M/campaign/$PROVIDER
mkdir -p "$OUT_ROOT"
LOCK=$M/campaign/.lock
if ! mkdir "$LOCK" 2>/dev/null; then echo "another campaign invocation holds $LOCK" >&2; exit 1; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
if [ -e "$OUT_ROOT/STOP" ]; then echo "STOP present ($(cat "$OUT_ROOT/STOP")): nothing runs until a human decides" >&2; exit 1; fi
if [ -e "$OUT_ROOT/$TAG.done" ]; then echo "$TAG already done; not repeated"; exit 0; fi
stop_nopay() { rm -f "$OUT_ROOT/$TAG.started"; echo "$1 (nothing run)" >&2; exit 4; }
stop() { echo "$1 $(date -Iseconds)" > "$OUT_ROOT/STOP"; echo "STOP: $1" >&2; exit 1; }
counts() { node scripts/pilot/anthropic/ledgerCounts.mjs "$LEDGER" || stop "canonical ledger unreadable ($LEDGER)"; }
reservations() { local c; c=$(counts) || exit 1; echo "${c%% *}"; }
exposure() { local c r o u; c=$(counts) || exit 1; read -r r o u <<< "$c"; echo $(( o + u )); }

# credential presence only (name, never the value); the shell does not read .env
node --env-file=.env -e "process.exit(process.env['$KEY_VAR'] && /^[A-Za-z0-9_.\-]+\$/.test(process.env['$KEY_VAR']) ? 0 : 3)" 2>/dev/null
[ $? -eq 0 ] && echo "credential: $KEY_VAR = SET" || { echo "credential: $KEY_VAR missing or malformed; nothing run" >&2; exit 3; }

BESU_DIR_ARG="${OTK_PILOT_BESU_DIR:-}"
source $M/tools/ovn2_env.sh
export OTK_PILOT_PG_URL="$OTK_TEST_PG_URL"
unset OTK_PILOT_LEDGER
ex=$(exposure) || exit 1
if [ "$ex" -gt 0 ]; then echo "ledger has $ex open/uncertain reservation(s): blocked (human decision required)" >&2; exit 1; fi
r0=$(reservations) || exit 1; echo "$r0" > "$OUT_ROOT/$TAG.started"
extra=(); [ "$PHASE" = besu ] && { [ -n "$BESU_DIR_ARG" ] || stop_nopay "OTK_PILOT_BESU_DIR required for besu"; extra=(--besu-dir="$BESU_DIR_ARG"); }
echo "batch provider=$PROVIDER phase=$TAG head=$(git rev-parse HEAD) dirty=$(git status --porcelain --untracked-files=no | wc -l) start=$(date -Iseconds)" >> "$OUT_ROOT/EXIT_CODES.txt"
node --env-file=.env --import tsx scripts/pilot/anthropic/runPilotV3.ts --provider="$PROVIDER" --mode=live --phase="$PHASE" --out="$OUT_ROOT/$TAG" "${extra[@]}" "$@" > "$OUT_ROOT/$TAG.log" 2>&1
rc=$?
r1=$(reservations) || exit 1
echo "$TAG exit=$rc reservations=$r0->$r1 end=$(date -Iseconds)" >> "$OUT_ROOT/EXIT_CODES.txt"
if [ "$rc" -eq 0 ]; then date -Iseconds > "$OUT_ROOT/$TAG.done"; rm -f "$OUT_ROOT/$TAG.started"; echo "$TAG: ok"; exit 0; fi
if [ "$r1" -gt "$r0" ]; then stop "$TAG exit=$rc after $(( r1 - r0 )) ledger reservation(s); see $OUT_ROOT/$TAG.log"; fi
rm -f "$OUT_ROOT/$TAG.started"
echo "$TAG: exit $rc with no ledger reservation (nothing was called); see $OUT_ROOT/$TAG.log" >&2; exit "$rc"
