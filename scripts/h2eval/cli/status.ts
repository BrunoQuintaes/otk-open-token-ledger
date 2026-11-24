/**
 * R15 `status` / `stop` / `export`.
 *   status: last journal kind per operation, ledger state, journal integrity (verified on read), presence of STOP.
 *   stop  : creates the STOP file (presence is enough; read before every operation). Never deletes it.
 *   export: dataset per operation for R25 (ex ante snapshot + declared usage + table cost; billing = NA), JSONL + summary.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyJournalText } from '../core/journal.js';
import { openLedger, validateLedgerOpening, type LedgerConfig, type LedgerOpening } from '../core/ledger.js';
import { readSnapshot } from '../record/snapshot.js';
import type { JournalLine, PostcallRecord } from '../types.js';
import { writeJson } from './common.js';

export interface Status { batchDir: string; journalLines: number; journalIntegrity: 'OK' | string; operations: Record<string, { last: string; kinds: string[] }>; stopFilePresent: boolean; ledger: unknown | null }

export function status(batchDir: string, ledgerCfg?: LedgerConfig, stopFile = path.join(batchDir, 'STOP'), ledgerPath?: string): Status {
  const jp = path.join(batchDir, 'journal.jsonl');
  let lines: JournalLine[] = []; let integrity = 'OK';
  if (existsSync(jp)) { try { lines = verifyJournalText(readFileSync(jp, 'utf8')); } catch (e) { integrity = (e as Error).message; } }
  const ops: Status['operations'] = {};
  for (const l of lines) { if (l.operationId === 'NONE') continue; const o = (ops[l.operationId] ??= { last: '', kinds: [] }); o.kinds.push(l.kind); o.last = l.kind; }
  const lp = ledgerPath ?? path.join(batchDir, 'ledger.jsonl');
  // VNEXT-F (R17-V-3): a study ledger with inherit lines can only be opened with its LEDGER_OPENING.json (next to the ledger)
  const op = path.join(path.dirname(lp), 'LEDGER_OPENING.json'); let opening: LedgerOpening | undefined; if (existsSync(op)) { try { opening = validateLedgerOpening(JSON.parse(readFileSync(op, 'utf8'))); } catch { opening = undefined; } }
  const ledger = ledgerCfg && existsSync(lp) ? openLedger(lp, ledgerCfg, undefined, opening).state() : null;
  return { batchDir, journalLines: lines.length, journalIntegrity: integrity, operations: ops, stopFilePresent: existsSync(stopFile), ledger };
}

export function stop(batchDir: string, stopFile = path.join(batchDir, 'STOP'), reason = 'stop requested by operator'): string {
  if (!existsSync(stopFile)) writeFileSync(stopFile, `${new Date().toISOString()} ${reason}\n`, { flag: 'wx' });
  return stopFile;
}

export type DataLabel = 'SYNTHETIC_NOT_EVIDENCE' | 'REAL' | 'NOT_SENT';
export interface DatasetRow {
  operationId: string; /** VNEXT-F (R17-V-7): SC1 condition from the PLANNED line */ condition: string | null; probe: string | null; /** E3: OFFLINE (simulated provider) rows are SYNTHETIC_NOT_EVIDENCE; REAL only when the SENT line says mode REAL */ dataLabel: DataLabel; model: string; provider: string; api: string; phase: string; cellId: string; groupId: string; promptId: string; rep: number; split: string; structure: string; plannedCacheArm: string; modality: string;
  /** E3: local estimate of the stable-prefix tokens (cacheable) and of the S2 nonce tokens, from the pre-call snapshot */
  cacheableTokens: unknown; nonceTokensDeclared: unknown;
  exAnte: { L0: unknown; estimateStatus: string; counterVersion: string; costCapUsdPico: string; inputUpperBoundTokens: number; reasoningAllowanceTokens: number; priceTableId: string; priceTableSha256: string; snapshotSha256: string; thinking: unknown; cacheTtlRequested: string; /** E1 */ maxTokens: number; forecast: unknown; cacheableTokens: unknown; nonceTokensDeclared: unknown };
  declared: { outcome: string; httpStatus: unknown; modelServed: string | null; serviceTierServed: string | null; inputUncached: unknown; cacheRead: unknown; cacheWrite: unknown; cacheWrite5m: unknown; cacheWrite1h: unknown; outputVisible: unknown; reasoning: unknown; U: unknown; usageCompleteness: string | null; cacheObserved: string | null; refusalCode: string | null; exclusion: string; modelDeprecation: string; /** VNEXT-1 */ stopReason: string; completion: string; outputTotal: unknown } | null;
  cost: { state: string; usdPico: unknown; capCovered: unknown; possiblyCharged: boolean; billingObservedUsd: null; billingState: string } | null;
  finalState: string;
}

