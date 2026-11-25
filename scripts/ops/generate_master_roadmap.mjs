#!/usr/bin/env node
/**
 * generate_master_roadmap.mjs: roadmap mestre OTK (run OTK-H1-STOPGATE-01, pacotes P5/P6)
 *
 * Fonte autoritativa: docs/governance/OTK_MASTER_ROADMAP_CURRENT.json (editar SÓ o JSON).
 * Saídas geradas (nunca editar à mão):
 *   docs/governance/OTK_MASTER_ROADMAP_CURRENT.md
 *   docs/governance/OTK_DECISION_REGISTER_CURRENT.md
 *   docs/governance/OTK_ROADMAP_PROVENANCE.md
 *   docs/governance/OTK_MASTER_GANTT_CURRENT.md
 *   docs/governance/OTK_DEPENDENCY_GRAPH_CURRENT.md
 *   docs/gantt_current.html
 *
 * Uso:
 *   node scripts/ops/generate_master_roadmap.mjs            # valida e (re)gera as saídas
 *   node scripts/ops/generate_master_roadmap.mjs --check    # valida, confere determinismo e se as saídas estão em dia
 *
 * Determinístico: nenhuma data do relógio; ordenação por ID; dois runs geram bytes idênticos.
 *
 * In English: generates the project's master roadmap documents (Markdown tables, Gantt, dependency graph and
 * an HTML page) from one authoritative JSON file, after validating it (field contract, enums, sorted lists,
 * evidence paths, dates not after `as_of`). `--check` also confirms that every evidence SHA exists in git,
 * that two generations are byte-identical and that the committed outputs are up to date; it writes nothing.
 * Without `--check` it overwrites the six output files. Exit codes: 0 = OK; 1 = validation or check errors.
 * The validation and error messages are in Portuguese. Imported by test/governance/master_roadmap.test.ts,
 * which uses the exported functions without running `main`.
 *
 * @module scripts/ops/generate_master_roadmap
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (two levels above this file). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Repo-relative path of the authoritative roadmap JSON (the only file to edit by hand). */
export const JSON_REL = 'docs/governance/OTK_MASTER_ROADMAP_CURRENT.json';
/** Exact set of fields every roadmap item must have; a missing or extra field is a validation error. */
export const ITEM_FIELDS = [
  'ID', 'TITLE', 'ORIGIN_SOURCE', 'SOURCE_COMMIT', 'LEGACY_IDS', 'HORIZON', 'MILESTONE', 'PRIORITY', 'PREDECESSORS', 'SUCCESSORS',
  'STATUS', 'EVIDENCE', 'EVIDENCE_SHA', 'GATE', 'HUMAN_DECISION', 'THESIS_RELEVANCE', 'FUTURE_WORK_CLASS', 'PARALLEL_RESOURCE_LOCK',
  'LAST_REVIEWED', 'NEXT_ACTION', 'ACTUAL_START', 'ACTUAL_FINISH', 'PROPOSED_START', 'PROPOSED_FINISH', 'ESTIMATE_UNVERIFIED',
];
/** Allowed item STATUS values. */
export const STATUSES = ['VERIFIED_COMPLETE', 'IMPLEMENTED_WITH_LIMITATION', 'VERIFIED_OPEN', 'DESIGN_ONLY', 'BLOCKED_HUMAN', 'BLOCKED_EXTERNAL',
  'BLOCKED_LOCAL', 'NOT_STARTED', 'SUPERSEDED_WITH_EVIDENCE', 'EXCLUDED_WITH_REASON', 'SOURCE_NOT_AVAILABLE'];
/** Allowed item HORIZON values (H1-* are the items of the current horizon; the others are later or excluded). */
export const HORIZONS = ['H1-CORE', 'H1-HUMAN', 'H1-OPTIONAL', 'M2', 'M3', 'H3', 'EXCLUDED'];
const DECISION_STATES = ['PENDING', 'DECIDED_RECORDED', 'DECIDED_SCOPED_RECORDED'];
const MS_STATUSES = ['NOT_STARTED', 'OPEN', 'BLOCKED_HUMAN', 'MET_WITH_LIMITATION', 'MET'];
const GATE_STATUSES = ['NOT_RUN', 'OPEN', 'PARTIAL_EVIDENCE', 'PASS_WITH_LIMITATION', 'PASS', 'BLOCKED_HUMAN', 'READY_FOR_BRUNO'];
const DONE = new Set(['VERIFIED_COMPLETE', 'IMPLEMENTED_WITH_LIMITATION']);
const CLOSED = new Set(['VERIFIED_COMPLETE', 'IMPLEMENTED_WITH_LIMITATION', 'SUPERSEDED_WITH_EVIDENCE', 'EXCLUDED_WITH_REASON']);
const H1_HZ = new Set(['H1-CORE', 'H1-HUMAN', 'H1-OPTIONAL']);
const H1_REQ = new Set(['H1-CORE', 'H1-HUMAN']);
const LATER_HZ = new Set(['M2', 'M3', 'H3', 'EXCLUDED']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Repo-relative paths of the generated files, in generation order. */
export const OUTPUT_FILES = [
  'docs/governance/OTK_MASTER_ROADMAP_CURRENT.md',
  'docs/governance/OTK_DECISION_REGISTER_CURRENT.md',
  'docs/governance/OTK_ROADMAP_PROVENANCE.md',
  'docs/governance/OTK_MASTER_GANTT_CURRENT.md',
  'docs/governance/OTK_DEPENDENCY_GRAPH_CURRENT.md',
  'docs/gantt_current.html',
];
const GEN_NOTE = (what) => `> ${what} gerado por \`scripts/ops/generate_master_roadmap.mjs\` a partir de \`${JSON_REL}\`. Não editar à mão: corrigir o JSON e regenerar.`;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isLegacy = (i) => i.ID.startsWith('LEG-');
const statusCat = (s) => (DONE.has(s) ? 'done' : s === 'SUPERSEDED_WITH_EVIDENCE' || s === 'EXCLUDED_WITH_REASON' ? 'closed' : s.startsWith('BLOCKED') || s === 'SOURCE_NOT_AVAILABLE' ? 'blocked' : 'open');

/**
 * Reads and parses the roadmap JSON.
 *
 * @param root - Repository root; defaults to {@link ROOT}.
 * @returns The parsed roadmap object.
 * @throws {Error} When the file is missing or is not valid JSON.
 */
export function load(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, JSON_REL), 'utf8'));
}

// ───────────────────────────── análise ─────────────────────────────
/**
 * Derives the views used by validation and rendering: items sorted by ID, topological order of items and
 * milestones (with levels and cycles), the critical path of open H1 items ending at the MS-H1-DEFENSE
 * milestone, status counts per horizon, legacy-item statistics and the items affected by each decision.
 *
 * Pure: reads `rm` and does not modify it.
 *
 * @param rm - Parsed roadmap (see {@link load}).
 * @returns An object with `items`, `byId`, `msById`, `topo`, `cyclic` (IDs left in a cycle), `level`, `msTopo`,
 *   `msLevel`, `msMembers`, `dist`, `critical`, `criticalItems`, `counts`, `legacyStats`, `affected` and `endDist`.
 */
