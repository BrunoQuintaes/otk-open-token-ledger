/**
 * R15 — H2-EVAL executor CLI (entry). Run with:  node node_modules/tsx/dist/cli.mjs scripts/h2eval/cli/main.ts <command> [--opts]
 *   freeze-corpus --out <new dir> [--seed N] [--repo <clone>] [--s2 N] [--s3 N] [--prefix-chars N] [--groups-per-cell N (C154; default 8)] [--split-plan <json> (C154/R5: composicao explicita por celula e braco)] [--repeats-per-cell N (C154/R5; default 3)] [--no-repo-scan]
 *   plan --phase pilot --pilot-prompts <closed list json (otk.n5.pilot_prompts.v1|v2)> [--pilot-list-sha <hex64 expected>] [--batch-cap-usd <usd; can only lower the rule>] --corpus <NEW dir: the pilot corpus is materialised here> --prereg <pilot protocol> ... (C157 §9.2; text only, no cache, no dialogs)
 *   plan --corpus <dir> --prereg <R10_PREREGISTRATION_*.md> (--ratified-sha <hex64> | --unratified-rehearsal) --phase pilot|confirmatory --out <plan.json> [--models a,b] [--design-params <h2eval.design_params.v1 file; default scripts/h2eval/design/R3_2_DESIGN_PARAMS.json>] [--input-bound-factor F] [--input-bound-extra N] [--max-calls N]
 *   run --mode offline --plan <plan.json> --batch <batchId> --batch-dir <new dir> [--corpus <dir>] [--ack-80pct human:<nome>]   (REAL takes the 80 % acknowledgement from the GO's pauseAck80pct)
 *   run --mode real  --real --plan <plan.json> --batch <batchId> --batch-dir <dir> [--go <GO.json>] [--executor-sha <sha>]   (fail-closed; exit 6 before any connection unless every precondition holds)
 *   plan --phase campaign --order-by-split ... => lotes por bloco em ordem travada treino -> comparativo -> validacao -> holdout (R18-R20; a flag e obrigatoria, E2); teto de saida fixo 256
 *   freeze-train / select aceitam --forecast-frozen <forecast_frozen.json> (ECON-02): previsao OUT_MEAN/OUT_LEARN gravada pre-call nos lotes seguintes (E1)
 *   run ... --campaign-dir <dir>  (CAMPAIGN: validacao exige gates/TRAIN_FROZEN.json; holdout exige gates/VALIDATION_SELECTED.json)
 *   freeze-train --plan <plan.json> --campaign-dir <dir>          select --plan <plan.json> --campaign-dir <dir> --profile <profile.json> --selected-by human:<nome>
 *   run-authorized --mode offline|real [--real] --plan <plan.json> --go <GO multilote h2eval.go.multi.v1> --campaign-dir <dir> [--corpus <dir>] [--pilot-protocol-hash <hex>]
 *       (C144: lotes finitos de UM GO, em serie, trinco unico de campanha, ledger de estudo compartilhado (piloto + campanha), G17 por modelo para lotes de campanha,
 *        G16-GOOGLE para o Google, nonce por lote (anti-replay), maxAttempts, pausa 80% com pauseAck80pct ou preAuthorizeTo100pct; STOP_POLICY em cli/run.ts)
 *   init-campaign --campaign-dir <dir> --plan <plan.json> [--created-by human:<nome>] [--control-dir <dir>]   (VNEXT-3/F R15-G-1, R17-V-1: immutable identity + machine control registry; GO pins campaignIdentitySha256 AND campaignDirCanonical)
 *   gate-p1 --campaign-dir <dir> --model <id> --verdict PASS|FAIL --probe-operation-id <hex64> --signed-by human:<nome>   (VNEXT-F R17-V-8: after the P1 probe call; without it the series pauses: PAUSE_PROBE_GATE)
 *   preflight-connectivity --provider anthropic|openai|google --campaign-dir <dir>   (CYCLE2-B proposal: TLS with full verification + unauthenticated GET expecting 401,
 *       NO credential, same environment as the launch; appended to <campaign-dir>/campaign_journal.jsonl; REAL refuses without a fresh PASS of the same env fingerprint)
 *   gate-g17 --campaign-dir <dir> --model <id> --verdict PASS|FAIL|NOT_RUN --pilot-protocol-hash <hex> --signed-by human:<nome>
 *   gate-g16-google --campaign-dir <dir> --verdict PASS|FAIL --signed-by human:<nome> [--dedicated-billing --exposure-limit --billed-outputs --credential]
 *   status --batch-dir <dir> [--plan <plan.json>]     stop --batch-dir <dir>     export --batch-dir <dir> [--out <dataset.jsonl>]
 * Exit codes: 0 ok · 2 usage · 3 refused by policy (seed/ratification) · 4 plan invalid · 5 batch stopped by a STOP reason · 6 REAL preconditions failed · 7 internal.
 * Nothing here prints a credential value; OFFLINE never reads one.
 *
 * In short: this is the command dispatcher of the H2 evaluation executor. It parses the arguments, calls the module
 * for each command (`./freeze.ts`, `./plan.ts`, `./pilot.ts`, `./run.ts`, `./campaign.ts`, `./preflight.ts`,
 * `./status.ts`, `./capraise.ts`), prints one JSON line with the result and returns the exit code. Only `run` and
 * the authorized multi-batch command, in real mode, can contact a provider (and spend); `preflight-connectivity` opens a TLS connection
 * without any credential; the other commands are offline and write only to the folders they are given.
 *
 * @module scripts/h2eval/cli/main
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { CliError, EXIT, REPO_ROOT, executorCodeSha, optFlag, optNum, optStr, parseArgs } from './common.js';
import { freezeCorpus } from './freeze.js';
import { loadPilotList, materializePilotCorpus } from './pilot.js';
import { raiseBatchCapFromPlan } from './capraise.js';
import { buildPlan, readPlan, writePlan } from './plan.js';
import { capsOfProfile } from './plan.js';
import { runFromArgs, runAuthorized, uncertainAckFromArgs, inputReservePolicyFromArgs, modelProbeFromArgs } from './run.js';
import { freezeTrain, selectOnValidation, listGateFiles, writeGateG17, writeGateG16Google, initCampaignIdentity, writeGateP1, controlDirDefault } from './campaign.js';
import { exportDataset, status, stop } from './status.js';
import { preflightConnectivity } from './preflight.js';
import type { MatrixModel } from '../modal/types.js';

const HELP = `h2eval CLI (R15) — commands: freeze-corpus | plan | run --mode offline|real | status | stop | export (see header of scripts/h2eval/cli/main.ts)`;

/**
 * Runs one CLI command and returns its exit code; errors are printed as a JSON line, never thrown.
 *
 * @param argv - Command and options, without the node and script paths.
 * @param out - Output sink for the single JSON result line; defaults to stdout.
 * @returns A code from `EXIT` in `./common.ts` (0 ok, 2 usage, 3 refused, 4 invalid plan, 5 stopped, 6 real-run
 *   preconditions, 7 internal).
 * @example
 * const code = await main(['status', '--batch-dir', 'runs/batch-01'], console.log);
 */
