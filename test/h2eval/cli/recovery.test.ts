/**
 * Tests ledger integrity and idempotent recovery of `runAuthorized` after crashes simulated on disk.
 *
 * Modules under test: `scripts/h2eval/cli/run.ts` (`runAuthorized`), `scripts/h2eval/cli/status.ts` (`status`),
 * `scripts/h2eval/core/ledger.ts` (`openLedger`), `scripts/h2eval/core/journal.ts` and the campaign control registry
 * in `scripts/h2eval/cli/campaign.ts`.
 *
 * Strategy / scenarios: a reference batch is run to completion once, then copies of its study directory are cut the
 * way a crash leaves them (append-only files cut at a line boundary, later snapshots and records removed): a crash
 * between reservation and send (reservation released, nothing re-sent, the rest runs); between send and response
 * (operation isolated as uncertain, the series stops, the next run skips it and continues); a truncated ledger and a
 * ledger or journal with a partial last line (refused to open, nothing sent); and a byte-stable replay. Across all
 * cases an operation that already has a SENT line never gets another.
 *
 * Needs: a writable temporary directory (each copy gets its own control registry and a GO file re-pinned to its
 * path); allow up to 5 minutes per test. No network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/recovery.test.ts`
 *
 * @module test/h2eval/cli/recovery.test
 */
// SYNTHETIC — OFFLINE. CYCLE2-C (C147 task 3): ledger integrity and IDEMPOTENT recovery through `run-authorized`, with crashes simulated ON
// DISK exactly as a crash leaves them (append-only files cut at a line boundary; snapshots/records of later operations removed):
//   1. crash between RESERVED and SENT  => next run releases the reservation (ABORTED_BEFORE_SEND), nothing resent, the rest of the batch runs;
//   2. crash between SENT and response   => next run isolates (UNCERTAIN_ISOLATED crash_after_sent), STOP_UNCERTAIN halts the series; the run
//                                           after that skips it (REPLAY_SKIPPED) and continues; the uncertain money stays committed;
//   3. ledger truncated (settle line lost) => reconciliation refuses to open (LedgerReconciliationError => INTERNAL, HALT_ALL); nothing sent;
//   4. journal with a partial last line  => integrity error (format_line) refuses to open; nothing sent; `status` reports it;
//   5. ledger with a partial last line   => refuses to open; nothing sent;
//   6. a replayed study is byte-stable: a third run changes nothing.
// Every case: the number of SENT lines never increases for an operation that already has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncertainAcksIn } from '../support/ack.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized } from '../../../scripts/h2eval/cli/run.js';
import { status } from '../../../scripts/h2eval/cli/status.js';
import { openLedger } from '../../../scripts/h2eval/core/ledger.js';
import { verifyJournalText, JournalIntegrityError } from '../../../scripts/h2eval/core/journal.js';
import { syntheticMultiGo } from '../support/gomulti.js';
import { writeCampaignControl, campaignIdentitySha256, canonicalPath } from '../../../scripts/h2eval/cli/campaign.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';