export function analyze(rm) {
  const items = [...rm.items].sort((a, b) => cmp(a.ID, b.ID));
  const byId = new Map(items.map((i) => [i.ID, i]));
  const msById = new Map(rm.milestones.map((m) => [m.ID, m]));
  // ordem topológica (Kahn, fila ordenada) + ciclos
  const indeg = new Map(items.map((i) => [i.ID, 0]));
  const succ = new Map(items.map((i) => [i.ID, []]));
  for (const i of items) for (const p of i.PREDECESSORS) if (byId.has(p)) { indeg.set(i.ID, indeg.get(i.ID) + 1); succ.get(p).push(i.ID); }
  const ready = items.filter((i) => indeg.get(i.ID) === 0).map((i) => i.ID).sort(cmp);
  const topo = [];
  while (ready.length) {
    const id = ready.shift(); topo.push(id);
    for (const s of succ.get(id).sort(cmp)) { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) { ready.push(s); ready.sort(cmp); } }
  }
  const cyclic = items.filter((i) => indeg.get(i.ID) > 0).map((i) => i.ID);
  const level = new Map();
  for (const id of topo) { const i = byId.get(id); level.set(id, i.PREDECESSORS.length ? 1 + Math.max(...i.PREDECESSORS.map((p) => level.get(p) ?? 0)) : 0); }
  // ordem dos marcos
  const msTopo = []; const msSeen = new Set();
  const visitMs = (id, stack = new Set()) => {
    if (msSeen.has(id)) return; if (stack.has(id)) return; stack.add(id);
    for (const d of msById.get(id)?.DEPENDENCIES || []) visitMs(d, stack);
    msSeen.add(id); msTopo.push(id);
  };
  for (const m of [...rm.milestones].sort((a, b) => cmp(a.ID, b.ID))) visitMs(m.ID);
  const msLevel = new Map();
  for (const id of msTopo) { const m = msById.get(id); msLevel.set(id, m.DEPENDENCIES.length ? 1 + Math.max(...m.DEPENDENCIES.map((d) => msLevel.get(d) ?? 0)) : 0); }
  // caminho crítico H1: maior cadeia de itens abertos (H1-CORE/H1-HUMAN) terminando no marco MS-H1-DEFENSE
  const open = (i) => i && !CLOSED.has(i.STATUS);
  const dist = new Map(); const via = new Map();
  for (const id of topo) {
    const i = byId.get(id);
    if (!open(i) || !H1_REQ.has(i.HORIZON)) continue;
    let best = 0; let bp = null;
    for (const p of [...i.PREDECESSORS].sort(cmp)) { const q = byId.get(p); if (!open(q)) continue; const d = dist.get(p) ?? 0; if (d > best) { best = d; bp = p; } }
    dist.set(id, best + 1); via.set(id, bp);
  }
  const msMembers = new Map(rm.milestones.map((m) => [m.ID, []]));
  for (const i of items) if (i.MILESTONE && msMembers.has(i.MILESTONE)) msMembers.get(i.MILESTONE).push(i.ID);
  const endDist = new Map(); const endVia = new Map();
  for (const mid of msTopo) {
    let best = 0; let b = null;
    for (const id of msMembers.get(mid)) { const d = dist.get(id) ?? 0; if (d > best) { best = d; b = { item: id }; } }
    for (const dep of [...msById.get(mid).DEPENDENCIES].sort(cmp)) { const d = endDist.get(dep) ?? 0; if (d > best) { best = d; b = { ms: dep }; } }
    endDist.set(mid, best); endVia.set(mid, b);
  }
  const critical = [];
  const target = 'MS-H1-DEFENSE';
  if (msById.has(target)) {
    let cur = { ms: target }; const guard = new Set();
    while (cur && !guard.has(JSON.stringify(cur))) {
      guard.add(JSON.stringify(cur));
      if (cur.ms) { critical.unshift({ type: 'milestone', id: cur.ms }); cur = endVia.get(cur.ms); }
      else { const chain = []; let x = cur.item; while (x) { chain.unshift(x); x = via.get(x); } critical.unshift(...chain.map((id) => ({ type: 'item', id }))); cur = null; }
    }
  }
  // milestone markers só fazem sentido onde o caminho passa por eles: manter os do fim
  const criticalItems = critical.filter((c) => c.type === 'item').map((c) => c.id);
  const counts = {};
  for (const h of HORIZONS) { counts[h] = {}; for (const s of STATUSES) counts[h][s] = 0; }
  for (const i of items) if (counts[i.HORIZON] && counts[i.HORIZON][i.STATUS] !== undefined) counts[i.HORIZON][i.STATUS]++;
  const mapped = new Set((rm.legacy_import?.explicit_mappings || []).map((m) => m.LEGACY_ID));
  const legacy = items.filter(isLegacy);
  const legacyStats = {
    recovered: legacy.length,
    reconciled_explicit_mapping: legacy.filter((i) => mapped.has(i.LEGACY_IDS[0])).length,
    lacking_item_verification: legacy.filter((i) => !mapped.has(i.LEGACY_IDS[0])).length,
    by_source: {},
    by_status: {},
  };
  for (const i of legacy) { legacyStats.by_source[i.ORIGIN_SOURCE] = (legacyStats.by_source[i.ORIGIN_SOURCE] || 0) + 1; legacyStats.by_status[i.STATUS] = (legacyStats.by_status[i.STATUS] || 0) + 1; }
  const affected = new Map(rm.decisions.map((d) => [d.ID, []]));
  for (const i of items) for (const d of i.HUMAN_DECISION || []) if (affected.has(d)) affected.get(d).push(i.ID);
  return { items, byId, msById, topo, cyclic, level, msTopo, msLevel, msMembers, dist, critical, criticalItems, counts, legacyStats, affected, endDist };
}

// ───────────────────────────── validação ─────────────────────────────
/**
 * Validates the roadmap against its contract and collects errors and warnings (messages in Portuguese).
 *
 * Reads the file system only to check that evidence paths exist under the repository root.
 *
 * @param rm - Parsed roadmap.
 * @param opts - Options; `opts.root` is the repository root used for evidence paths (default {@link ROOT}).
 * @returns `{ errors, warnings, stats, analysis }`; the roadmap is valid when `errors` is empty.
 */