export function exportDataset(batchDir: string, outFile = path.join(batchDir, 'dataset.jsonl')): { rows: number; file: string; summary: Record<string, number> } {
  const snapDir = path.join(batchDir, 'snapshots'); const recDir = path.join(batchDir, 'records');
  const ids = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  const rows: DatasetRow[] = []; const summary: Record<string, number> = {};
  for (const id of ids) {
    const s = readSnapshot(batchDir, id);
    const rp = path.join(recDir, `${id}.json`);
    const r = existsSync(rp) ? (JSON.parse(readFileSync(rp, 'utf8')) as PostcallRecord) : null;
    const u = r?.usage ?? null;
    const row: DatasetRow = {
      operationId: id, condition: s.condition ?? null, probe: null, dataLabel: 'NOT_SENT', model: s.modelRequested, provider: s.provider, api: s.api, phase: 'UNKNOWN', cellId: 'UNKNOWN', groupId: 'UNKNOWN', promptId: 'UNKNOWN', rep: -1, split: 'UNKNOWN', structure: s.covariates.structure, plannedCacheArm: s.cachePlan.arm, modality: 'UNKNOWN',
      cacheableTokens: s.cachePlan.cacheableTokens ?? 'UNKNOWN', nonceTokensDeclared: s.cachePlan.nonceTokensDeclared ?? 'UNKNOWN',
      exAnte: { L0: s.counter.L0, estimateStatus: s.estimateStatus, counterVersion: s.counter.version, costCapUsdPico: s.costCap.usd, inputUpperBoundTokens: s.costCap.inputUpperBoundTokens, reasoningAllowanceTokens: s.costCap.reasoningAllowanceTokens, priceTableId: s.priceSnapshot.id, priceTableSha256: s.priceSnapshot.sha256, snapshotSha256: s.snapshotSha256, thinking: s.params.thinking, cacheTtlRequested: s.params.cacheTtlRequested, maxTokens: s.maxTokens, forecast: s.forecast, cacheableTokens: s.cachePlan.cacheableTokens ?? 'UNKNOWN', nonceTokensDeclared: s.cachePlan.nonceTokensDeclared ?? 'UNKNOWN' },
      declared: r ? { outcome: r.outcome, httpStatus: r.httpStatus, modelServed: u?.modelServed ?? null, serviceTierServed: u?.serviceTierServed ?? null, inputUncached: u?.inputUncached ?? 'UNKNOWN', cacheRead: u?.cacheRead ?? 'UNKNOWN', cacheWrite: u?.cacheWrite ?? 'UNKNOWN', cacheWrite5m: u?.cacheWrite5m ?? 'UNKNOWN', cacheWrite1h: u?.cacheWrite1h ?? 'UNKNOWN', outputVisible: u?.outputVisible ?? 'UNKNOWN', reasoning: u?.reasoning ?? 'UNKNOWN', U: u?.U ?? 'UNKNOWN', usageCompleteness: u?.usageCompleteness ?? null, cacheObserved: u?.cacheObserved ?? null, refusalCode: r.refusal?.code ?? null, exclusion: r.exclusion, modelDeprecation: r.modelDeprecation, stopReason: r.stopReason ?? 'UNKNOWN', completion: r.completion ?? 'UNKNOWN', outputTotal: u?.outputTotal ?? 'UNKNOWN', ...((r as { cacheReadEvidence?: string }).cacheReadEvidence ? { cacheReadEvidence: (r as { cacheReadEvidence?: string }).cacheReadEvidence } : {}) } : null, // E3G4 (B4): a marca do limite superior chega ao dataset
      cost: r ? { state: r.cost.state, usdPico: r.cost.usd, capCovered: r.cost.capCovered, possiblyCharged: r.cost.possiblyCharged, billingObservedUsd: null, billingState: r.cost.billing.state } : null,
      finalState: r?.finalState ?? 'NO_RECORD',
    };
    // identity fields come from the journal PLANNED line (the snapshot carries hashes, not the plan ids)
    rows.push(row);
    summary[row.finalState] = (summary[row.finalState] ?? 0) + 1;
  }
  const jp = path.join(batchDir, 'journal.jsonl');
  if (existsSync(jp)) {
    const lines = verifyJournalText(readFileSync(jp, 'utf8'));
    const planned = new Map(lines.filter((l) => l.kind === 'PLANNED').map((l) => [l.operationId, l.body as Record<string, unknown>]));
    const sentMode = new Map(lines.filter((l) => l.kind === 'SENT').map((l) => [l.operationId, String((l.body as { mode?: string }).mode ?? '')]));
    for (const row of rows) { const m = sentMode.get(row.operationId); row.dataLabel = m === 'REAL' ? 'REAL' : m === 'OFFLINE' ? 'SYNTHETIC_NOT_EVIDENCE' : 'NOT_SENT'; const b = planned.get(row.operationId); if (b) { row.phase = String(b['phase']); row.cellId = String(b['cellId']); row.promptId = String(b['promptId']); row.rep = Number(b['rep']); row.split = String(b['split']); row.groupId = String(b['groupId'] ?? 'UNKNOWN'); row.modality = String(b['modality'] ?? 'text'); row.condition = (b['condition'] as string | null | undefined) ?? row.condition; row.probe = (b['probe'] as string | null | undefined) ?? null; } }
  }
  rows.sort((a, b) => a.operationId.localeCompare(b.operationId));
  writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  writeJson(outFile.replace(/\.jsonl$/, '_summary.json'), { schema: 'h2eval.dataset_summary.v0', rows: rows.length, byFinalState: summary, billing: 'NOT_AVAILABLE (never estimated; reconciliation per batch is a separate step)' });
  return { rows: rows.length, file: outFile, summary };
}