const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-recovery-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
let pilot: BatchPlan; let pilotFile: string; let batchId: string; let goFile: string; let DONE: string;
// VNEXT-F (R17-V-1): a COPY of a study directory is refused by the machine control registry; these tests simulate crashes on copies, so each copy gets its own
// control registry pointing at the copy (what an operator would never do: the point of the registry is exactly to refuse copies)
const controlFor = (dir: string): string => { const c = mkdtempSync(path.join(tmpdir(), 'h2eval-recovery-ctl-')); const id = JSON.parse(readFileSync(path.join(dir, 'CAMPAIGN_IDENTITY.json'), 'utf8')) as { campaignId: string }; writeCampaignControl(c, { campaignId: id.campaignId, identitySha256: campaignIdentitySha256(dir)!, campaignDirCanonical: canonicalPath(dir), createdUtc: 'x' }); return c; };
// the GO pins the canonical path of DONE (R17-V-1): a copy needs a GO re-pinned to its own path (same nonce => the copied registry row is SAME)
const goFor = (dir: string): string => { if (dir === DONE) return goFile; const g = JSON.parse(readFileSync(goFile, 'utf8')) as Record<string, unknown>; g['campaignDirCanonical'] = canonicalPath(dir); delete g['goDigestSha256']; g['goDigestSha256'] = sha256Canon(g); const p = path.join(WORK, `go.${path.basename(dir)}.json`); writeFileSync(p, JSON.stringify(g)); return p; };
const run = (dir: string, ackUncertain?: ReturnType<typeof uncertainAcksIn>) => runAuthorized({ planFile: pilotFile, goFile: goFor(dir), campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, controlDir: dir === DONE ? undefined : controlFor(dir), ackUncertain });
const jpath = (dir: string) => path.join(dir, 'batches', batchId, 'journal.jsonl');
const lpath = (dir: string) => path.join(dir, 'ledger.jsonl');
const lines = (dir: string) => verifyJournalText(readFileSync(jpath(dir), 'utf8'));
const led = (dir: string) => { const s = openLedger(lpath(dir), CAPS).state().providers.anthropic; return { spent: s.spentUsd, possiblyCharged: s.possiblyChargedUsd, reserved: s.reservedUsd, ops: s.operations }; };
const sentCount = (dir: string, op: string) => lines(dir).filter((l) => l.operationId === op && l.kind === 'SENT').length;
const rawLines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean);
/**
 * Cut the study of a DONE batch to the state a crash leaves right after journal line `cutKind` of operation #n (1-based).
 *
 * @param src - Study directory of a completed batch; it is copied, never modified.
 * @param n - 1-based position of the operation, in journal PLANNED order, at which the crash happens.
 * @param cutKind - Last journal kind that survives for that operation.
 * @returns The crashed copy's directory and the id of the cut operation.
 */
function crashAfter(src: string, n: number, cutKind: 'RESERVED' | 'SENT'): { dir: string; op: string } {
  const dir = tmp(`crash-${cutKind}-${n}`); cpSync(src, dir, { recursive: true });
  const all = lines(dir); const planned = all.filter((l) => l.kind === 'PLANNED'); const op = planned[n - 1]!.operationId;
  const cutIdx = all.findIndex((l) => l.operationId === op && l.kind === cutKind); assert.ok(cutIdx > 0);
  writeFileSync(jpath(dir), rawLines(jpath(dir)).slice(0, cutIdx + 1).join('\n') + '\n');
  // ledger: keep everything up to and including this operation's reserve (ledger events are time-ordered, one batch, every earlier op settled)
  const lraw = rawLines(lpath(dir)); const li = lraw.findIndex((l) => { const e = JSON.parse(l) as { kind: string; operationId: string }; return e.kind === 'reserve' && e.operationId === op; }); assert.ok(li >= 0);
  writeFileSync(lpath(dir), lraw.slice(0, li + 1).join('\n') + '\n');
  // snapshots/records written later than the cut do not exist after a crash
  const laterOps = new Set(planned.slice(n).map((l) => l.operationId)); // ops after the crash: neither snapshot nor record exists yet
  for (const f of readdirSync(path.join(dir, 'batches', batchId, 'snapshots'))) if (laterOps.has(f.replace(/\.json$/, ''))) unlinkSync(path.join(dir, 'batches', batchId, 'snapshots', f));
  for (const f of readdirSync(path.join(dir, 'batches', batchId, 'records'))) { const id = f.replace(/\.json$/, ''); if (laterOps.has(id) || id === op) unlinkSync(path.join(dir, 'batches', batchId, 'records', f)); } // op n's record is written only after the response
  for (const f of readdirSync(dir)) if (f.startsWith('authorized_run.')) unlinkSync(path.join(dir, f));
  for (const f of readdirSync(path.join(dir, 'batches', batchId))) if (f.startsWith('run_summary.')) unlinkSync(path.join(dir, 'batches', batchId, f));
  return { dir, op };
}