export function validate(rm, opts = {}) {
  const root = opts.root || ROOT;
  const errors = []; const warnings = [];
  const E = (m) => errors.push(m); const W = (m) => warnings.push(m);
  for (const k of ['schema', 'as_of', 'base_sha', 'base_sha_full', 'sources', 'milestones', 'gates', 'decisions', 'items']) if (!(k in rm)) E(`campo de topo ausente: ${k}`);
  if ('generated_at' in rm) E('generated_at não é permitido (determinismo); use as_of');
  if (!DATE_RE.test(rm.as_of || '')) E('as_of inválido');
  if (!/^[0-9a-f]{40}$/.test(rm.base_sha_full || '') || !String(rm.base_sha_full).startsWith(rm.base_sha)) E('base_sha/base_sha_full inconsistentes');
  const A = analyze(rm);
  const ids = new Set();
  const msIds = new Set(rm.milestones.map((m) => m.ID));
  const gateIds = new Set(rm.gates.map((g) => g.GATE_ID));
  const decIds = new Set(rm.decisions.map((d) => d.ID));
  const msH1 = new Set(rm.milestones.filter((m) => m.HORIZON === 'H1').map((m) => m.ID));
  for (const i of rm.items) {
    const keys = Object.keys(i);
    const missing = ITEM_FIELDS.filter((f) => !keys.includes(f)); const extra = keys.filter((k) => !ITEM_FIELDS.includes(k));
    if (missing.length || extra.length) E(`${i.ID}: campos fora do contrato (faltam ${missing.join(',') || '-'}; sobram ${extra.join(',') || '-'})`);
    if (ids.has(i.ID)) E(`ID duplicado: ${i.ID}`); ids.add(i.ID);
    if (!STATUSES.includes(i.STATUS)) E(`${i.ID}: STATUS fora do enum: ${i.STATUS}`);
    if (!HORIZONS.includes(i.HORIZON)) E(`${i.ID}: HORIZON fora do enum: ${i.HORIZON}`);
    if (i.PRIORITY !== null && !['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].includes(i.PRIORITY)) E(`${i.ID}: PRIORITY inválida`);
    if (i.MILESTONE !== null && !msIds.has(i.MILESTONE)) E(`${i.ID}: MILESTONE inexistente ${i.MILESTONE}`);
    if (i.GATE !== null && !gateIds.has(i.GATE)) E(`${i.ID}: GATE inexistente ${i.GATE}`);
    for (const f of ['LEGACY_IDS', 'PREDECESSORS', 'SUCCESSORS', 'HUMAN_DECISION']) {
      if (!Array.isArray(i[f])) { E(`${i.ID}: ${f} deve ser lista`); continue; }
      if (JSON.stringify(i[f]) !== JSON.stringify([...new Set(i[f])].sort(cmp))) E(`${i.ID}: ${f} deve ser ordenada e sem repetição`);
    }
    for (const d of i.HUMAN_DECISION || []) if (!decIds.has(d)) E(`${i.ID}: decisão inexistente ${d}`);
    for (const p of i.PREDECESSORS || []) { if (p === i.ID) E(`${i.ID}: predecessor de si mesmo`); }
    if (DONE.has(i.STATUS) || i.STATUS === 'SUPERSEDED_WITH_EVIDENCE') {
      if (!i.EVIDENCE || !i.EVIDENCE_SHA) E(`${i.ID}: ${i.STATUS} sem EVIDENCE/EVIDENCE_SHA`);
    }
    if (i.STATUS === 'VERIFIED_COMPLETE') {
      if (!/^[0-9a-f]{40}$/.test(i.EVIDENCE_SHA || '')) E(`${i.ID}: VERIFIED_COMPLETE exige EVIDENCE_SHA de commit git (40 hex)`);
      if (String(i.EVIDENCE || '').startsWith('local:')) E(`${i.ID}: VERIFIED_COMPLETE não aceita evidência fora do git`);
      if (isLegacy(i)) E(`${i.ID}: item legado não pode ser VERIFIED_COMPLETE a partir de texto histórico`);
    }
    if (i.EVIDENCE && !String(i.EVIDENCE).startsWith('local:') && opts.checkFiles !== false) {
      for (const p of String(i.EVIDENCE).split(' ; ')) if (!fs.existsSync(path.join(root, p))) E(`${i.ID}: caminho de evidência inexistente: ${p}`);
    }
    if (i.EVIDENCE_SHA && !/^[0-9a-f]{40}$/.test(i.EVIDENCE_SHA) && !/^sha256:[0-9a-f]{64}$/.test(i.EVIDENCE_SHA)) E(`${i.ID}: EVIDENCE_SHA em formato desconhecido`);
    if (i.STATUS === 'SOURCE_NOT_AVAILABLE' && !i.NEXT_ACTION) E(`${i.ID}: SOURCE_NOT_AVAILABLE sem NEXT_ACTION`);
    for (const f of ['ACTUAL_START', 'ACTUAL_FINISH']) {
      if (i[f] !== null && !DATE_RE.test(i[f])) E(`${i.ID}: ${f} inválida`);
      if (i[f] !== null && i[f] > rm.as_of) E(`${i.ID}: ${f} posterior a as_of`);
      if (i[f] !== null && isLegacy(i)) E(`${i.ID}: item legado não pode ter data real (datas históricas planejadas não são reais)`);
    }
    if (i.ACTUAL_FINISH !== null && !CLOSED.has(i.STATUS)) E(`${i.ID}: ACTUAL_FINISH em item não concluído`);
    for (const f of ['PROPOSED_START', 'PROPOSED_FINISH']) if (i[f] !== null && i[f] !== 'TBD' && !DATE_RE.test(i[f])) E(`${i.ID}: ${f} inválida`);
    if (H1_REQ.has(i.HORIZON) && !CLOSED.has(i.STATUS) && !msH1.has(i.MILESTONE)) E(`${i.ID}: item H1 aberto sem marco H1`);
    if (LATER_HZ.has(i.HORIZON) && i.MILESTONE && msH1.has(i.MILESTONE)) E(`${i.ID}: horizonte ${i.HORIZON} não pode compor marco H1 ${i.MILESTONE}`);
  }
  for (const s of rm.enums?.STATUS || []) if (!STATUSES.includes(s)) E(`enum STATUS do JSON diverge do validador: ${s}`);
  // predecessores e sucessores
  const byId = new Map(rm.items.map((i) => [i.ID, i]));
  const inv = new Map(rm.items.map((i) => [i.ID, []]));
  for (const i of rm.items) for (const p of i.PREDECESSORS) { if (!byId.has(p)) E(`${i.ID}: predecessor não resolve: ${p}`); else inv.get(p).push(i.ID); }
  for (const i of rm.items) { const exp = [...new Set(inv.get(i.ID))].sort(cmp); if (JSON.stringify(exp) !== JSON.stringify(i.SUCCESSORS)) E(`${i.ID}: SUCCESSORS ≠ inverso de PREDECESSORS (esperado ${exp.join(',') || '-'})`); }
  if (A.cyclic.length) E(`ciclo de dependências envolvendo: ${A.cyclic.slice(0, 20).join(', ')}`);
  // horizonte: M2/M3/H3 nunca bloqueiam H1
  for (const i of rm.items) {
    for (const p of i.PREDECESSORS) {
      const q = byId.get(p); if (!q) continue;
      if (H1_HZ.has(i.HORIZON) && LATER_HZ.has(q.HORIZON)) E(`${i.ID} (${i.HORIZON}) depende de ${p} (${q.HORIZON}): M2/M3/H3/EXCLUDED não podem bloquear H1`);
      if ((q.STATUS === 'EXCLUDED_WITH_REASON' || q.HORIZON === 'EXCLUDED') && !CLOSED.has(i.STATUS)) E(`${i.ID}: item ativo tem predecessor excluído ${p}`);
      if (DONE.has(i.STATUS) && !CLOSED.has(q.STATUS)) W(`${i.ID} (${i.STATUS}) tem predecessor aberto ${p} (${q.STATUS})`);
    }
  }
  const msById = new Map(rm.milestones.map((m) => [m.ID, m]));
  const msIdSet = new Set();
  for (const m of rm.milestones) {
    if (msIdSet.has(m.ID)) E(`marco duplicado ${m.ID}`); msIdSet.add(m.ID);
    for (const f of ['ID', 'NAME', 'HORIZON', 'DEPENDENCIES', 'STATUS', 'DEFINITION', 'DOD']) if (!(f in m)) E(`marco ${m.ID}: campo ${f} ausente`);
    if (!Array.isArray(m.DOD) || !m.DOD.length) E(`marco ${m.ID}: DoD vazio`);
    if (!MS_STATUSES.includes(m.STATUS)) E(`marco ${m.ID}: STATUS inválido`);
    for (const d of m.DEPENDENCIES) if (!msById.has(d)) E(`marco ${m.ID}: dependência inexistente ${d}`);
    if (m.EVIDENCE && !fs.existsSync(path.join(root, m.EVIDENCE))) E(`marco ${m.ID}: evidência inexistente ${m.EVIDENCE}`);
  }
  const closure = (id, seen = new Set()) => { for (const d of msById.get(id)?.DEPENDENCIES || []) if (!seen.has(d)) { seen.add(d); closure(d, seen); } return seen; };
  for (const m of rm.milestones) {
    const c = closure(m.ID);
    if (c.has(m.ID)) E(`ciclo entre marcos em ${m.ID}`);
    if (m.HORIZON === 'H1') for (const d of c) if (msById.get(d)?.HORIZON !== 'H1') E(`marco H1 ${m.ID} depende (transitivamente) de ${d} (${msById.get(d)?.HORIZON})`);
  }
  const required = ['MS-M0', 'MS-M1', 'MS-H1-TECH', 'MS-H1-WIN', 'MS-H1-REPRO', 'MS-H1-SCI', 'MS-H1-DEFENSE', 'MS-M2-T1', 'MS-M2-T2', 'MS-M2-T3', 'MS-M2-T4', 'MS-M2-T5', 'MS-M3', 'MS-H3'];
  for (const r of required) if (!msById.has(r)) E(`marco obrigatório ausente: ${r}`);
  // gates
  const gById = new Map(rm.gates.map((g) => [g.GATE_ID, g]));
  for (const g of rm.gates) {
    if (!GATE_STATUSES.includes(g.CURRENT_STATUS)) E(`gate ${g.GATE_ID}: CURRENT_STATUS inválido ${g.CURRENT_STATUS}`);
    if (g.MILESTONE !== null && !msById.has(g.MILESTONE)) E(`gate ${g.GATE_ID}: marco inexistente ${g.MILESTONE}`);
    for (const d of g.DEPENDENCIES) {
      const h = gById.get(d); if (!h) { E(`gate ${g.GATE_ID}: dependência inexistente ${d}`); continue; }
      if (H1_REQ.has(g.HORIZON) && LATER_HZ.has(h.HORIZON)) E(`gate H1 ${g.GATE_ID} depende de gate ${d} (${h.HORIZON})`);
    }
    if (['PASS', 'PASS_WITH_LIMITATION'].includes(g.CURRENT_STATUS) && (!g.CURRENT_EVIDENCE || !/^[0-9a-f]{40}$/.test(g.CURRENT_EVIDENCE_SHA || ''))) E(`gate ${g.GATE_ID}: ${g.CURRENT_STATUS} sem evidência em git`);
  }
  // decisões
  for (const d of rm.decisions) {
    if (!DECISION_STATES.includes(d.STATE)) E(`decisão ${d.ID}: estado inválido ${d.STATE}`);
    if (d.STATE !== 'PENDING' && (!d.RECORD || !fs.existsSync(path.join(root, d.RECORD)))) E(`decisão ${d.ID}: ${d.STATE} exige RECORD em git`);
    if (/APPROVED/.test(d.STATE)) E(`decisão ${d.ID}: estado APPROVED não é permitido neste registro`);
    for (const r of d.RELATED) if (!decIds.has(r)) E(`decisão ${d.ID}: RELATED inexistente ${r}`);
    for (const g of d.AFFECTED_GATES) if (!gById.has(g)) E(`decisão ${d.ID}: gate inexistente ${g}`);
  }
  // fontes
  for (const s of rm.sources) if (s.KIND === 'IN_REPO' && !fs.existsSync(path.join(root, s.PATH))) E(`fonte ${s.ID}: caminho inexistente ${s.PATH}`);
  const stats = {
    items: rm.items.length,
    source_not_available: rm.items.filter((i) => i.STATUS === 'SOURCE_NOT_AVAILABLE').map((i) => i.ID),
    legacy: A.legacyStats,
    critical_path: A.criticalItems,
  };
  return { errors, warnings, stats, analysis: A };
}

// ───────────────────────────── utilidades de renderização ─────────────────────────────
const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const short = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const sha7 = (s) => (s ? (s.startsWith('sha256:') ? 'sha256:' + s.slice(7, 15) + '…' : s.slice(0, 8)) : 'n/a');
const list = (a) => (a && a.length ? a.join(', ') : 'n/a');
function sched(i) {
  if (i.ACTUAL_START || i.ACTUAL_FINISH) return `REAL ${i.ACTUAL_START || '?'} → ${i.ACTUAL_FINISH || 'em curso'}`;
  if ((i.PROPOSED_START && i.PROPOSED_START !== 'TBD') || (i.PROPOSED_FINISH && i.PROPOSED_FINISH !== 'TBD')) return `PROPOSTO ${i.PROPOSED_START || 'TBD'} → ${i.PROPOSED_FINISH || 'TBD'}`;
  return 'TBD';
}

function renderRoadmapMd(rm, A) {
  const L = [];
  const nonLeg = A.items.filter((i) => !isLegacy(i));
  L.push('# OTK: Roadmap mestre atual', '', GEN_NOTE('Documento'), '');
  L.push(`Data de referência (as_of): **${rm.as_of}** · base: \`${rm.base_sha}\` (\`${rm.base_sha_full}\`) · esquema \`${rm.schema}\``, '');
  L.push(rm.definition_cu, '');
  L.push('## 1. Como ler', '',
    '- O JSON é o roadmap autoritativo. Os documentos antigos (ROADMAP_UNIFIED, CANONICAL_ROADMAP_COMPLETE, CSVs, gantt.html) são histórico; ver `OTK_ROADMAP_PROVENANCE.md`.',
    '- Itens `OTK-Dxx-…` vêm do pacote local 20261008 (IDs reais, nenhum inventado); `H1S-*`, `H1R2-*` e `OTK-STOPGATE01-*` vêm das runs de 13 e 14/10; `LEG-*` são registros legados preservados (nunca apagados).',
    '- `VERIFIED_COMPLETE` só com evidência em git e SHA. Item legado nunca é `VERIFIED_COMPLETE` a partir de texto histórico.',
    '- Datas: só há datas reais quando a evidência registra o dia; não há datas propostas inventadas. O resto é `TBD` e a ordem vem das dependências.',
    '- Nenhum item ou marco M2/M3/H3 é pré-requisito de H1 (validado por `--check`).', '');
  L.push('## 2. Contagens por horizonte e status', '');
  const used = STATUSES.filter((s) => HORIZONS.some((h) => A.counts[h][s]));
  L.push(`| Horizonte | ${used.join(' | ')} | Total |`, `|---|${used.map(() => '---:').join('|')}|---:|`);
  const tot = Object.fromEntries(used.map((s) => [s, 0]));
  for (const h of HORIZONS) {
    const row = used.map((s) => A.counts[h][s]); const t = row.reduce((a, b) => a + b, 0);
    used.forEach((s, k) => { tot[s] += row[k]; });
    L.push(`| ${h} | ${row.join(' | ')} | ${t} |`);
  }
  L.push(`| **Total** | ${used.map((s) => tot[s]).join(' | ')} | ${A.items.length} |`, '');
  L.push(`Sem os ${A.legacyStats.recovered} registros legados \`LEG-*\`: ${nonLeg.length} itens.`, '');
  L.push('## 3. Marcos', '', '| Marco | Nome | Horizonte | Status | Depende de | Itens (abertos / total) | Evidência |', '|---|---|---|---|---|---|---|');
  for (const id of A.msTopo) {
    const m = A.msById.get(id); const mem = A.msMembers.get(id).map((x) => A.byId.get(x));
    const openN = mem.filter((i) => !CLOSED.has(i.STATUS)).length;
    L.push(`| ${m.ID} | ${esc(m.NAME)} | ${m.HORIZON} | ${m.STATUS} | ${list(m.DEPENDENCIES)} | ${openN} / ${mem.length} | ${m.EVIDENCE ? `\`${m.EVIDENCE}\` @ ${sha7(m.EVIDENCE_SHA)}` : 'n/a'} |`);
  }
  L.push('');
  for (const id of A.msTopo) {
    const m = A.msById.get(id);
    L.push(`### ${m.ID}: ${m.NAME}`, '', esc(m.DEFINITION), '', 'Definition of Done:', ...m.DOD.map((d) => `- ${d}`), '');
  }
  L.push('## 4. Caminho crítico H1', '',
    'Maior cadeia de itens H1-CORE/H1-HUMAN ainda abertos, seguindo `PREDECESSORS`, até o marco `MS-H1-DEFENSE` (marcos só agregam; não criam dependência artificial entre itens). Peso: 1 por item aberto.', '');
  if (A.critical.length) {
    let k = 0;
    for (const c of A.critical) {
      if (c.type === 'milestone') L.push(`- marco **${c.id}** (${A.msById.get(c.id).STATUS})`);
      else { const i = A.byId.get(c.id); k++; L.push(`${k}. \`${i.ID}\`: ${esc(i.TITLE)} · ${i.STATUS} · ${i.HORIZON}${i.HUMAN_DECISION.length ? ` · decisão: ${i.HUMAN_DECISION.join(', ')}` : ''}`); }
    }
  } else L.push('- (nenhum item aberto)');
  L.push('');
  L.push('## 5. Bloqueios em H1', '', '| ID | Título | Status | Horizonte | Marco | Decisão humana | Próxima ação |', '|---|---|---|---|---|---|---|');
  for (const i of nonLeg.filter((x) => H1_HZ.has(x.HORIZON) && statusCat(x.STATUS) === 'blocked')) L.push(`| \`${i.ID}\` | ${esc(short(i.TITLE, 90))} | ${i.STATUS} | ${i.HORIZON} | ${i.MILESTONE || 'n/a'} | ${list(i.HUMAN_DECISION)} | ${esc(short(i.NEXT_ACTION, 160))} |`);
  L.push('');
  L.push('## 6. Itens H1 abertos por marco', '');
  for (const id of A.msTopo.filter((x) => A.msById.get(x).HORIZON === 'H1')) {
    const rows = A.msMembers.get(id).map((x) => A.byId.get(x)).filter((i) => H1_HZ.has(i.HORIZON) && !CLOSED.has(i.STATUS));
    if (!rows.length) continue;
    L.push(`### ${id}`, '', '| ID | Título | Status | Horizonte | Predecessores abertos | Decisão |', '|---|---|---|---|---|---|');
    for (const i of rows) L.push(`| \`${i.ID}\` | ${esc(short(i.TITLE, 90))} | ${i.STATUS} | ${i.HORIZON} | ${list(i.PREDECESSORS.filter((p) => !CLOSED.has(A.byId.get(p).STATUS)))} | ${list(i.HUMAN_DECISION)} |`);
    L.push('');
  }
  L.push('## 7. Concluídos ou implementados com limitação (exceto legado)', '', '| ID | Status | Evidência | SHA | Data real |', '|---|---|---|---|---|');
  for (const i of nonLeg.filter((x) => DONE.has(x.STATUS))) L.push(`| \`${i.ID}\` | ${i.STATUS} | ${esc(short(i.EVIDENCE, 120))} | ${sha7(i.EVIDENCE_SHA)} | ${i.ACTUAL_FINISH || 'n/a'} |`);
  L.push('');
  L.push('## 8. Depois de H1 (M2, M3, H3)', '', '| Marco | Itens | Abertos | Bloqueados por decisão |', '|---|---:|---:|---:|');
  for (const id of A.msTopo.filter((x) => A.msById.get(x).HORIZON !== 'H1')) {
    const mem = A.msMembers.get(id).map((x) => A.byId.get(x));
    L.push(`| ${id} | ${mem.length} | ${mem.filter((i) => !CLOSED.has(i.STATUS)).length} | ${mem.filter((i) => statusCat(i.STATUS) === 'blocked').length} |`);
  }
  L.push('');
  const LS = A.legacyStats;
  L.push('## 9. Legado: reconciliação de contagens', '',
    `- Registros legados recuperados: **${LS.recovered}** (${Object.entries(LS.by_source).sort().map(([k, v]) => `${k}: ${v}`).join('; ')}).`,
    `- Reconciliados com WP do pacote 20261008 por mapeamento explícito (vision_map): **${LS.reconciled_explicit_mapping}**.`,
    `- Ainda sem verificação item a item (status só do texto histórico): **${LS.lacking_item_verification}**.`,
    `- Por status: ${Object.entries(LS.by_status).sort().map(([k, v]) => `${k} ${v}`).join('; ')}.`, '');
  const inv = rm.historical_inventory_20261008;
  L.push('## 10. Inventário histórico do pacote 20261008', '', '| Medida | Observado nos dados | Esperado | Confere |', '|---|---:|---:|---|');
  for (const k of Object.keys(inv.expected)) L.push(`| ${k} | ${inv.observed[k]} | ${inv.expected[k]} | ${inv.observed[k] === inv.expected[k] ? 'sim' : '**não**'} |`);
  L.push('');
  return L.join('\n') + '\n';
}

function renderDecisionsMd(rm, A) {
  const L = [];
  L.push('# OTK: Registro de decisões humanas (atual)', '', GEN_NOTE('Registro'), '');
  L.push(`Data de referência: ${rm.as_of}. Nenhuma proposta abaixo está aprovada por Bruno, salvo quando a coluna "Registro" aponta um arquivo em git com a decisão dele (e, mesmo assim, só no escopo escrito ali).`, '',
    '- `PENDING`: aguarda Bruno. A "proposta técnica" é da execução, não é decisão.',
    '- `DECIDED_SCOPED_RECORDED`: decidida por Bruno para um escopo limitado (ex.: RUN-S), com registro em git; não vale como aprovação global.',
    '- `DECIDED_RECORDED`: decidida por Bruno, com registro em git.',
    '- Prefixos: `H1-D*` são D1–D9 das runs H1 de 13/10; `PKG-D*` são D1–D5 do pacote 20261008 (temas diferentes); `N-D*` e `R2-D*` vêm de `10_HUMAN_DECISIONS.md` da H1R2.', '');
  const pend = rm.decisions.filter((d) => d.STATE === 'PENDING');
  const dec = rm.decisions.filter((d) => d.STATE !== 'PENDING');
  L.push(`## 1. Pendentes (${pend.length})`, '', '| ID | Questão | Opções | Proposta técnica (não aprovada) | Itens afetados | Gates | Relacionadas | Origem | Nota |', '|---|---|---|---|---|---|---|---|---|');
  for (const d of pend) L.push(`| **${d.ID}** | ${esc(d.QUESTION)} | ${esc(d.OPTIONS.join(' / ') || 'n/a')} | ${esc(d.PROPOSAL || 'n/a')} | ${list(A.affected.get(d.ID))} | ${list(d.AFFECTED_GATES)} | ${list(d.RELATED)} | ${esc(d.ORIGIN)} | ${esc(d.NOTE || '')} |`);
  L.push('', `## 2. Já decididas, com registro em git (${dec.length})`, '', '| ID | Estado | Questão | Decisão registrada | Registro | Itens afetados | Nota |', '|---|---|---|---|---|---|---|');
  for (const d of dec) L.push(`| ${d.ID} | ${d.STATE} | ${esc(d.QUESTION)} | ${esc(d.PROPOSAL || 'n/a')} | \`${d.RECORD}\` | ${list(A.affected.get(d.ID))} | ${esc(d.NOTE || '')} |`);
  L.push('', '## 3. Decisões das quais a run STOPGATE-01 depende (charter)', '',
    'N-D4, D1–D9 (aqui `H1-D1`..`H1-D9`), R2-D1..R2-D8 (em especial R2-D5..D7 para o P3), N-D6 (licença), M24-DYN-08/09 (N-D5), SEC02-N06 (N-D7), PA-03 v1 (N-D8), revisão do orientador (`CHARTER-ADVISOR-REVIEW`) e aprovação do roadmap mestre (`D-ROADMAP`, gate 47 do pacote 20261008). Todas continuam `PENDING` neste registro.', '');
  return L.join('\n') + '\n';
}

function renderProvenanceMd(rm, A) {
  const L = [];
  L.push('# OTK: Proveniência do roadmap e índice de navegação', '', GEN_NOTE('Documento'), '');
  L.push(`Data de referência: ${rm.as_of} · base \`${rm.base_sha_full}\`.`, '');
  L.push('## 1. Índice de navegação', '');
  const groups = [
    ['Autoritativo atual', (s) => /CURRENT_SCOPE/.test(s.CURRENT_STATUS), ['`docs/governance/OTK_MASTER_ROADMAP_CURRENT.json` (fonte)', '`docs/governance/OTK_MASTER_ROADMAP_CURRENT.md`', '`docs/governance/OTK_DECISION_REGISTER_CURRENT.md`', '`docs/governance/OTK_H1_DEFENSE_STOP_GATE.md`', '`docs/governance/OTK_MASTER_GANTT_CURRENT.md`', '`docs/governance/OTK_DEPENDENCY_GRAPH_CURRENT.md`', '`docs/gantt_current.html`']],
    ['Evidência atual (alimenta status)', (s) => /CURRENT_EVIDENCE|DECISION_RECORD/.test(s.CURRENT_STATUS)],
    ['Ainda relevante (intenção, não status)', (s) => /STILL_RELEVANT/.test(s.CURRENT_STATUS)],
    ['Fonte histórica importada (fora do git)', (s) => /HISTORICAL_SOURCE_IMPORTED/.test(s.CURRENT_STATUS)],
    ['Legado histórico', (s) => /^LEGACY_HISTORICAL|NEEDS_POINTER/.test(s.CURRENT_STATUS)],
    ['Escopo superado', (s) => /SUPERSEDED/.test(s.CURRENT_STATUS)],
    ['Arquivo', (s) => /^ARCHIVE/.test(s.CURRENT_STATUS)],
  ];
  for (const [name, f, extra] of groups) {
    const ss = rm.sources.filter(f);
    L.push(`- **${name}:** ${[...(extra || []), ...ss.map((s) => `\`${s.PATH}\` (${s.ID})`)].join('; ') || 'n/a'}`);
  }
  L.push(`- **Fonte não importada integralmente:** o pacote 20261008 (SRC-01) só teve campos estruturados importados (IDs, nomes, horizontes, dependências, gates, aceite, decisões, alternativas, FWMAP); seus 198 arquivos não foram copiados. ROADMAP_UNIFIED, PRODUCT_VISION, MASTER_BACKLOG_v4_FREEZE e os arquivos de _archive não foram reimportados item a item.`, '');
  L.push('## 2. Registro de fontes', '', '| ID | Caminho | Versão/data | Branch | SHA | Autoridade declarada | Relação | Status atual |', '|---|---|---|---|---|---|---|---|');
  for (const s of rm.sources) L.push(`| ${s.ID} | \`${esc(s.PATH)}\` | ${esc(s.VERSION_DATE)} | ${s.BRANCH || 'n/a (fora do git)'} | ${s.KIND === 'LOCAL_PACKAGE' ? 'ver detalhe' : '`' + s.SHA + '`'} | ${esc(s.AUTHORITY_CLAIMED)} | ${esc(s.RELATION)} | ${esc(s.CURRENT_STATUS)} |`);
  L.push('');
  for (const s of rm.sources) {
    L.push(`### ${s.ID}: \`${s.PATH}\``, '', `- Escopo: ${s.SCOPE}`, `- SHA/hash: ${s.SHA}`, `- Asserções obsoletas: ${s.OBSOLETE_ASSERTIONS}`, `- Contradições com evidência recente: ${s.CONTRADICTIONS}`, `- Requisitos únicos: ${s.UNIQUE_REQUIREMENTS}`, '');
  }
  L.push('## 3. Mapeamento de horizontes (pacote 20261008 → enum atual)', '', '| hz no pacote | Regra |', '|---|---|');
  for (const m of rm.horizon_mapping) L.push(`| ${m.hz_20261008} | ${esc(m.rule)} |`);
  L.push('', 'Marcos por fase: segurança, API, release, licença e governança → `MS-H1-TECH`; descrição declarada do artefato, CU, calibração, conciliação, claims e bibliografia → `MS-H1-SCI`; reprodução (D20-F03, runbook) → `MS-H1-REPRO`; dissertação, KNOWLEDGE e auditoria final do texto → `MS-H1-DEFENSE`; ms M0 → `MS-M0`; pacote acadêmico já gerado → `MS-M1`. Em M2: D10-F02/D13-F02 → T1, D03-F02 → T2, D12-F02 → T3, D07-F02/D19-F03 → T4, D11-F02 → T5.', '');
  L.push('## 4. Alternativas do pacote (ALT-*) e como foram resolvidas nos predecessores', '', '| ALT | Decisão | Gate | Modo | Resolvida para | Base |', '|---|---|---|---|---|---|');
  for (const a of rm.alternatives) L.push(`| ${a.ID} | ${a.DECISION || 'n/a'} | ${a.GATE} | ${a.MODE} | ${list(a.RESOLVED_TO)} | ${esc(a.BASIS)} |`);
  L.push('', 'Os ramos não escolhidos foram preservados como itens (`EXCLUDED_WITH_REASON` ou `SUPERSEDED_WITH_EVIDENCE`, com motivo), nunca apagados.', '');
  L.push('## 5. Itens legados: método de mapeamento', '',
    '1. Cada registro legado vira um item `LEG-<id>` com `LEGACY_IDS=[<id>]`, preservando nome, onda e status declarado no texto de `NEXT_ACTION`. Nenhum registro foi fundido com outro por semelhança de palavras.',
    '2. IDs duplicados no gantt.html (RC2.1–RC2.5 aparecem duas vezes com nomes diferentes) viram `LEG-<id>-DUP2`.',
    '3. Mapeamento para WP só quando o próprio pacote 20261008 o declara (`src/vision_map.yaml`); nesse caso o ID legado entra em `LEGACY_IDS` do WP.',
    '4. Status: `COMPLETED` histórico vira `SUPERSEDED_WITH_EVIDENCE` (o pacote 20261008 trata as alegações de abril como históricas e re-planeja por domínio); cortes viram `EXCLUDED_WITH_REASON`; absorvidos viram `SUPERSEDED_WITH_EVIDENCE` apontando o destino. Nenhum legado é `VERIFIED_COMPLETE`.',
    '5. Datas planejadas antigas não são importadas como datas reais.', '');
  const LS = A.legacyStats;
  L.push('### Contagens', '', '| Medida | Valor |', '|---|---:|');
  L.push(`| Registros legados recuperados | ${LS.recovered} |`);
  for (const [k, v] of Object.entries(rm.legacy_import.counts)) L.push(`| · ${k} | ${v} |`);
  L.push(`| Reconciliados por mapeamento explícito | ${LS.reconciled_explicit_mapping} |`, `| Sem verificação item a item | ${LS.lacking_item_verification} |`, '');
  L.push('### Mapeamentos explícitos', '', '| ID legado | WPs | vision_map n |', '|---|---|---:|');
  for (const m of rm.legacy_import.explicit_mappings) L.push(`| ${m.LEGACY_ID} | ${m.WPS.join(', ')} | ${m.VISION_MAP_N} |`);
  L.push('', '## 6. Divergências de contagem encontradas', '');
  const inv = rm.historical_inventory_20261008;
  L.push(`- Pacote 20261008: ${Object.keys(inv.expected).map((k) => `${k} ${inv.observed[k]}/${inv.expected[k]}`).join(', ')} → ${inv.matches ? 'todas conferem' : '**há divergência**'}. Também: ${inv.observed.decisions} decisões e ${inv.observed.alternatives} alternativas.`);
  L.push('- CLAUDE.md fala em "506 itens" no gantt: são 506 registros no `docs/gantt.html` = 418 linhas da CSV + 83 itens só do gantt (S0, W7–W9, GA) + 5 variantes com ID repetido (RC2.1–RC2.5). IDs únicos: 501.',
    '- `docs/CANONICAL_ROADMAP_COMPLETE.md` v1.4.0 acrescenta W10–W13 (22 itens) que não estão nem na CSV nem no gantt.html.',
    '- `docs/CANONICAL_PHASE_TABLE.csv` e `docs/CANONICAL_ROADMAP_TABLE.csv` têm o mesmo conjunto de 418 IDs (conferido).',
    '- Os D1–D5 do pacote 20261008 e os D1–D9 das runs H1 de 13/10 usam os mesmos rótulos para temas diferentes; aqui viram `PKG-D*` e `H1-D*`.', '');
  L.push('## 7. Convenção de IDs', '',
    '- `OTK-Dxx-Fyy-Szz-Www`: WP real do pacote 20261008 (não inventado).',
    '- `OTK-STOPGATE01-P1..P7`: pacotes do charter desta run.',
    '- `H1S-Sxx`: tarefas S01–S24 da run H1 de 13/10 (`02_S01_S24_STATUS.json`).',
    '- `H1R2-<id>`: achados/decisões abertos da H1 Final Closure R2 sem WP correspondente; o ID original fica em `LEGACY_IDS`.',
    '- `LEG-<id>`: registro legado (CSV, gantt.html ou CRC Parte 9).',
    '- `SG-*`: dimensões separadas do stop-gate H1 (lista de gates).', '');
  L.push('## 8. Privacidade e método de importação', '',
    '- O pacote 20261008 não está em git. Foram importados só campos estruturados; caminhos para a área privada de extratos foram omitidos das evidências importadas; nenhum conteúdo de `OTK_PRIVATE_EVIDENCE` foi lido ou copiado.',
    '- O JSON foi construído uma única vez por `docs/governance/bootstrap/import_master_roadmap_bootstrap.mjs` (registro do método; não reexecutar sobre o JSON mantido). Daqui em diante o JSON é editado diretamente e as saídas são regeneradas.', '');
  return L.join('\n') + '\n';
}