export async function main(argv: readonly string[], out: (s: string) => void = (s) => process.stdout.write(s + '\n')): Promise<number> {
  const a = parseArgs(argv);
  try {
    switch (a.cmd) {
      case null: case 'help': out(HELP); return a.cmd === 'help' ? EXIT.OK : EXIT.USAGE;
      case 'freeze-corpus': {
        const o = optStr(a, 'out'); if (!o) throw new CliError(EXIT.USAGE, 'ARGS', '--out <new dir>');
        const c = freezeCorpus({ out: o, seed: optStr(a, 'seed') ? optNum(a, 'seed', 0) : undefined, repo: optStr(a, 'repo'), s2: optStr(a, 's2') ? optNum(a, 's2', 0) : undefined, s3: optStr(a, 's3') ? optNum(a, 's3', 0) : undefined, prefixChars: optStr(a, 'prefix-chars') ? optNum(a, 'prefix-chars', 0) : undefined, groupsPerCell: optStr(a, 'groups-per-cell') ? optNum(a, 'groups-per-cell', 0) : undefined, splitPlanFile: optStr(a, 'split-plan'), repeatsPerCell: optStr(a, 'repeats-per-cell') ? optNum(a, 'repeats-per-cell', 0) : undefined, noRepoScan: optFlag(a, 'no-repo-scan'), h1CampaignCorpus: optStr(a, 'h1-campaign-corpus'), allowNotCompared: optFlag(a, 'allow-not-compared') });
        out(JSON.stringify({ ok: true, status: c.status, out: c.out, seed: c.seed, corpusSha256: c.corpusSha256, manifestSha256: c.manifestSha256, seedVerdict: c.seedVerdict, collisionVerdict: c.collisionVerdict })); return EXIT.OK;
      }
      case 'plan': {
        const corpus = optStr(a, 'corpus'); const prereg = optStr(a, 'prereg'); const outFile = optStr(a, 'out'); const phase = optStr(a, 'phase');
        if (!corpus || !prereg || !outFile || (phase !== 'pilot' && phase !== 'campaign')) throw new CliError(EXIT.USAGE, 'ARGS', '--corpus <dir> --prereg <md> --phase pilot|campaign --out <plan.json> (--ratified-sha <hex64> | --unratified-rehearsal)');
        const pilotFile = optStr(a, 'pilot-prompts'); let pilotList: ReturnType<typeof loadPilotList> | undefined;
        if (pilotFile) {
          if (phase !== 'pilot') throw new CliError(EXIT.REFUSED_BY_POLICY, 'PILOT_LIST_ONLY_FOR_PILOT', '--pilot-prompts is valid only with --phase pilot');
          pilotList = loadPilotList(pilotFile, optStr(a, 'pilot-list-sha')); // recomputes both hashes; refuses a list that is not the expected one
          mkdirSync(corpus, { recursive: true }); materializePilotCorpus(pilotList, corpus); // minimal pilot corpus: manifest.json + content/<sha256> (the runner reads content by hash)
        }
        const plan = buildPlan({ pilotList, batchCapUsd: optStr(a, 'batch-cap-usd'), capsUsd: capsOfProfile(optStr(a, 'caps-profile')), corpusDir: corpus, preregFile: prereg, ratifiedSha256: optStr(a, 'ratified-sha'), unratifiedRehearsal: optFlag(a, 'unratified-rehearsal'), orderBySplit: optFlag(a, 'order-by-split'), phase: phase === 'pilot' ? 'PILOT' : 'CONFIRMATORY', models: optStr(a, 'models')?.split(',') as MatrixModel[] | undefined, studyId: optStr(a, 'study-id'), designParamsFile: optStr(a, 'design-params'), inputBoundFactor: optStr(a, 'input-bound-factor') ? optNum(a, 'input-bound-factor', 1.25) : undefined, inputBoundExtraTokens: optStr(a, 'input-bound-extra') ? optNum(a, 'input-bound-extra', 64) : undefined, maxCallsPerBatch: optStr(a, 'max-calls') ? optNum(a, 'max-calls', 60) : undefined });
        writePlan(plan, outFile);
        out(JSON.stringify({ ok: true, out: outFile, phase: plan.phase, ratified: plan.preregistration.ratified, protocolHash: plan.protocolHash, design: plan.policy.design, orderBySplit: plan.orderBySplit, pauseForecast: plan.pauseForecast, notPlanned: plan.notPlanned, batches: plan.batches.map((b) => ({ order: b.order, block: b.block, batchId: b.batchId, calls: b.calls, sumCostCapUsdPico: b.sumCostCapUsdPico, batchCapUsdPico: b.batchCapUsdPico, branchLocked: b.branchLocked })), totals: plan.totals })); return EXIT.OK;
      }
      case 'run': {
        const s = await runFromArgs(a, { executorCodeSha: executorCodeSha(REPO_ROOT, optStr(a, 'executor-sha')) });
        out(JSON.stringify({ ok: s.stoppedBy === null, batchId: s.batchId, mode: s.mode, planned: s.planned, executed: s.executed, stoppedBy: s.stoppedBy, states: s.results.map((r) => `${r.operationId.slice(0, 8)}:${r.state}${r.stop ? `/${r.stop}` : ''}${r.replayed ? ' (replay)' : ''}`), ledger: s.ledger }));
        return s.stoppedBy === null ? EXIT.OK : EXIT.STOPPED;
      }
      case 'freeze-train': {
        const p = optStr(a, 'plan'); const c = optStr(a, 'campaign-dir'); if (!p || !c) throw new CliError(EXIT.USAGE, 'ARGS', '--plan <plan.json> --campaign-dir <dir>');
        const ff = optStr(a, 'forecast-frozen'); const art = freezeTrain(readPlan(p), c, undefined, ff ? (JSON.parse(readFileSync(ff, 'utf8')) as import('../record/forecast.js').ForecastFrozen) : null); out(JSON.stringify({ ok: true, gate: 'TRAIN_FROZEN', batches: art.batches.length, sha256OfBatchList: art.sha256OfBatchList, forecastFrozen: art.forecastFrozen?.freezeSha256 ?? null })); return EXIT.OK;
      }
      case 'select': {
        const p = optStr(a, 'plan'); const c = optStr(a, 'campaign-dir'); const pf = optStr(a, 'profile'); const by = optStr(a, 'selected-by');
        if (!p || !c || !pf || !by) throw new CliError(EXIT.USAGE, 'ARGS', '--plan <plan.json> --campaign-dir <dir> --profile <profile.json> --selected-by human:<nome>');
        const prof = JSON.parse(readFileSync(pf, 'utf8')) as Parameters<typeof selectOnValidation>[2];
        const ff = optStr(a, 'forecast-frozen'); const art = selectOnValidation(readPlan(p), c, prof, by, undefined, ff ? (JSON.parse(readFileSync(ff, 'utf8')) as import('../record/forecast.js').ForecastFrozen) : null); out(JSON.stringify({ ok: true, gate: 'VALIDATION_SELECTED', profileId: art.profile.profileId, paramsSha256: art.profile.paramsSha256, validationBatches: art.validationBatches.length, forecastFrozen: art.forecastFrozen?.freezeSha256 ?? null })); return EXIT.OK;
      }
      case 'gates': { const c = optStr(a, 'campaign-dir'); if (!c) throw new CliError(EXIT.USAGE, 'ARGS', '--campaign-dir <dir>'); out(JSON.stringify({ ok: true, gates: listGateFiles(c) })); return EXIT.OK; }
      case 'run-authorized': {
        const mode = optStr(a, 'mode'); const p = optStr(a, 'plan'); const g = optStr(a, 'go'); const c = optStr(a, 'campaign-dir');
        if ((mode !== 'offline' && mode !== 'real') || !p || !g || !c) throw new CliError(EXIT.USAGE, 'ARGS', '--mode offline|real [--real] --plan <plan.json> --go <GO multilote h2eval.go.multi.v1> --campaign-dir <dir> [--corpus <dir>] [--pilot-protocol-hash <hex>]');
        const sha = executorCodeSha(REPO_ROOT, optStr(a, 'executor-sha'));
        const r = await runAuthorized({ planFile: p, goFile: g, campaignDir: c, corpusDir: optStr(a, 'corpus'), mode, realFlag: a.opts['real'] === true, executorCodeSha: sha, pilotProtocolHash: optStr(a, 'pilot-protocol-hash'), controlDir: optStr(a, 'control-dir'), ackUncertain: uncertainAckFromArgs((k) => optStr(a, k)), inputReservePolicy: inputReservePolicyFromArgs((k) => optStr(a, k)), modelProbe: modelProbeFromArgs((k) => optStr(a, k)) });
        out(JSON.stringify({ ok: r.haltedAt === null, mode: r.mode, attempts: `${r.attemptsUsed}/${r.maxAttempts}`, attemptsThisRun: r.attemptsThisRun, attemptsPrior: r.attemptsPrior, executed: r.executed.map((e) => `${e.batchId}:${e.outcome}:${e.executed}/${e.planned}${e.stoppedBy ? `/${e.stoppedBy}(${e.disposition})` : ''}`), isolatedModels: r.isolatedModels, isolatedConditions: r.isolatedConditions, probe: r.probe, haltedAt: r.haltedAt, haltReason: r.haltReason }));
        return r.haltedAt === null ? EXIT.OK : EXIT.STOPPED;
      }
      case 'init-campaign': {
        const c = optStr(a, 'campaign-dir'); const p = optStr(a, 'plan'); if (!c || !p) throw new CliError(EXIT.USAGE, 'ARGS', '--campaign-dir <dir> --plan <plan.json> [--created-by human:<nome>]  (VNEXT-3 R15-G-1: creates CAMPAIGN_IDENTITY.json once; its sha256 goes into the GO)');
        const plan = readPlan(p); const r = initCampaignIdentity(c, { studyId: plan.studyId, corpusSha256: plan.corpus.corpusSha256, createdBy: optStr(a, 'created-by'), controlDir: optStr(a, 'control-dir') });
        const { canonicalPath } = await import('./campaign.js');
        out(JSON.stringify({ ok: true, created: r.created, campaignIdentitySha256: r.sha256, campaignId: r.identity.campaignId, studyId: r.identity.studyId, campaignDirCanonical: canonicalPath(c), controlDir: optStr(a, 'control-dir') ?? controlDirDefault() })); return EXIT.OK;
      }
      case 'preflight-connectivity': {
        const c = optStr(a, 'campaign-dir'); const p = optStr(a, 'provider');
        if (!c || (p !== 'anthropic' && p !== 'openai' && p !== 'google')) throw new CliError(EXIT.USAGE, 'ARGS', '--provider anthropic|openai|google --campaign-dir <dir>');
        const r = await preflightConnectivity({ campaignDir: c, provider: p });
        out(JSON.stringify({ ok: r.verdict === 'PASS', verdict: r.verdict, failCode: r.failCode, host: r.host, tls: r.tls, http: r.http, elapsedMs: r.elapsedMs, nodeVersion: r.nodeVersion, envFingerprint: r.envFingerprint, caPathPresent: r.caPathPresent, useSystemCa: r.useSystemCa, forbiddenEnvPresent: r.forbiddenEnvPresent }));
        return r.verdict === 'PASS' ? EXIT.OK : EXIT.STOPPED;
      }
      case 'gate-p1': {
        const c = optStr(a, 'campaign-dir'); const m = optStr(a, 'model'); const v = optStr(a, 'verdict'); const by = optStr(a, 'signed-by'); const pid = optStr(a, 'probe-operation-id');
        if (!c || !m || !v || !by || !pid) throw new CliError(EXIT.USAGE, 'ARGS', '--campaign-dir <dir> --model <id> --verdict PASS|FAIL --probe-operation-id <hex64> --signed-by human:<nome> [--note <texto>]  (VNEXT-F R17-V-8: P1 gate after the probe call)');
        out(JSON.stringify({ ok: true, file: writeGateP1(c, { model: m, verdict: v as 'PASS' | 'FAIL', probeOperationId: pid, signedBy: by, atUtc: new Date().toISOString(), note: optStr(a, 'note') }) })); return EXIT.OK;
      }
      case 'gate-g17': {
        const c = optStr(a, 'campaign-dir'); const m = optStr(a, 'model'); const v = optStr(a, 'verdict'); const by = optStr(a, 'signed-by'); const ph = optStr(a, 'pilot-protocol-hash');
        if (!c || !m || !v || !by || !ph) throw new CliError(EXIT.USAGE, 'ARGS', '--campaign-dir <dir> --model <id> --verdict PASS|FAIL|NOT_RUN --pilot-protocol-hash <hex> --signed-by human:<nome> [--note <texto>]');
        out(JSON.stringify({ ok: true, file: writeGateG17(c, { model: m, verdict: v as 'PASS' | 'FAIL' | 'NOT_RUN', pilotProtocolHash: ph, signedBy: by, atUtc: new Date().toISOString(), note: optStr(a, 'note') }) })); return EXIT.OK;
      }
      case 'gate-g16-google': {
        const c = optStr(a, 'campaign-dir'); const by = optStr(a, 'signed-by'); const v = optStr(a, 'verdict') ?? 'FAIL';
        if (!c || !by) throw new CliError(EXIT.USAGE, 'ARGS', '--campaign-dir <dir> --verdict PASS|FAIL --signed-by human:<nome> --dedicated-billing --exposure-limit --billed-outputs --credential (cada flag = garantia verificada)');
        out(JSON.stringify({ ok: true, file: writeGateG16Google(c, { verdict: v as 'PASS' | 'FAIL', dedicatedProjectAndBilling: optFlag(a, 'dedicated-billing'), effectiveExposureLimitVerified: optFlag(a, 'exposure-limit'), billedOutputsAndReasoningVerified: optFlag(a, 'billed-outputs'), credentialVerified: optFlag(a, 'credential'), signedBy: by, atUtc: new Date().toISOString() }) })); return EXIT.OK;
      }
      case 'status': {
        const d = optStr(a, 'batch-dir'); if (!d) throw new CliError(EXIT.USAGE, 'ARGS', '--batch-dir <dir>');
        const planFile = optStr(a, 'plan'); const cfg = planFile ? (() => { const p = readPlan(planFile); return { campaignUsd: p.policy.capsUsd.campaign, providersUsd: p.policy.capsUsd.providers }; })() : undefined;
        out(JSON.stringify(status(d, cfg, undefined, optStr(a, 'ledger')))); return EXIT.OK;
      }
      case 'raise-batch-cap': {
        const pl = optStr(a, 'plan'); const cd = optStr(a, 'campaign-dir'); const bt = optStr(a, 'batch'); const by = optStr(a, 'signed-by'); const why = optStr(a, 'reason');
        if (!pl || !cd || !bt || !by || !why) throw new CliError(EXIT.USAGE, 'ARGS', '--plan <plan.json> --campaign-dir <dir> --batch <batchId> --signed-by human:<name> --reason "<why>" (the ONE duplication of the batch cap, C157 9.2; exactly 2x)');
        out(JSON.stringify({ ok: true, ...raiseBatchCapFromPlan(pl, cd, bt, by, why) })); return EXIT.OK;
      }
      case 'stop': { const d = optStr(a, 'batch-dir'); if (!d) throw new CliError(EXIT.USAGE, 'ARGS', '--batch-dir <dir>'); out(JSON.stringify({ ok: true, stopFile: stop(d) })); return EXIT.OK; }
      case 'export': { const d = optStr(a, 'batch-dir'); if (!d) throw new CliError(EXIT.USAGE, 'ARGS', '--batch-dir <dir>'); out(JSON.stringify({ ok: true, ...exportDataset(d, optStr(a, 'out')) })); return EXIT.OK; }
      default: throw new CliError(EXIT.USAGE, 'UNKNOWN_COMMAND', String(a.cmd));
    }
  } catch (e) {
    if (e instanceof CliError) { out(JSON.stringify({ ok: false, code: e.code, message: e.message, exit: e.exit })); return e.exit; }
    out(JSON.stringify({ ok: false, code: 'INTERNAL', message: (e as Error).message, exit: EXIT.INTERNAL })); return EXIT.INTERNAL;
  }
}

const isEntry = process.argv[1] && /[\\/]main\.ts$/.test(process.argv[1]);
if (isEntry) main(process.argv.slice(2)).then((code) => process.exit(code));