test('setup: corpus, pilot plan, ONE openai batch run to completion (reference study)', { timeout: 300_000 }, async () => {
  freezeCorpus({ out: CORPUS, seed: 147003, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-RECOVERY' });
  pilotFile = path.join(WORK, 'plan.pilot.json'); writePlan(pilot, pilotFile);
  batchId = pilot.batches.find((b) => b.provider === 'anthropic')!.batchId;
  DONE = tmp('done'); goFile = path.join(WORK, 'go.json'); writeFileSync(goFile, syntheticMultiGo(pilot, [batchId], { executorCodeSha: SHA, campaignDir: DONE }));
  const r = await run(DONE);
  assert.deepEqual([r.haltReason, r.executed[0]!.outcome, r.executed[0]!.executed], [null, 'DONE', 21]);
  assert.equal(led(DONE).ops, 21); assert.equal(rawLines(lpath(DONE)).length, 42, 'reserve + settle por operacao');
});

test('(1) crash entre RESERVED e SENT: a proxima execucao libera a reserva (ABORTED_BEFORE_SEND, crash_before_sent_reservation_released), NAO reenvia, segue as 16 restantes; ledger reconcilia', { timeout: 300_000 }, async () => {
  const { dir, op } = crashAfter(DONE, 5, 'RESERVED');
  assert.equal(led(dir).ops, 4, 'estado de partida: 4 liquidadas + 1 reservada'); assert.ok(BigInt(led(dir).reserved) > 0n);
  const r = await run(dir);
  const kinds = lines(dir).filter((l) => l.operationId === op).map((l) => l.kind);
  assert.deepEqual(kinds, ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'ABORTED_BEFORE_SEND']);
  assert.equal((lines(dir).find((l) => l.operationId === op && l.kind === 'ABORTED_BEFORE_SEND')!.body as { reason: string }).reason, 'crash_before_sent_reservation_released');
  assert.equal(sentCount(dir, op), 0, 'a operacao do crash nunca e enviada (precisa de novo rep)');
  assert.deepEqual([r.haltReason, r.executed[0]!.outcome, r.executed[0]!.executed], [null, 'DONE', 16], '4 replays + 1 abortada (replay) + 16 novas');
  const l = led(dir); assert.deepEqual([l.reserved, l.possiblyCharged, l.ops], ['0', '0', 20]);
  assert.equal(rawLines(lpath(dir)).filter((x) => (JSON.parse(x) as { kind: string }).kind === 'release').length, 1);
  const r3 = await run(dir); assert.equal(r3.attemptsThisRun, 0);
});

test('(2) crash entre SENT e a resposta: proxima execucao => UNCERTAIN_ISOLATED (crash_after_sent), STOP_UNCERTAIN HALT_ALL, nada mais enviado; a execucao seguinte faz REPLAY_SKIPPED e completa; dinheiro incerto fica comprometido', { timeout: 300_000 }, async () => {
  const { dir, op } = crashAfter(DONE, 7, 'SENT');
  const reservedBefore = BigInt(led(dir).reserved); assert.ok(reservedBefore > 0n);
  const r1 = await run(dir);
  assert.deepEqual([r1.haltReason, r1.executed[0]!.stoppedBy, r1.executed[0]!.disposition, r1.attemptsThisRun], ['STOP_UNCERTAIN', 'STOP_UNCERTAIN', 'HALT_ALL', 0]);
  const kinds1 = lines(dir).filter((l) => l.operationId === op).map((l) => l.kind);
  assert.deepEqual(kinds1, ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'SENT', 'UNCERTAIN_ISOLATED']);
  assert.deepEqual((lines(dir).at(-1)!.body as { reason: string; possiblyCharged: boolean }), { reason: 'crash_after_sent', possiblyCharged: true });
  let l = led(dir); assert.deepEqual([l.reserved, BigInt(l.possiblyCharged), l.ops], ['0', reservedBefore, 7]);
  // C158 cycle 2 counterpoint: WITHOUT the human acknowledgement the resume sends nothing and stops on the same uncertain operation
  const sentBefore = sentCount(dir, op); const rNo = await run(dir);
  assert.deepEqual([rNo.haltReason, rNo.attemptsThisRun, sentCount(dir, op)], ['STOP_UNCERTAIN', 0, sentBefore], 'sem ack: nada enviado');
  assert.equal(lines(dir).some((x) => x.kind === 'UNCERTAIN_ACKNOWLEDGED'), false);
  const r2 = await run(dir, uncertainAcksIn(dir));
  assert.deepEqual([r2.haltReason, r2.executed[0]!.outcome, r2.executed[0]!.executed], [null, 'DONE', 14]);
  assert.equal(lines(dir).filter((x) => x.kind === 'UNCERTAIN_ACKNOWLEDGED').length, 1, 'o ack e gravado no diario'); assert.equal(lines(dir).filter((x) => x.kind === 'UNCERTAIN_ACKNOWLEDGED')[0]!.operationId, op);
  assert.equal(sentCount(dir, op), 1, 'um unico SENT para sempre'); assert.equal(lines(dir).filter((x) => x.operationId === op).at(-1)!.kind, 'REPLAY_SKIPPED');
  l = led(dir); assert.deepEqual([BigInt(l.possiblyCharged), l.ops], [reservedBefore, 21]);
});