function laneItems(A, h) { return A.items.filter((i) => i.HORIZON === h && !isLegacy(i)).sort((a, b) => (A.level.get(a.ID) - A.level.get(b.ID)) || cmp(a.ID, b.ID)); }

function renderGanttMd(rm, A) {
  const L = [];
  L.push('# OTK: Gantt mestre atual (ordem por dependências)', '', GEN_NOTE('Gantt'), '');
  L.push(`Data de referência: ${rm.as_of}. Versão visual: \`docs/gantt_current.html\`.`, '',
    '- Não há datas inventadas. "Nível" é a profundidade na cadeia de predecessores (0 = sem predecessor); itens do mesmo nível podem correr em paralelo se os recursos (`PARALLEL_RESOURCE_LOCK`) permitirem.',
    '- Cronograma: `REAL` só quando a evidência registra a data; `PROPOSTO` só quando há proposta explícita; senão `TBD`.',
    '- Registros legados `LEG-*` não entram nas raias (ver contagens no fim).', '');
  L.push('## Marcos', '', '| Nível | Marco | Horizonte | Status | Depende de |', '|---:|---|---|---|---|');
  for (const id of A.msTopo) { const m = A.msById.get(id); L.push(`| ${A.msLevel.get(id)} | ${m.ID}: ${esc(m.NAME)} | ${m.HORIZON} | ${m.STATUS} | ${list(m.DEPENDENCIES)} |`); }
  L.push('');
  const crit = new Set(A.criticalItems);
  for (const h of HORIZONS) {
    const rows = laneItems(A, h);
    if (!rows.length) continue;
    L.push(`## Raia ${h} (${rows.length})`, '', '| Nível | ID | Título | Status | Marco | Cronograma | Crítico |', '|---:|---|---|---|---|---|---|');
    for (const i of rows) L.push(`| ${A.level.get(i.ID)} | \`${i.ID}\` | ${esc(short(i.TITLE, 80))} | ${i.STATUS} | ${i.MILESTONE || 'n/a'} | ${sched(i)} | ${crit.has(i.ID) ? 'sim' : ''} |`);
    L.push('');
  }
  const LS = A.legacyStats;
  L.push('## Registros legados (fora das raias)', '', `${LS.recovered} registros: ${Object.entries(LS.by_status).sort().map(([k, v]) => `${k} ${v}`).join('; ')}. Nenhum tem data real.`, '');
  return L.join('\n') + '\n';
}

