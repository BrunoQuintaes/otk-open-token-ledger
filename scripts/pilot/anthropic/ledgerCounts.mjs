// PILOTO_V3 — counts of the canonical budget ledger for run_live_pv3.sh, by parsing (never by text pattern).
//   node scripts/pilot/anthropic/ledgerCounts.mjs <ledger.jsonl>   →   "<reservations> <open> <uncertain>"
// A missing ledger is "0 0 0". Any line that is not a JSON reserve/settle entry, or a settle without its
// reservation, exits 2: the caller must treat an unreadable ledger as possibly paid (fail closed).
/**
 * Prints `<reservations> <open> <uncertain>` for a budget ledger written by `budgetLedger.ts`.
 *
 * "open" = reserved and not settled; "uncertain" = settled with an outcome other than `ok` or `refused`. A
 * duplicated reservation id or settlement also exits 2. Called by `run_live_pv3.sh` and
 * `scripts/pilot/campaign/run_campaign_ovn2.sh` before and after each phase. Read-only; no environment variables.
 *
 * @module scripts/pilot/anthropic/ledgerCounts
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: ledgerCounts.mjs <ledger.jsonl>'); process.exit(2); }
if (!fs.existsSync(file)) { console.log('0 0 0'); process.exit(0); }
const reserved = new Set();
const settled = new Map();
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (const [i, raw] of lines.entries()) {
  if (raw.trim() === '') continue;
  let e;
  try { e = JSON.parse(raw); } catch { console.error(`line ${i + 1}: not JSON`); process.exit(2); }
  if (e?.type === 'reserve' && typeof e.id === 'string' && !reserved.has(e.id)) reserved.add(e.id);
  else if (e?.type === 'settle' && typeof e.id === 'string' && reserved.has(e.id) && !settled.has(e.id)) settled.set(e.id, e.outcome);
  else { console.error(`line ${i + 1}: unexpected ledger entry`); process.exit(2); }
}
const uncertain = [...settled.values()].filter((o) => o !== 'ok' && o !== 'refused').length;
console.log(`${reserved.size} ${reserved.size - settled.size} ${uncertain}`);