test('(3) ledger truncado (ultima linha settle perdida enquanto o journal tem SETTLED): reconciliacao recusa abrir => linha STOPPED INTERNAL (HALT_ALL), 0 envios, ledger nao modificado', { timeout: 300_000 }, async () => {
  const dir = tmp('ledger-trunc'); cpSync(DONE, dir, { recursive: true });
  const lraw = rawLines(lpath(dir)); writeFileSync(lpath(dir), lraw.slice(0, -1).join('\n') + '\n'); const before = readFileSync(lpath(dir), 'utf8');
  const sentBefore = lines(dir).filter((l) => l.kind === 'SENT').length;
  const r = await run(dir);
  assert.deepEqual([r.haltReason, r.executed[0]!.outcome, r.executed[0]!.disposition, r.attemptsThisRun], ['LEDGER_RECONCILIATION', 'STOPPED', 'HALT_ALL', 0]);
  assert.match(r.executed[0]!.reason ?? '', /ledger does not reconcile/);
  assert.equal(readFileSync(lpath(dir), 'utf8'), before, 'ledger intocado'); assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, sentBefore);
  assert.ok(!existsSync(path.join(dir, '.campaign.lock')) && !existsSync(path.join(dir, 'batches', batchId, '.lock')), 'trincos liberados');
});

test('(4) journal com linha parcial no fim (queda durante a escrita): integridade recusa abrir (format_line), 0 envios; `status` reporta a integridade', { timeout: 300_000 }, async () => {
  const dir = tmp('journal-partial'); cpSync(DONE, dir, { recursive: true });
  const raw = readFileSync(jpath(dir), 'utf8'); writeFileSync(jpath(dir), raw + raw.split('\n')[3]!.slice(0, 80));
  assert.throws(() => lines(dir), JournalIntegrityError);
  const r = await run(dir);
  assert.deepEqual([r.haltReason, r.executed[0]!.outcome, r.attemptsThisRun], ['JOURNAL_INTEGRITY', 'STOPPED', 0]); assert.match(r.executed[0]!.reason ?? '', /journal integrity: format_line/);
  const st = status(path.join(dir, 'batches', batchId), CAPS, undefined, lpath(dir)); assert.match(st.journalIntegrity, /format_line/); assert.equal(st.journalLines, 0);
  assert.equal(readFileSync(jpath(dir), 'utf8'), raw + raw.split('\n')[3]!.slice(0, 80), 'journal nao e "consertado" automaticamente');
});

test('(5) ledger com linha parcial no fim: recusa abrir, 0 envios, nada reescrito', { timeout: 300_000 }, async () => {
  const dir = tmp('ledger-partial'); cpSync(DONE, dir, { recursive: true });
  const raw = readFileSync(lpath(dir), 'utf8'); writeFileSync(lpath(dir), raw + '{"kind":"settle","operationId":"abc'); const sentBefore = lines(dir).filter((l) => l.kind === 'SENT').length;
  const r = await run(dir);
  assert.deepEqual([r.haltReason, r.executed[0]!.outcome, r.attemptsThisRun], ['INTERNAL', 'STOPPED', 0]);
  assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, sentBefore); assert.equal(readFileSync(lpath(dir), 'utf8'), raw + '{"kind":"settle","operationId":"abc');
});

test('(6) replay e byte-estavel: executar de novo a pasta DONE nao muda journal nem ledger alem das linhas REPLAY_SKIPPED', { timeout: 300_000 }, async () => {
  const dir = tmp('stable'); cpSync(DONE, dir, { recursive: true }); const ledgerBefore = readFileSync(lpath(dir), 'utf8'); const n = lines(dir).length;
  const r = await run(dir);
  assert.equal(r.attemptsThisRun, 0); assert.equal(r.attemptsUsed, 21); assert.equal(readFileSync(lpath(dir), 'utf8'), ledgerBefore);
  const after = lines(dir); assert.equal(after.length, n + 21); assert.ok(after.slice(n).every((l) => l.kind === 'REPLAY_SKIPPED'));
});