function renderGraphMd(rm, A) {
  const L = [];
  const mid = (id) => id.replace(/[^A-Za-z0-9]/g, '_');
  L.push('# OTK: Grafo de dependências atual', '', GEN_NOTE('Grafo'), '');
  L.push(`Data de referência: ${rm.as_of}.`, '');
  L.push('## 1. Marcos', '', '```mermaid', 'flowchart LR');
  for (const id of A.msTopo) { const m = A.msById.get(id); L.push(`  ${mid(id)}["${m.ID}<br/>${m.NAME.replace(/"/g, "'")}<br/>${m.STATUS}"]`); }
  for (const id of A.msTopo) for (const d of A.msById.get(id).DEPENDENCIES) L.push(`  ${mid(d)} --> ${mid(id)}`);
  L.push('```', '', 'Nenhum marco M2/M3/H3 aparece antes de um marco H1 (validado).', '');
  L.push('## 2. Caminho crítico H1 (itens abertos)', '');
  const crit = A.criticalItems;
  if (crit.length) {
    L.push('```mermaid', 'flowchart TD');
    crit.forEach((id, k) => { const i = A.byId.get(id); L.push(`  c${k}["${id}<br/>${short(i.TITLE, 60).replace(/"/g, "'")}<br/>${i.STATUS}"]`); });
    for (let k = 1; k < crit.length; k++) L.push(`  c${k - 1} --> c${k}`);
    L.push(`  c${crit.length - 1} --> END["MS-H1-DEFENSE"]`, '```', '');
  }
  L.push('## 3. Arestas entre marcos induzidas por itens', '', 'Quantas arestas item → item ligam itens de marcos diferentes (predecessor no marco da linha, sucessor no marco da coluna).', '');
  const cross = new Map();
  for (const i of A.items) for (const p of i.PREDECESSORS) { const q = A.byId.get(p); const a = q.MILESTONE || '(sem marco)'; const b = i.MILESTONE || '(sem marco)'; if (a === b) continue; const k = `${a} → ${b}`; cross.set(k, (cross.get(k) || 0) + 1); }
  L.push('| De → Para | Arestas |', '|---|---:|');
  for (const [k, v] of [...cross.entries()].sort()) L.push(`| ${k} | ${v} |`);
  L.push('', '## 4. Predecessores abertos dos itens H1 abertos', '', '| Item | Status | Predecessores abertos |', '|---|---|---|');
  for (const i of A.items.filter((x) => H1_HZ.has(x.HORIZON) && !CLOSED.has(x.STATUS))) {
    const po = i.PREDECESSORS.filter((p) => !CLOSED.has(A.byId.get(p).STATUS));
    if (po.length) L.push(`| \`${i.ID}\` | ${i.STATUS} | ${po.join(', ')} |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}

function renderHtml(rm, A) {
  const crit = new Set(A.criticalItems);
  const data = A.items.map((i) => ({
    i: i.ID, t: i.TITLE, h: i.HORIZON, s: i.STATUS, m: i.MILESTONE, l: A.level.get(i.ID), c: crit.has(i.ID) ? 1 : 0, g: isLegacy(i) ? 1 : 0,
    as: i.ACTUAL_START, af: i.ACTUAL_FINISH, ps: i.PROPOSED_START, pf: i.PROPOSED_FINISH, p: i.PREDECESSORS, f: i.SUCCESSORS,
    d: i.HUMAN_DECISION, e: i.EVIDENCE, es: i.EVIDENCE_SHA, n: i.NEXT_ACTION, pr: i.PRIORITY, gt: i.GATE, lg: i.LEGACY_IDS, o: i.ORIGIN_SOURCE,
  }));
  const ms = A.msTopo.map((id) => { const m = A.msById.get(id); return { i: m.ID, n: m.NAME, h: m.HORIZON, s: m.STATUS, d: m.DEPENDENCIES, l: A.msLevel.get(id), dod: m.DOD }; });
  const payload = JSON.stringify({ asOf: rm.as_of, base: rm.base_sha_full, items: data, ms, crit: A.criticalItems, horizons: HORIZONS }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gantt OTK atual</title>
<meta name="description" content="Gantt do roadmap mestre OTK gerado do JSON autoritativo (ordem por dependências, sem datas inventadas).">
<style>
:root{--bg:#f7f7f5;--panel:#ffffff;--ink:#1d1d1b;--muted:#5f5f5a;--line:#d9d8d2;--accent:#3355cc;
--done:#2f7d5b;--done-bg:#e3f2ea;--open:#335a99;--open-bg:#e6edf8;--blocked:#a3461c;--blocked-bg:#fbe9df;--closed:#77756f;--closed-bg:#ecebe7;--crit:#b0228a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--panel:#1f1f1d;--ink:#ecebe6;--muted:#a5a39b;--line:#3a3935;--accent:#8aa2ff;
--done:#7cd3a9;--done-bg:#1d3a2d;--open:#9ab8ec;--open-bg:#1d2a40;--blocked:#f0a47c;--blocked-bg:#43261a;--closed:#a8a69f;--closed-bg:#2a2a27;--crit:#f07ad6}}
:root[data-theme="dark"]{--bg:#161615;--panel:#1f1f1d;--ink:#ecebe6;--muted:#a5a39b;--line:#3a3935;--accent:#8aa2ff;
--done:#7cd3a9;--done-bg:#1d3a2d;--open:#9ab8ec;--open-bg:#1d2a40;--blocked:#f0a47c;--blocked-bg:#43261a;--closed:#a8a69f;--closed-bg:#2a2a27;--crit:#f07ad6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main{max-width:1400px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:20px 0 8px}
.meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.bar label{font-size:13px;color:var(--muted);display:flex;gap:4px;align-items:center}
input[type=search],select{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit;max-width:100%}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted)}
.chip{display:inline-block;border-radius:6px;padding:4px 6px;margin:0 0 6px;width:170px;font-size:11.5px;line-height:1.3;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);text-align:left}
.chip b{display:block;font-weight:600;font-size:11px;overflow-wrap:anywhere}
.chip span{display:block;color:var(--muted)}
.chip.done{background:var(--done-bg);border-color:var(--done)}
.chip.open{background:var(--open-bg);border-color:var(--open)}
.chip.blocked{background:var(--blocked-bg);border-color:var(--blocked)}
.chip.closed{background:var(--closed-bg);border-color:var(--closed);opacity:.85}
.chip.actual{border-style:solid;border-width:2px}
.chip.proposed{border-style:dashed;border-width:2px}
.chip.tbd{border-style:dotted;border-width:2px}
.chip.crit{outline:3px solid var(--crit);outline-offset:1px}
.lane{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:8px}
.lane h3{font-size:14px;margin:0 0 6px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.grid{display:flex;gap:8px;align-items:flex-start;min-width:min-content}
.col{flex:0 0 auto;width:178px}
.col .hd{font-size:11px;color:var(--muted);border-bottom:1px solid var(--line);margin-bottom:6px;padding-bottom:2px}
.mss{display:flex;gap:8px;flex-wrap:nowrap}
.ms{flex:0 0 auto;width:200px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12px}
.ms b{display:block}
#detail{position:sticky;bottom:0;background:var(--panel);border-top:2px solid var(--accent);padding:12px 16px;max-height:45vh;overflow:auto;display:none}
#detail dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;font-size:12.5px}
#detail dt{color:var(--muted)}#detail dd{margin:0;overflow-wrap:anywhere}
button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 9px;font:inherit;cursor:pointer}
.sw{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:middle;margin-right:3px;border:2px solid}
</style>
</head>
<body>
<header>
<h1>Gantt OTK atual</h1>
<div class="meta" id="meta"></div>
<p class="meta">Gerado por scripts/ops/generate_master_roadmap.mjs a partir de docs/governance/OTK_MASTER_ROADMAP_CURRENT.json. Colunas = nível de dependência (0 = sem predecessor), não datas. Nenhuma data inventada.</p>
<div class="legend">
<span><i class="sw" style="background:var(--done-bg);border-color:var(--done)"></i>concluído / com limitação</span>
<span><i class="sw" style="background:var(--open-bg);border-color:var(--open)"></i>aberto</span>
<span><i class="sw" style="background:var(--blocked-bg);border-color:var(--blocked)"></i>bloqueado</span>
<span><i class="sw" style="background:var(--closed-bg);border-color:var(--closed)"></i>superado / excluído</span>
<span><i class="sw" style="border-style:solid;border-color:var(--ink)"></i>borda contínua: data REAL</span>
<span><i class="sw" style="border-style:dashed;border-color:var(--ink)"></i>tracejada: PROPOSTA</span>
<span><i class="sw" style="border-style:dotted;border-color:var(--ink)"></i>pontilhada: TBD</span>
<span><i class="sw" style="outline:2px solid var(--crit);border-color:transparent"></i>caminho crítico H1</span>
</div>
<div class="bar">
<input type="search" id="q" placeholder="Buscar ID ou título" aria-label="Buscar">
<label>Status <select id="fs"><option value="">todos</option></select></label>
<label>Marco <select id="fm"><option value="">todos</option></select></label>
<label><input type="checkbox" id="fl"> mostrar legado (LEG-*)</label>
<label><input type="checkbox" id="fc"> só caminho crítico</label>
<button id="theme" type="button">tema</button>
</div>
</header>
<main>
<h2>Marcos (ordem de dependência)</h2>
<div class="scroll"><div class="mss" id="mss"></div></div>
<h2>Raias por horizonte</h2>
<div id="lanes"></div>
</main>
<div id="detail" role="region" aria-label="Detalhe do item"></div>
<script>
const D=${payload};
const $=s=>document.querySelector(s);
const cat=s=>s==="VERIFIED_COMPLETE"||s==="IMPLEMENTED_WITH_LIMITATION"?"done":s==="SUPERSEDED_WITH_EVIDENCE"||s==="EXCLUDED_WITH_REASON"?"closed":(s.indexOf("BLOCKED")===0||s==="SOURCE_NOT_AVAILABLE")?"blocked":"open";
const sch=x=>(x.as||x.af)?"actual":((x.ps&&x.ps!=="TBD")||(x.pf&&x.pf!=="TBD"))?"proposed":"tbd";
const schTxt=x=>{const k=sch(x);return k==="actual"?"real "+(x.as||"?")+" → "+(x.af||"em curso"):k==="proposed"?"proposto "+(x.ps||"TBD")+" → "+(x.pf||"TBD"):"TBD";};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
$("#meta").textContent="as_of "+D.asOf+" · base "+D.base+" · "+D.items.length+" itens · caminho crítico H1: "+D.crit.length+" itens abertos";
[...new Set(D.items.map(x=>x.s))].sort().forEach(s=>{const o=document.createElement("option");o.value=s;o.textContent=s;$("#fs").appendChild(o);});
D.ms.forEach(m=>{const o=document.createElement("option");o.value=m.i;o.textContent=m.i;$("#fm").appendChild(o);});
$("#mss").innerHTML=D.ms.map(m=>'<div class="ms"><b>'+esc(m.i)+'</b>'+esc(m.n)+'<br><span class="meta">nível '+m.l+' · '+esc(m.h)+' · '+esc(m.s)+'<br>depende de: '+esc(m.d.join(", ")||"n/a")+'</span></div>').join("");
function render(){
 const q=$("#q").value.trim().toLowerCase(),fs=$("#fs").value,fm=$("#fm").value,fl=$("#fl").checked,fc=$("#fc").checked;
 const vis=D.items.filter(x=>(fl||!x.g)&&(!fs||x.s===fs)&&(!fm||x.m===fm)&&(!fc||x.c)&&(!q||x.i.toLowerCase().includes(q)||x.t.toLowerCase().includes(q)));
 let html="";
 D.horizons.forEach(h=>{
  const xs=vis.filter(x=>x.h===h); if(!xs.length) return;
  const lv=[...new Set(xs.map(x=>x.l))].sort((a,b)=>a-b);
  html+='<section class="lane"><h3>'+esc(h)+' · '+xs.length+' itens</h3><div class="scroll"><div class="grid">';
  lv.forEach(l=>{
   const cs=xs.filter(x=>x.l===l).sort((a,b)=>b.c-a.c||(a.i<b.i?-1:1));
   html+='<div class="col"><div class="hd">nível '+l+' ('+cs.length+')</div>'+cs.map(x=>'<button type="button" class="chip '+cat(x.s)+' '+sch(x)+(x.c?' crit':'')+'" data-id="'+esc(x.i)+'"><b>'+esc(x.i)+'</b>'+esc(x.t.length>90?x.t.slice(0,89)+"…":x.t)+'<span>'+esc(x.s)+' · '+esc(schTxt(x))+'</span></button>').join("")+'</div>';
  });
  html+='</div></div></section>';
 });
 $("#lanes").innerHTML=html||'<p class="meta">Nenhum item com estes filtros.</p>';
}
const byId=new Map(D.items.map(x=>[x.i,x]));
document.addEventListener("click",ev=>{const b=ev.target.closest(".chip");if(!b)return;const x=byId.get(b.dataset.id);
 const rows=[["ID",x.i],["Título",x.t],["Horizonte",x.h],["Marco",x.m],["Status",x.s],["Prioridade",x.pr],["Gate",x.gt],["Cronograma",schTxt(x)],["Predecessores",(x.p||[]).join(", ")],["Sucessores",(x.f||[]).join(", ")],["Decisão humana",(x.d||[]).join(", ")],["Evidência",x.e],["SHA da evidência",x.es],["IDs legados",(x.lg||[]).join(", ")],["Origem",x.o],["Próxima ação",x.n]];
 const d=$("#detail");d.style.display="block";d.innerHTML='<button type="button" id="close" style="float:right">fechar</button><dl>'+rows.map(r=>'<dt>'+esc(r[0])+'</dt><dd>'+esc(r[1]||"n/a")+'</dd>').join("")+'</dl>';
 $("#close").onclick=()=>{d.style.display="none";};});
["#q","#fs","#fm","#fl","#fc"].forEach(s=>$(s).addEventListener("input",render));
$("#theme").onclick=()=>{const r=document.documentElement;const cur=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");r.setAttribute("data-theme",cur==="dark"?"light":"dark");};
render();
</script>
</body>
</html>
`;
}

/**
 * Renders every output file in memory.
 *
 * @param rm - Parsed roadmap.
 * @returns Map from repo-relative output path to its full text content (LF line endings); nothing is written.
 */
export function generateAll(rm) {
  const A = analyze(rm);
  return new Map([
    ['docs/governance/OTK_MASTER_ROADMAP_CURRENT.md', renderRoadmapMd(rm, A)],
    ['docs/governance/OTK_DECISION_REGISTER_CURRENT.md', renderDecisionsMd(rm, A)],
    ['docs/governance/OTK_ROADMAP_PROVENANCE.md', renderProvenanceMd(rm, A)],
    ['docs/governance/OTK_MASTER_GANTT_CURRENT.md', renderGanttMd(rm, A)],
    ['docs/governance/OTK_DEPENDENCY_GRAPH_CURRENT.md', renderGraphMd(rm, A)],
    ['docs/gantt_current.html', renderHtml(rm, A)],
  ]);
}

/**
 * Compares the committed output files with a fresh in-memory generation, ignoring CRLF/LF differences.
 *
 * @param rm - Parsed roadmap.
 * @param root - Repository root; defaults to {@link ROOT}.
 * @returns One message per missing or outdated file; empty when everything is up to date.
 */
export function checkOutputsUpToDate(rm, root = ROOT) {
  const out = []; const gen = generateAll(rm);
  for (const [rel, content] of gen) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { out.push(`saída ausente: ${rel}`); continue; }
    // line endings normalised: a Windows checkout (core.autocrlf=true, .gitattributes text=auto) has CRLF on disk while
    // the repository and the generator use LF; only the content counts
    const onDisk = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== content.replace(/\r\n/g, '\n')) out.push(`saída desatualizada (regenerar): ${rel}`);
  }
  return out;
}

