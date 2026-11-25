#!/usr/bin/env node
/**
 * generate_roadmap_gantt.js
 *
 * Reads docs/CANONICAL_PHASE_TABLE.csv (historical phase archive)
 * Outputs:
 *   - docs/CANONICAL_ROADMAP_TABLE.csv (execution-ordered with Wave/Scope)
 *   - docs/gantt.html (self-contained visual Gantt chart)
 *
 * Usage: node scripts/ops/generate_roadmap_gantt.js
 * Add to package.json: "gantt": "node scripts/ops/generate_roadmap_gantt.js"
 *
 * Legacy generator for the historical phase table: it overwrites both output files on every run and
 * exports nothing. The current roadmap documents come from generate_master_roadmap.mjs instead.
 * Paths are resolved from this file's location, not from the working directory.
 *
 * @module scripts/ops/generate_roadmap_gantt
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const PHASE_CSV = path.join(ROOT, 'docs/CANONICAL_PHASE_TABLE.csv');
const ROADMAP_CSV = path.join(ROOT, 'docs/CANONICAL_ROADMAP_TABLE.csv');
const GANTT_HTML = path.join(ROOT, 'docs/gantt.html');

// ─── CSV Parser (handles quoted fields) ──────────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function escapeCSV(s) {
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── Wave & Scope Mapping ────────────────────────────────────────────

// Explicit ID → wave overrides (most specific wins)
const ID_WAVE = {
  // Academic residual → Wave 1
  'A6.6': '1', 'A6.7': '1',
  'A11.1': '1', 'A11.2': '1', 'A11.4': '1',
  // A11.3 absorbed into A6.6 — handled in ABSORBED_IDS
  // E2 sub-items
  'E2.1': '1', 'E2.4': '1',
  'E2.2': 'DONE', 'E2.2.1': 'DONE', 'E2.2.2': 'DONE', 'E2.2.3': 'DONE', 'E2.2.4': 'DONE',
  'E2.3': 'DONE',
  // P1 sub-items
  'P1.1': 'DONE', 'P1.2': 'DONE', 'P1.2.1': 'DONE', 'P1.3': 'DONE', 'P1.4': 'DONE',
  'P1.5': '1', 'P1.6': '2', 'P1.7': '1', 'P1.8': '1',
  // P2 sub-items
  'P2.1': '2', 'P2.2': '2',
  'P2.3': '3', 'P2.4': '3', 'P2.5': '3', 'P2.6': '3',
  // S1 executed items (S1.1-S1.4 pre-Wave 1; S1.5-S1.7 are Wave 1 Pack 1)
  'S1.1': 'DONE', 'S1.2': 'DONE', 'S1.3': 'DONE', 'S1.3.1': 'DONE', 'S1.4': 'DONE',
  'S1.5': '1', 'S1.6': '1', 'S1.7': '1',
  // Wave 2H: Production Hardening
  'H1.1': '2H', 'H1.2': '2H', 'H1.3': '2H', 'H1.4': '2H', 'H1.5': '2H',
  'H1.6': '2H', 'H1.7': '2H', 'H1.8': '2H', 'H1.9': '2H',
  'H2.1': '2H', 'H2.2': '2H', 'H2.3': '2H', 'H2.4': '2H', 'H2.5': '2H',
  'H2.6': '2H', 'H2.7': '2H', 'H2.8': '2H', 'H2.9': '2H',
  'H3.1': '2H', 'H3.2': '2H', 'H3.3': '2H', 'H3.4': '2H',
  'H4.1': '2H', 'H4.2': '2H', 'H4.3': '2H', 'H4.4': '2H',
  'H5.1': '2H', 'H5.2': '2H', 'H5.3': '2H', 'H5.4': '2H',
  'H6.1': '2H', 'H6.2': '2H', 'H6.3': '2H', 'H6.4': '2H',
  // Wave 3 new items
  'NEW-3.01': '3', 'NEW-3.02': '3', 'NEW-3.03': '3', 'NEW-3.04': '3', 'NEW-3.05': '3',
  'NEW-3.06': '3', 'NEW-3.07': '3', 'NEW-3.08': '3', 'NEW-3.09': '3',
  // Wave 4 new items + movements
  'NEW-4.01': '4', 'NEW-4.02': '4', 'NEW-4.03': '4', 'NEW-4.04': '4',
  'NEW-4.05': '4', 'NEW-4.06': '4',
  // Wave 5 new items
  'NEW-5.01': '5', 'NEW-5.02': '5', 'NEW-5.03': '5', 'NEW-5.04': '5',
  // Wave 6 new items
  'NEW-6.01': '6', 'NEW-6.02': '6',
  // RC2 new items
  'RC2.7': 'RC2', 'RC2.8': 'RC2', 'RC2.9': 'RC2', 'RC2.10': 'RC2',
  'RC2.11': 'RC2', 'RC2.12': 'RC2', 'RC2.13': 'RC2', 'RC2.14': 'RC2',
  // Movement overrides
  'E6.6': '4',  // Webhooks moved from Wave 5 to Wave 4
  'P4.1': '4', 'P4.5': '4', 'P4.7': '4',  // Billing/pricing moved from Wave 5 to Wave 4
  'P5.2': '4',  // SSE streaming moved from Wave 6 to Wave 4
  'E5.7': '3',  // K8s moved from Wave 4 to Wave 3
};

// CUT items (removed from roadmap)
const CUT_IDS = new Set([
  'S7', 'S7.1', 'S7.2', 'S7.3', 'S7.4',
  'E6.8', 'E6.9', 'E6.10',
  'P4.6', 'P4.9',
  'E2.7', 'E2.8', 'E2.9', 'E2.10',
]);

// ABSORBED items (content kept, phase removed — work lives in another phase)
const ABSORBED_IDS = new Set([
  'E2.5', 'E2.6',      // → S2.1 / S5.3
  'S5.4', 'S5.5',      // → S5.1
  'E3.4', 'E3.5',      // → E3.1-E3.3 / S3.3
  'E6.1',              // → E6.2
  'A11.3',             // → A6.6 (same manifest functionality)
]);

const ABSORBED_INTO = {
  'E2.5': 'S2.1', 'E2.6': 'S5.3',
  'S5.4': 'S5.1', 'S5.5': 'S5.1',
  'E3.4': 'E3.1', 'E3.5': 'S3.3',
  'E6.1': 'E6.2',
  'A11.3': 'A6.6',
};

const CUT_REASONS = {
  'S7': 'Separate product line (token economics + multichain)',
  'S7.1': 'Depends on S7 — cut', 'S7.2': 'Depends on S7 — cut',
  'S7.3': 'Depends on S7 — cut', 'S7.4': 'Depends on S7 — cut',
  'E6.8': 'Pure research (zkML 2028+) — no operational capability',
  'E6.9': 'Separate infra line (TEE/TDX) — own threat model + compliance',
  'E6.10': 'Separate R&D line (TLSNotary) — competes with ZK focus',
  'P4.6': 'Depends on S7 (token) — cut with S7',
  'P4.9': 'Strategic analysis — not product capability',
  'E2.7': 'Duplicates A14.4.9 (academic) — already delivered',
  'E2.8': 'Duplicates A14.4.11 (academic) — already delivered',
  'E2.9': 'Duplicates A14.4.12 (academic) — already delivered',
  'E2.10': 'Project invariant — not executable phase',
  'E2.5': 'Absorbed into S2.1 (PlanRegistry) as sub-requirement',
  'E2.6': 'Absorbed into S5.3 (CUEngine v2) — doc exists as A14.4.8',
  'S5.4': 'Absorbed into S5.1 — ADR already exists as A14.5.10',
  'S5.5': 'Absorbed into S5.1 — ADR already exists as A12.9.7',
  'E3.4': 'Absorbed into E3.1 — spec exists as A14.5.11',
  'E3.5': 'Absorbed into S3.3 (RedisTAL) — spec exists as A14.5.12',
  'E6.1': 'Absorbed into E6.2 — ADR exists as A12.11.1',
  'A11.3': 'Absorbed into A6.6 — same manifest JSON functionality',
};

// Phase-level fallback → wave
const PHASE_WAVE = {
  'A0': 'DONE', 'A1': 'DONE', 'A2': 'DONE', 'A3': 'DONE', 'A4': 'DONE',
  'A5': 'DONE', 'A7': 'DONE', 'A8': 'DONE', 'A9': 'DONE',
  'A10': 'DONE', 'A12': 'DONE', 'A13': 'DONE', 'A14': 'DONE',
  'BASE-0': 'DONE', 'BASE-1': 'DONE',
  'S0': 'DONE',
  'S2': '1', 'S3': '1',
  'S4': '2',
  'S5': '4',
  'S6': '4',
  'E1': '1',
  'E3': '2',
  'E4': '3',
  'E5': '4',
  'E6': '5',
  'H1': '2H', 'H2': '2H', 'H3': '2H', 'H4': '2H', 'H5': '2H', 'H6': '2H',
  'P2': '2',
  'P3': '3',
  'P4': '5',
  'P5': '6',
  'RC2': 'RC2',
};

// ─── Wave 1 Pack Ordering (canonical execution sequence) ─────────
// Pack number defines internal execution order within Wave 1.
// Same pack = parallel execution allowed. Sequential packs = dependency chain.
const ID_PACK = {
  // Pack 1: Runtime gap closure
  'S1.5': 1, 'S1.6': 1, 'S1.7': 1,
  // Pack 2: Redis infra foundation
  'S3.1': 2,
  // Pack 3: Production queue + retry
  'S3.2': 3, 'S3.4': 3,
  // Pack 4: RedisTAL + publish policy
  'S3.3': 4, 'S3.5': 4,
  // Pack 5: PlanRegistry + rate limit
  'S2.1': 5, 'S2.3': 5,
  // Pack 6: Invoice + tests
  'S2.2': 6, 'S2.4': 6,
  // Pack 7: Structured logging (lightweight observability first)
  'E1.1': 7,
  // Pack 8: OTel + metrics + SLO
  'E1.2': 8, 'E1.3': 8, 'E1.4': 8,
  // Pack 9: KMS + governance trail
  'E2.1': 9, 'E2.4': 9,
  // Pack 10: SDK npm package
  'P1.5': 10,
  // Pack 11: Docs site + Python SDK
  'P1.7': 11, 'P1.8': 11,
  // Pack 12: Parallel support — CI/manifest/lint (non-blocking)
  'A6.6': 12, 'A6.7': 12, 'A11.1': 12, 'A11.2': 12, 'A11.4': 12,
  // ── Wave 2 Pack Ordering (canonical execution sequence) ─────────
  // Pack 13: Polling /status
  'S4.1': 13,
  // Pack 14: PostgreSQL Archive
  'E3.1': 14,
  // Pack 15: Redis Shared State + Migrations/Backup
  'E3.2': 15, 'E3.3': 15,
  // Pack 16: Auto Batch Trigger + Auto On-Chain Submit
  'S4.2': 16, 'S4.3': 16,
  // Pack 17: Crash Recovery
  'S4.4': 17,
  // Pack 18: Quickstart 5-Minute Guide
  'P1.6': 18,
  // Pack 19: Indexer + Dashboard Basic
  'P2.1': 19,
  // Pack 20: /app/login
  'P2.2': 20,
  // Wave 2H packs
  'H1.1': 21, 'H1.2': 21, 'H1.3': 21, 'H1.4': 21, 'H1.5': 21,
  'H1.6': 22, 'H1.7': 22, 'H1.8': 22, 'H1.9': 22,
  'H2.1': 23, 'H2.2': 23, 'H2.3': 23, 'H2.4': 23, 'H2.5': 23,
  'H2.6': 24, 'H2.7': 24, 'H2.8': 24, 'H2.9': 24,
  'H3.1': 25, 'H3.2': 25, 'H3.3': 25, 'H3.4': 25,
  'H4.1': 26, 'H4.2': 26, 'H4.3': 26, 'H4.4': 26,
  'H5.1': 27, 'H5.2': 27, 'H5.3': 27, 'H5.4': 27,
  'H6.1': 28, 'H6.2': 28, 'H6.3': 28, 'H6.4': 28,
};

// Parent phases → assigned to their first pack for sorting
const PHASE_PACK = {
  'S1': 1, 'S3': 2, 'S2': 5, 'E1': 7, 'E2': 9, 'P1': 10, 'A6': 12, 'A11': 12,
  // Wave 2 parent phases
  'S4': 13, 'E3': 14, 'P2': 19,
  // Wave 2H parent phases
  'H1': 21, 'H2': 23, 'H3': 25, 'H4': 26, 'H5': 27, 'H6': 28,
};

// Name overrides (applied during processing)
const NAME_OVERRIDES = {
  'A6.6': 'Canonical Manifest JSON (incl. A11.3)',
};

const DESC_OVERRIDES = {
  'A6.6': 'Automatic JSON manifest per phase/commit — unified from A6.6 + A11.3',
};

function getWaveAndScope(id, phase, status) {
  // 1. CUT
  if (CUT_IDS.has(id)) return { wave: 'CUT', scope: 'CUT' };
  // 2. ABSORBED
  if (ABSORBED_IDS.has(id)) return { wave: 'CUT', scope: 'ABSORBED' };
  // 3. Explicit ID mapping
  if (ID_WAVE[id]) {
    const w = ID_WAVE[id];
    return { wave: w, scope: w === 'DONE' ? 'DONE' : 'CORE' };
  }
  // 4. Parent phases with mixed sub-items — handle specially
  if (id === 'A6' || id === 'A11') return { wave: '1', scope: 'CORE' };
  if (id === 'E2') return { wave: '1', scope: 'CORE' };
  if (id === 'P1') return { wave: '1', scope: 'CORE' };
  if (id === 'S1') return { wave: 'DONE', scope: 'DONE' };
  // 4.5. H-phase parent items
  if (phase && phase.startsWith('H')) return { wave: '2H', scope: 'CORE' };
  // 5. Phase-level fallback
  if (PHASE_WAVE[phase]) {
    const w = PHASE_WAVE[phase];
    const scope = w === 'DONE' ? 'DONE' : (['5', '6'].includes(w) ? 'LAST' : 'CORE');
    return { wave: w, scope };
  }
  // 6. Status-based fallback
  if (status === 'COMPLETED' || status === 'COMPLETED/STABLE') {
    return { wave: 'DONE', scope: 'DONE' };
  }
  return { wave: '?', scope: '?' };
}

// ─── New rows to inject (only if not already present in phase table) ──
const NEW_ROWS = [
  ['S1.5', 'Startup', 'S1', 'S1.5', 'Dead-Letter Store', 'Failed receipts captured to dead-letter queue for manual review and retry', '', 'NOT STARTED', ''],
  ['S1.6', 'Startup', 'S1', 'S1.6', 'Tenant CRUD Runtime', 'Create/update/delete tenants at runtime via API (not only env-based bootstrap)', '', 'NOT STARTED', ''],
  ['S1.7', 'Startup', 'S1', 'S1.7', 'S1 Extension Tests + EVD', 'Tests covering S1.5-S1.6 plus evidence documentation', '', 'NOT STARTED', ''],
];

// ─── Wave sort order ─────────────────────────────────────────────────
const WAVE_ORDER = { 'DONE': 0, '1': 1, '2': 2, '2H': 2.5, '3': 3, '4': 4, '5': 5, '6': 6, 'RC2': 7, 'CUT': 8 };

const WAVE_NAMES = {
  'DONE': 'Completed (Historical)',
  '1': 'Wave 1 — MVP Operational Base',
  '2': 'Wave 2 — Auto-Loop + Persistence + Initial UX',
  '2H': 'Wave 2H — Production Hardening (Pre-Wave 3)',
  '3': 'Wave 3 — Scale Infrastructure + Self-Service',
  '4': 'Wave 4 — Enterprise Features + ZK v2',
  '5': 'Wave 5 — Advanced Enterprise + Commercial (LAST)',
  '6': 'Wave 6 — Advanced Delivery (LAST)',
  'RC2': 'RC2 — Final Release Gate',
  'CUT': 'CUT — Removed from Roadmap',
};

const WAVE_PARALLEL = {
  '1': 'P1-3: S1.5-7 → S3.1 → S3.2+S3.4 | P4-6: S3.3+S3.5 → S2.1+S2.3 → S2.2+S2.4 | P7-9: E1.1 → E1.2-4 → E2.1+E2.4 | P10-11: P1.5 → P1.7+P1.8 | P12: A6/A11 (parallel)',
  '2': 'P13: S4.1 → P14: E3.1 → P15: E3.2+E3.3 → P16: S4.2+S4.3 → P17: S4.4 → P18: P1.6 → P19: P2.1 → P20: P2.2',
  '2H': 'H-P01: H1.1-5 | H-P02: H1.6-9 | H-P03: H2.1-5 | H-P04: H2.6-9 | H-P05: H3.1-4 | H-P06: H4.1-4 | H-P07: H5.1-4 | H-P08: H6.1-4',
  '3': 'E4 (stateless) → E5.7+K8s | P2.3-P2.6 | P3 (self-service) | NEW-3.01-09',
  '4': 'S5 (ZK v2) | E5 (compliance) | P4.1+P4.5+P4.7 (billing) | E6.6+NEW-4.05-06 (webhooks) | P5.2 (SSE) | NEW-4.01-04',
  '5': 'E6.2-E6.7 | P4 (core)',
  '6': 'P5',
};

// ─── Main ────────────────────────────────────────────────────────────
function main() {
  const raw = fs.readFileSync(PHASE_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const header = parseCSVLine(lines[0]);
  // columns: ID,Track,Phase,Sub-Phase,Name,Description,RB,Status,Completion Evidence

  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const f = parseCSVLine(lines[i]);
    const [id, track, phase, subPhase, name, desc, rb, status, evidence] = f;
    const { wave, scope } = getWaveAndScope(id, phase, status);
    const cutReason = CUT_REASONS[id] || '';
    const absorbedInto = ABSORBED_INTO[id] || '';
    const pack = (wave === '1' || wave === '2' || wave === '2H') ? (ID_PACK[id] ?? PHASE_PACK[phase] ?? '') : '';
    const finalName = NAME_OVERRIDES[id] || name;
    const finalDesc = DESC_OVERRIDES[id] || desc;
    rows.push({ wave, pack, id, track, phase, subPhase, name: finalName, desc: finalDesc, rb, status, evidence, scope, cutReason, absorbedInto });
  }

  // Inject new S1 rows (Pack 1) — only if not already in phase table
  const existingIds = new Set(rows.map(r => r.id));
  for (const nr of NEW_ROWS) {
    if (existingIds.has(nr[0])) continue; // already in phase table — skip injection
    rows.push({
      wave: '1', pack: ID_PACK[nr[0]] ?? 1, id: nr[0], track: nr[1], phase: nr[2], subPhase: nr[3],
      name: nr[4], desc: nr[5], rb: nr[6], status: nr[7], evidence: nr[8],
      scope: 'CORE', cutReason: '', absorbedInto: '',
    });
  }

  // Sort: wave order → pack (for Wave 1) → ID (natural)
  rows.sort((a, b) => {
    const wo = (WAVE_ORDER[a.wave] ?? 99) - (WAVE_ORDER[b.wave] ?? 99);
    if (wo !== 0) return wo;
    // Within Wave 1 or Wave 2: sort by pack number first
    if ((a.wave === '1' || a.wave === '2' || a.wave === '2H') && a.wave === b.wave) {
      const pa = (typeof a.pack === 'number') ? a.pack : 99;
      const pb = (typeof b.pack === 'number') ? b.pack : 99;
      if (pa !== pb) return pa - pb;
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  // ── Write CSV ──
  const csvHeader = 'Wave,Pack,ID,Track,Phase,Sub_Phase,Name,Description,RB,Status,Completion_Evidence,Scope,Cut_Reason,Absorbed_Into';
  const csvRows = rows.map(r =>
    [r.wave, (r.pack !== '' && r.pack !== undefined) ? r.pack : '', r.id, r.track, r.phase, r.subPhase,
     escapeCSV(r.name), escapeCSV(r.desc), r.rb, r.status,
     escapeCSV(r.evidence), r.scope, escapeCSV(r.cutReason), r.absorbedInto
    ].join(',')
  );
  fs.writeFileSync(ROADMAP_CSV, csvHeader + '\n' + csvRows.join('\n') + '\n');
  console.log(`[CSV] Written ${csvRows.length} rows to docs/CANONICAL_ROADMAP_TABLE.csv`);

  // ── Generate Gantt HTML ──
  generateGantt(rows);
  console.log(`[GANTT] Written to docs/gantt.html`);

  // ── Summary stats (excluding parent rows, same logic as gantt JS) ──
  const stats = {};
  for (const r of rows) {
    // Skip parent rows: parent rows have id === phase (e.g., S3, E1)
    const isParent = !r.subPhase || r.id === r.phase;
    if (isParent) continue;
    if (!stats[r.wave]) stats[r.wave] = { total: 0, done: 0, partial: 0, notStarted: 0 };
    stats[r.wave].total++;
    if (r.status === 'COMPLETED' || r.status === 'COMPLETED/STABLE') stats[r.wave].done++;
    else if (r.status === 'PARTIAL') stats[r.wave].partial++;
    else stats[r.wave].notStarted++;
  }
  console.log('\n── Summary ──');
  for (const [w, s] of Object.entries(stats)) {
    const pct = ((s.done / s.total) * 100).toFixed(0);
    console.log(`  Wave ${w}: ${s.done}/${s.total} done (${pct}%) | ${s.partial} partial | ${s.notStarted} not started`);
  }
}

// ─── Gantt HTML Generator ────────────────────────────────────────────
function generateGantt(rows) {
  const dataJSON = JSON.stringify(rows.map(r => ({
    wave: r.wave,
    pack: r.pack,
    id: r.id,
    track: r.track,
    phase: r.phase,
    sub: r.subPhase,
    name: r.name,
    desc: r.desc,
    rb: r.rb,
    status: r.status,
    evidence: r.evidence,
    scope: r.scope,
    cutReason: r.cutReason,
    absorbedInto: r.absorbedInto,
  })));

  const waveNamesJSON = JSON.stringify(WAVE_NAMES);
  const waveParallelJSON = JSON.stringify(WAVE_PARALLEL);
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OTK zk-Metering — Execution Roadmap Gantt</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-muted: #8b949e; --text-dim: #484f58;
    --green: #3fb950; --green-bg: #1a3a2a;
    --yellow: #d29922; --yellow-bg: #3d2e00;
    --blue: #58a6ff; --blue-bg: #0d2744;
    --red: #f85149; --red-bg: #3d1418;
    --purple: #bc8cff; --purple-bg: #271052;
    --gray: #484f58; --gray-bg: #1c2028;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); line-height: 1.5; }

  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 24px; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 4px; }

  .stats-bar { display: flex; gap: 16px; padding: 16px 24px; background: var(--surface);
               border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center; }
  .stat { font-size: 13px; color: var(--text-muted); }
  .stat strong { color: var(--text); font-size: 16px; margin-right: 4px; }
  .progress-bar-outer { flex: 1; min-width: 200px; height: 8px; background: var(--gray-bg);
                        border-radius: 4px; overflow: hidden; }
  .progress-bar-inner { height: 100%; border-radius: 4px; transition: width 0.3s; }

  .controls { display: flex; gap: 8px; padding: 12px 24px; background: var(--bg);
              border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center; }
  .controls label { font-size: 12px; color: var(--text-muted); margin-right: 4px; }
  .controls select, .controls input { background: var(--surface); border: 1px solid var(--border);
    color: var(--text); padding: 4px 8px; border-radius: 6px; font-size: 12px; }
  .btn { background: var(--surface); border: 1px solid var(--border); color: var(--text);
         padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn:hover { border-color: var(--blue); }
  .btn.active { background: var(--blue-bg); border-color: var(--blue); }

  .container { padding: 0 24px 40px; }

  .wave-section { margin-top: 20px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .wave-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
                 background: var(--surface); cursor: pointer; user-select: none; }
  .wave-header:hover { background: #1c2230; }
  .wave-header .arrow { font-size: 12px; color: var(--text-muted); transition: transform 0.2s; width: 16px; }
  .wave-header .arrow.open { transform: rotate(90deg); }
  .wave-header .wave-title { font-weight: 600; font-size: 14px; flex: 1; }
  .wave-header .wave-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .wave-header .parallel { font-size: 11px; color: var(--text-muted); font-style: italic; max-width: 500px;
                            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wave-header .wave-progress { width: 100px; height: 6px; background: var(--gray-bg);
                                 border-radius: 3px; overflow: hidden; }
  .wave-header .wave-progress-inner { height: 100%; border-radius: 3px; }
  .wave-header .wave-pct { font-size: 11px; color: var(--text-muted); min-width: 36px; text-align: right; }

  .wave-body { display: none; }
  .wave-body.open { display: block; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: var(--surface); color: var(--text-muted); font-weight: 500; text-align: left;
       padding: 8px 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 6px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: #1c2230; }
  tr.phase-row td { background: var(--surface); font-weight: 600; }
  tr.cut td { opacity: 0.5; text-decoration: line-through; }
  tr.absorbed td { opacity: 0.6; font-style: italic; }

  .status-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
                  font-weight: 500; white-space: nowrap; }
  .status-completed { background: var(--green-bg); color: var(--green); }
  .status-stable { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
  .status-partial { background: var(--yellow-bg); color: var(--yellow); }
  .status-not-started { background: var(--gray-bg); color: var(--gray); }
  .status-cut { background: var(--red-bg); color: var(--red); }
  .status-absorbed { background: var(--purple-bg); color: var(--purple); }

  .track-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px;
                 font-weight: 600; letter-spacing: 0.5px; }
  .track-academic { background: #1c2d4a; color: #79c0ff; }
  .track-startup { background: #1a3a2a; color: #3fb950; }
  .track-enterprise { background: #3d2e00; color: #d29922; }
  .track-product { background: #271052; color: #bc8cff; }
  .track-transition { background: #1c2028; color: #8b949e; }
  .track-closure { background: #3d1418; color: #f85149; }

  .id-col { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; white-space: nowrap; color: var(--blue); }
  .rb-col { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; color: var(--text-muted); }
  .desc-col { color: var(--text-muted); max-width: 400px; }
  .cut-reason { font-size: 11px; color: var(--red); font-style: italic; }
  .absorbed-into { font-size: 11px; color: var(--purple); }

  .gantt-chart { margin-top: 24px; }
  .gantt-row { display: flex; align-items: stretch; min-height: 28px; border-bottom: 1px solid var(--border); }
  .gantt-label { width: 200px; min-width: 200px; padding: 4px 12px; font-size: 12px;
                 display: flex; align-items: center; background: var(--surface);
                 border-right: 1px solid var(--border); }
  .gantt-bars { flex: 1; display: flex; position: relative; }
  .gantt-cell { flex: 1; border-right: 1px solid var(--border); min-height: 28px;
                display: flex; align-items: center; justify-content: center; }
  .gantt-bar { height: 18px; border-radius: 3px; min-width: 20px; }
  .gantt-header-row { font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .gantt-header-row .gantt-label { background: var(--bg); color: var(--text-muted); }
  .gantt-header-row .gantt-cell { background: var(--bg); color: var(--text-muted); font-size: 11px; }

  .legend { display: flex; gap: 16px; padding: 16px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .legend-dot { width: 12px; height: 12px; border-radius: 3px; }

  .footer { padding: 20px 24px; text-align: center; color: var(--text-dim); font-size: 11px;
            border-top: 1px solid var(--border); margin-top: 40px; }

  @media (max-width: 900px) {
    .controls { flex-direction: column; }
    .stats-bar { flex-direction: column; }
    .desc-col { max-width: 200px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>OTK zk-Metering — Execution Roadmap</h1>
  <div class="subtitle">Generated: ${generatedAt} | Branch: feature/u8-4-1-arch-reconciliation | Source: CANONICAL_ROADMAP_TABLE.csv</div>
</div>

<div id="stats-bar" class="stats-bar"></div>

<div class="controls">
  <label>Track:</label>
  <select id="filter-track" onchange="applyFilters()">
    <option value="all">All Tracks</option>
    <option value="Academic">Academic</option>
    <option value="Startup">Startup</option>
    <option value="Enterprise">Enterprise</option>
    <option value="Product">Product</option>
    <option value="Transition">Transition</option>
    <option value="Closure">Closure</option>
  </select>
  <label>Status:</label>
  <select id="filter-status" onchange="applyFilters()">
    <option value="all">All Statuses</option>
    <option value="COMPLETED">Completed</option>
    <option value="PARTIAL">Partial</option>
    <option value="NOT STARTED">Not Started</option>
    <option value="CUT">Cut / Absorbed</option>
  </select>
  <label>Search:</label>
  <input id="filter-search" type="text" placeholder="Filter by name or ID..." oninput="applyFilters()" style="width:180px">
  <button class="btn" onclick="toggleAllWaves(true)">Expand All</button>
  <button class="btn" onclick="toggleAllWaves(false)">Collapse All</button>
  <button class="btn" id="btn-hide-done" onclick="toggleHideDone()">Hide Done</button>
  <label>View:</label>
  <button class="btn active" id="btn-table" onclick="setView('table')">Table</button>
  <button class="btn" id="btn-gantt" onclick="setView('gantt')">Gantt</button>
</div>

<div class="container">
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div> Completed</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--green);border:1px solid var(--green)"></div> Completed/Stable</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--yellow)"></div> Partial</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--gray)"></div> Not Started</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Cut</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--purple)"></div> Absorbed</div>
  </div>
  <div id="content"></div>
</div>

<div class="footer">
  OTK zk-Metering Roadmap Gantt | Regenerate: <code>node scripts/ops/generate_roadmap_gantt.js</code> | Source: docs/CANONICAL_PHASE_TABLE.csv
</div>

<script>
const DATA = ${dataJSON};
const WAVE_NAMES = ${waveNamesJSON};
const WAVE_PARALLEL = ${waveParallelJSON};
const WAVE_ORDER = ['DONE','1','2','2H','3','4','5','6','RC2','CUT'];

let hideDone = false;
let currentView = 'table';

function statusClass(status, scope) {
  if (scope === 'CUT') return 'status-cut';
  if (scope === 'ABSORBED') return 'status-absorbed';
  if (status === 'COMPLETED') return 'status-completed';
  if (status === 'COMPLETED/STABLE') return 'status-stable';
  if (status === 'PARTIAL') return 'status-partial';
  return 'status-not-started';
}

function statusLabel(status, scope) {
  if (scope === 'CUT') return 'CUT';
  if (scope === 'ABSORBED') return 'ABSORBED';
  return status || 'NOT STARTED';
}

function trackClass(track) {
  return 'track-' + (track || 'transition').toLowerCase();
}

function isPhaseRow(item) {
  // Parent rows have id === phase (e.g., S3 has id="S3", phase="S3")
  // Sub-items have id !== phase (e.g., S3.1 has id="S3.1", phase="S3")
  // Never use sub === id — in this dataset sub always equals id for sub-items
  return !item.sub || item.id === item.phase;
}

function getWaveStats(items) {
  let total = 0, done = 0, partial = 0;
  for (const it of items) {
    if (isPhaseRow(it)) continue; // skip parent rows
    total++;
    if (it.status === 'COMPLETED' || it.status === 'COMPLETED/STABLE') done++;
    else if (it.status === 'PARTIAL') partial++;
  }
  return { total, done, partial, pct: total ? Math.round((done / total) * 100) : 0 };
}

function applyFilters() {
  const track = document.getElementById('filter-track').value;
  const status = document.getElementById('filter-status').value;
  const search = document.getElementById('filter-search').value.toLowerCase();
  render(track, status, search);
}

function toggleAllWaves(open) {
  document.querySelectorAll('.wave-body').forEach(el => {
    el.classList.toggle('open', open);
  });
  document.querySelectorAll('.arrow').forEach(el => {
    el.classList.toggle('open', open);
  });
}

function toggleHideDone() {
  hideDone = !hideDone;
  const btn = document.getElementById('btn-hide-done');
  btn.classList.toggle('active', hideDone);
  btn.textContent = hideDone ? 'Show Done' : 'Hide Done';
  applyFilters();
}

function setView(v) {
  currentView = v;
  document.getElementById('btn-table').classList.toggle('active', v === 'table');
  document.getElementById('btn-gantt').classList.toggle('active', v === 'gantt');
  applyFilters();
}

function toggleWave(waveId) {
  const body = document.getElementById('wave-body-' + waveId);
  const arrow = document.getElementById('wave-arrow-' + waveId);
  if (body && arrow) {
    body.classList.toggle('open');
    arrow.classList.toggle('open');
  }
}

function filterData(track, status, search) {
  return DATA.filter(item => {
    if (track !== 'all' && item.track !== track) return false;
    if (status === 'CUT' && item.scope !== 'CUT' && item.scope !== 'ABSORBED') return false;
    if (status === 'COMPLETED' && item.status !== 'COMPLETED' && item.status !== 'COMPLETED/STABLE') return false;
    if (status === 'PARTIAL' && item.status !== 'PARTIAL') return false;
    if (status === 'NOT STARTED' && item.status !== 'NOT STARTED') return false;
    if (search && !item.id.toLowerCase().includes(search) && !item.name.toLowerCase().includes(search) && !(item.rb||'').toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderTable(items, wave) {
  const showPack = (wave === '1' || wave === '2' || wave === '2H');
  let html = '<table><thead><tr>';
  if (showPack) html += '<th>Pack</th>';
  html += '<th>ID</th><th>Track</th><th>Name</th><th>Description</th><th>RB</th><th>Status</th>';
  if (wave === 'CUT') html += '<th>Reason / Absorbed Into</th>';
  else html += '<th>Evidence</th>';
  html += '</tr></thead><tbody>';
  let lastPack = -1;
  for (const it of items) {
    const cls = it.scope === 'CUT' ? ' class="cut"' : it.scope === 'ABSORBED' ? ' class="absorbed"' : isPhaseRow(it) ? ' class="phase-row"' : '';
    // Pack separator row for Wave 1/2/2H
    if (showPack && it.pack && it.pack !== lastPack && !isPhaseRow(it)) {
      const packNames = {1:'Runtime Gap',2:'Redis Infra',3:'Queue+Retry',4:'TAL+Policy',5:'Plan+RateLimit',6:'Invoice+Tests',7:'Logging',8:'OTel+Metrics+SLO',9:'KMS+Governance',10:'SDK npm',11:'Docs+Python',12:'CI/Manifest (parallel)',13:'Polling /status',14:'PostgreSQL Archive',15:'Shared State+Migrations',16:'Auto Trigger+Submit',17:'Crash Recovery',18:'Quickstart Guide',19:'Indexer+Dashboard',20:'/app/login',21:'API Versioning+CORS+Validation',22:'Idempotency+Shutdown+Limits+Headers',23:'Storage Migration A (PlanReg+ApiKey+Audit+Policy+CostAlert)',24:'Storage Migration B (Governance+TenantKey+DeadLetter+Indexer)',25:'JWT Auth+Session',26:'Rate Limit+Circuit Breakers+Health',27:'OTel+Tracing+Prometheus+Logs',28:'XSS+Pagination+CSRF+AuthRateLimit'};
      html += '<tr style="background:var(--bg);border-top:2px solid var(--border)"><td colspan="' + (showPack ? 8 : 7) + '" style="padding:6px 12px;font-size:11px;color:var(--blue);font-weight:600;letter-spacing:0.5px">PACK ' + it.pack + ' — ' + (packNames[it.pack]||'') + '</td></tr>';
      lastPack = it.pack;
    }
    html += '<tr' + cls + '>';
    if (showPack) html += '<td style="text-align:center;color:var(--text-muted);font-size:11px">' + (it.pack || '') + '</td>';
    html += '<td class="id-col">' + it.id + '</td>';
    html += '<td><span class="track-badge ' + trackClass(it.track) + '">' + it.track + '</span></td>';
    html += '<td>' + esc(it.name) + '</td>';
    html += '<td class="desc-col">' + esc(it.desc) + '</td>';
    html += '<td class="rb-col">' + (it.rb || '') + '</td>';
    html += '<td><span class="status-badge ' + statusClass(it.status, it.scope) + '">' + statusLabel(it.status, it.scope) + '</span></td>';
    if (wave === 'CUT') {
      html += '<td>' + (it.cutReason ? '<span class="cut-reason">' + esc(it.cutReason) + '</span>' : '') +
              (it.absorbedInto ? ' <span class="absorbed-into">&rarr; ' + it.absorbedInto + '</span>' : '') + '</td>';
    } else {
      html += '<td class="desc-col">' + esc(it.evidence) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderGanttView(filteredData) {
  // Gantt: phases as rows, waves as columns
  const phases = [];
  const seen = new Set();
  for (const it of filteredData) {
    if (!isPhaseRow(it) && !seen.has(it.phase)) {
      seen.add(it.phase);
      phases.push(it.phase);
    }
  }

  const activeWaves = WAVE_ORDER.filter(w => w !== 'DONE' && w !== 'CUT');
  let html = '<div class="gantt-chart">';
  // Header
  html += '<div class="gantt-row gantt-header-row">';
  html += '<div class="gantt-label">Phase</div>';
  html += '<div class="gantt-bars">';
  for (const w of activeWaves) html += '<div class="gantt-cell">' + (WAVE_NAMES[w] || w).replace(/ —.*/, '') + '</div>';
  html += '</div></div>';

  for (const ph of phases) {
    const phaseItems = filteredData.filter(it => it.phase === ph && !isPhaseRow(it));
    if (!phaseItems.length) continue;

    html += '<div class="gantt-row">';
    html += '<div class="gantt-label"><span class="track-badge ' + trackClass(phaseItems[0].track) + '">' + ph + '</span> ' + (phaseItems.find(i=>i.id===ph)||phaseItems[0]).name.substring(0,30) + '</div>';
    html += '<div class="gantt-bars">';
    for (const w of activeWaves) {
      const inWave = phaseItems.filter(it => it.wave === w);
      html += '<div class="gantt-cell">';
      if (inWave.length) {
        const stats = getWaveStats(inWave);
        const color = stats.pct === 100 ? 'var(--green)' : stats.pct > 0 ? 'var(--yellow)' : stats.done > 0 ? 'var(--yellow)' : 'var(--gray)';
        html += '<div class="gantt-bar" style="background:' + color + ';width:' + Math.max(20, stats.total * 15) + 'px" title="' + ph + ' in Wave ' + w + ': ' + stats.done + '/' + stats.total + '"></div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function render(trackFilter, statusFilter, searchFilter) {
  trackFilter = trackFilter || 'all';
  statusFilter = statusFilter || 'all';
  searchFilter = searchFilter || '';

  const filtered = filterData(trackFilter, statusFilter, searchFilter);

  // Group by wave
  const byWave = {};
  for (const it of filtered) {
    if (!byWave[it.wave]) byWave[it.wave] = [];
    byWave[it.wave].push(it);
  }

  // Stats bar
  let totalAll = 0, doneAll = 0, partialAll = 0, cutAll = 0;
  for (const it of DATA) {
    if (isPhaseRow(it)) continue;
    totalAll++;
    if (it.status === 'COMPLETED' || it.status === 'COMPLETED/STABLE') doneAll++;
    else if (it.status === 'PARTIAL') partialAll++;
    if (it.scope === 'CUT' || it.scope === 'ABSORBED') cutAll++;
  }
  const coreDone = doneAll;
  const coreTotal = totalAll - cutAll;
  const overallPct = coreTotal ? Math.round((coreDone / coreTotal) * 100) : 0;
  document.getElementById('stats-bar').innerHTML =
    '<div class="stat"><strong>' + coreDone + '</strong>/' + coreTotal + ' done</div>' +
    '<div class="stat"><strong>' + partialAll + '</strong> partial</div>' +
    '<div class="stat"><strong>' + cutAll + '</strong> cut</div>' +
    '<div class="stat"><strong>' + overallPct + '%</strong> overall</div>' +
    '<div class="progress-bar-outer"><div class="progress-bar-inner" style="width:' + overallPct + '%;background:' +
    (overallPct === 100 ? 'var(--green)' : overallPct > 50 ? 'var(--yellow)' : 'var(--blue)') + '"></div></div>';

  let html = '';

  if (currentView === 'gantt') {
    html = renderGanttView(filtered);
  } else {
    for (const w of WAVE_ORDER) {
      if (hideDone && w === 'DONE') continue;
      const items = byWave[w];
      if (!items || !items.length) continue;

      const stats = getWaveStats(items);
      const waveId = 'w' + w.replace(/[^a-zA-Z0-9]/g, '');
      const isOpen = w !== 'DONE';
      const pctColor = stats.pct === 100 ? 'var(--green)' : stats.pct > 0 ? 'var(--yellow)' : 'var(--gray)';

      html += '<div class="wave-section">';
      html += '<div class="wave-header" onclick="toggleWave(\\'' + waveId + '\\')">';
      html += '<span class="arrow' + (isOpen ? ' open' : '') + '" id="wave-arrow-' + waveId + '">&#9654;</span>';
      html += '<span class="wave-title">' + (WAVE_NAMES[w] || 'Wave ' + w) + '</span>';
      if (WAVE_PARALLEL[w]) html += '<span class="parallel">' + esc(WAVE_PARALLEL[w]) + '</span>';
      html += '<span class="wave-pct">' + stats.pct + '%</span>';
      html += '<div class="wave-progress"><div class="wave-progress-inner" style="width:' + stats.pct + '%;background:' + pctColor + '"></div></div>';
      html += '<span class="wave-badge" style="background:' + (stats.pct === 100 ? 'var(--green-bg)' : 'var(--gray-bg)') + ';color:' + (stats.pct === 100 ? 'var(--green)' : 'var(--text-muted)') + '">' + stats.done + '/' + stats.total + '</span>';
      html += '</div>';
      html += '<div class="wave-body' + (isOpen ? ' open' : '') + '" id="wave-body-' + waveId + '">';
      html += renderTable(items, w);
      html += '</div></div>';
    }
  }

  document.getElementById('content').innerHTML = html;
}

// Initial render
render();
</script>
</body>
</html>`;

  fs.writeFileSync(GANTT_HTML, html);
}

main();
