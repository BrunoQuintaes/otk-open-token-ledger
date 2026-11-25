/**
 * Stand-in for runPilotV3.ts in the live wrapper's tests: calls nothing, only writes the ledger lines a real run
 * would. PV3_STUB_<PHASE> = "paid-ok" (reserve + settle ok, exit 0) | "paid:<exit>" (reserve + settle uncertain)
 * | "nopaid:<exit>" (no ledger line). Each invocation appends its phase to PV3_STUB_LOG.
 *
 * Used by `test/unit/pilot_v3_live_wrapper.test.ts`, which passes this file to
 * `scripts/pilot/anthropic/run_live_pv3.sh` as the runner; it is a child-process script, not a
 * test file, and is not run directly.
 *
 * Arguments: `--phase=<name>` (required). Environment variable names read: `PV3_STUB_<PHASE>`
 * (outcome; default `paid-ok`), `PV3_STUB_LOG` (file that records each phase) and
 * `OTK_PILOT_LEDGER` (the ledger file that receives the reserve/settle lines). The amounts written
 * are fixed fake values in USD.
 *
 * Exit code: 0 for `paid-ok`, otherwise the number after the colon. It never contacts a provider
 * and spends nothing.
 *
 * @module test/unit/fixtures/pilot_v3_stub_runner
 */
import fs from 'node:fs';

const phase = process.argv.find((a) => a.startsWith('--phase='))!.slice('--phase='.length);
const [kind, code] = (process.env[`PV3_STUB_${phase.toUpperCase()}`] ?? 'paid-ok').split(':');
fs.appendFileSync(process.env['PV3_STUB_LOG']!, `${phase}\n`);
const ledger = process.env['OTK_PILOT_LEDGER']!;
const id = `${phase}-${process.pid}`;
if (kind !== 'nopaid') fs.appendFileSync(ledger, `${JSON.stringify({ type: 'reserve', id, reservedUsd: 0.40008 })}\n`);
if (kind === 'paid-ok') fs.appendFileSync(ledger, `${JSON.stringify({ type: 'settle', id, outcome: 'ok', costUsd: 0.00005 })}\n`);
if (kind === 'paid') fs.appendFileSync(ledger, `${JSON.stringify({ type: 'settle', id, outcome: 'uncertain' })}\n`);
process.exit(kind === 'paid-ok' ? 0 : Number(code));