/**
 * Generates the outputs twice from deep copies of the roadmap and lists the files whose text differs.
 *
 * @param rm - Parsed roadmap (not modified).
 * @returns Paths of the non-deterministic outputs; empty when both runs are identical.
 */
export function checkDeterminism(rm) {
  const a = generateAll(JSON.parse(JSON.stringify(rm))); const b = generateAll(JSON.parse(JSON.stringify(rm)));
  const diff = [];
  for (const [k, v] of a) if (b.get(k) !== v) diff.push(k);
  return diff;
}

function gitShaCheck(rm, root) {
  const shas = new Set();
  for (const i of rm.items) { if (/^[0-9a-f]{40}$/.test(i.EVIDENCE_SHA || '')) shas.add(i.EVIDENCE_SHA); if (/^[0-9a-f]{40}$/.test(i.SOURCE_COMMIT || '')) shas.add(i.SOURCE_COMMIT); }
  for (const g of rm.gates) if (g.CURRENT_EVIDENCE_SHA) shas.add(g.CURRENT_EVIDENCE_SHA);
  for (const m of rm.milestones) if (m.EVIDENCE_SHA) shas.add(m.EVIDENCE_SHA);
  shas.add(rm.base_sha_full);
  const input = [...shas].sort().map((s) => s + '^{commit}').join('\n') + '\n';
  const res = execFileSync('git', ['-C', root, 'cat-file', '--batch-check'], { input, encoding: 'utf8' });
  return res.split('\n').filter((l) => /missing/.test(l)).map((l) => `SHA inexistente no git: ${l}`);
}

