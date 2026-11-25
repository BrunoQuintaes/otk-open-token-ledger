/**
 * C157 §9.2 (pilots): registers in the study LEDGER the ONE financial duplication of a pilot batch cap ("mediante registro no ledger", "só pode ser aplicada uma
 * vez, dentro das mesmas dez operações", "teto absoluto após uma eventual duplicação: US$ 0,60").
 *
 * WHAT IT PERMITS (and nothing else): record, once per batch, that the batch cap went from X to exactly 2X, never above US$ 0.60 (enforced here from the plan,
 * and by the ledger: exactly 2x, once, <= 25 % of the sub-ledger). It needs a signature of the form `human:<name> (C157 §9.2 ...)` (the executor only checks the
 * prefix `human:`; the citation of the order is demanded here) and a reason of at least 10 characters.
 * WHAT IT DOES NOT DO: it does not add spending capacity by itself. The plan already refuses a batch cap below the sum of the reservations, and every settlement
 * above its reservation stops the batch (STOP_CAP_VIOLATION), so the 10 operations fit the base cap. It does not change the number of calls, the provider
 * sub-ledger, the campaign cap, the plan or the GO (a GO whose perBatchUsd is the base cap keeps matching the plan). In practice it is a signed, replayable
 * record; extra margin for the same ten operations would need a NEW plan (new hash, new GO) and the author's decision.
 * Offline, no network, no secret.
 *
 * Called by the CLI entry point (`./main.ts`); it reads the plan (`./plan.ts`) and the ledger opening (`./run.ts`) and
 * appends the raise through the ledger (`../core/ledger.ts`), which writes `<campaignDir>/ledger.jsonl`.
 *
 * @module scripts/h2eval/cli/capraise
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { BudgetStop, openLedger, picoToUsdString, usdToPico } from '../core/ledger.js';
import { readPlan, PILOT_ABSOLUTE_BATCH_CAP_USD } from './plan.js';
import { readLedgerOpening } from './run.js';
import { CliError, EXIT } from './common.js';

/**
 * Records in the campaign ledger the single allowed doubling of a pilot batch cap.
 *
 * @param planFile - Path of the pilot plan (must declare a pilot list and the absolute pilot batch ceiling).
 * @param campaignDir - Campaign folder holding `ledger.jsonl`.
 * @param batchId - Batch whose cap is doubled.
 * @param signedBy - Signature; must start with `human:` and cite the order that allows the doubling (section 9.2).
 * @param reason - Why the raise is needed; at least 10 characters after trimming.
 * @param clock - Optional clock returning an ISO-8601 UTC timestamp, for tests.
 * @returns The batch, the cap before and after (USD text), the absolute ceiling, the signature and the ledger path.
 * @throws {@link CliError} PLAN_INVALID when the batch is not in the plan or the plan ceiling is not the expected
 *   one; REFUSED_BY_POLICY when the plan is not a pilot plan, the signature is invalid, the doubled cap exceeds the
 *   ceiling or the ledger refuses the raise; USAGE when the reason is too short or the ledger is missing.
 */
export function raiseBatchCapFromPlan(planFile: string, campaignDir: string, batchId: string, signedBy: string, reason: string, clock?: () => string): { batchId: string; fromUsd: string; toUsd: string; absoluteCeilingUsd: string; signedBy: string; ledger: string } {
  const plan = readPlan(planFile); const batch = plan.batches.find((b) => b.batchId === batchId);
  if (!batch) throw new CliError(EXIT.PLAN_INVALID, 'BATCH_NOT_IN_PLAN', batchId);
  if (!plan.pilotList || plan.pilotAbsoluteBatchCapUsd === undefined) throw new CliError(EXIT.REFUSED_BY_POLICY, 'CAP_RAISE_ONLY_FOR_PILOT_PLANS', 'the duplication exists only for pilot plans (C157 9.2)');
  if (!/^human:\S/.test(signedBy)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'CAP_RAISE_REFUSED:cap_raise_unsigned', 'signature must start with human:');
  if (!/C157/.test(signedBy) || !/9\.2/.test(signedBy)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'CAP_RAISE_REFUSED:signature_must_cite_C157_9_2', 'signedBy must cite the order, e.g. "human:<name> (C157 §9.2 ...)"');
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new CliError(EXIT.USAGE, 'ARGS', '--reason "<why>" with at least 10 characters');
  const ledgerPath = path.join(campaignDir, 'ledger.jsonl');
  if (!existsSync(ledgerPath)) throw new CliError(EXIT.USAGE, 'LEDGER_MISSING', ledgerPath);
  const ceiling = usdToPico(plan.pilotAbsoluteBatchCapUsd);
  if (ceiling !== usdToPico(PILOT_ABSOLUTE_BATCH_CAP_USD)) throw new CliError(EXIT.PLAN_INVALID, 'PILOT_CEILING_NOT_C157', `plan ceiling ${plan.pilotAbsoluteBatchCapUsd} != ${PILOT_ABSOLUTE_BATCH_CAP_USD}`);
  const from = BigInt(batch.batchCapUsdPico); const to = from * 2n;
  if (to > ceiling) throw new CliError(EXIT.REFUSED_BY_POLICY, 'CAP_RAISE_REFUSED:cap_raise_above_absolute_ceiling', `doubling ${picoToUsdString(from)} gives ${picoToUsdString(to)} > absolute ceiling ${picoToUsdString(ceiling)} (C157 9.2)`);
  const ledger = openLedger(ledgerPath, { campaignUsd: plan.policy.capsUsd.campaign, providersUsd: plan.policy.capsUsd.providers, batchesUsd: { [batchId]: picoToUsdString(from) } }, clock, readLedgerOpening(campaignDir));
  try {
    const r = ledger.raiseBatchCap(batchId, batch.provider, to, signedBy, reason);
    return { batchId, fromUsd: picoToUsdString(BigInt(r.fromPico)), toUsd: picoToUsdString(BigInt(r.toPico)), absoluteCeilingUsd: picoToUsdString(ceiling), signedBy, ledger: ledgerPath };
  } catch (e) {
    if (e instanceof BudgetStop) throw new CliError(EXIT.REFUSED_BY_POLICY, `CAP_RAISE_REFUSED:${e.detail['reason'] ?? e.reason}`, JSON.stringify(e.detail));
    throw e;
  }
}