function main() {
  const check = process.argv.includes('--check');
  const rm = load();
  const v = validate(rm);
  const errors = [...v.errors];
  if (check) {
    try { errors.push(...gitShaCheck(rm, ROOT)); } catch (e) { errors.push('falha ao conferir SHAs no git: ' + e.message); }
    const det = checkDeterminism(rm);
    if (det.length) errors.push('não determinístico: ' + det.join(', '));
    errors.push(...checkOutputsUpToDate(rm));
  }
  const s = v.stats;
  console.log(`itens: ${s.items} · legado recuperado ${s.legacy.recovered}, reconciliado ${s.legacy.reconciled_explicit_mapping}, sem verificação item a item ${s.legacy.lacking_item_verification}`);
  console.log(`SOURCE_NOT_AVAILABLE: ${s.source_not_available.join(', ') || 'n/a'}`);
  console.log(`caminho crítico H1 (${s.critical_path.length}): ${s.critical_path.join(' → ')}`);
  if (v.warnings.length) { console.log(`avisos (${v.warnings.length}):`); for (const w of v.warnings) console.log('  - ' + w); }
  if (errors.length) { console.error(`ERROS (${errors.length}):`); for (const e of errors) console.error('  - ' + e); process.exit(1); }
  if (check) { console.log('CHECK OK: validação, SHAs no git, determinismo e saídas em dia.'); return; }
  for (const [rel, content] of generateAll(rm)) fs.writeFileSync(path.join(ROOT, rel), content);
  console.log(`gerado: ${OUTPUT_FILES.length} arquivos.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
