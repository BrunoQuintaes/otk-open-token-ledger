/**
 * H2-EVAL / R13 — colisão de texto contra os corpora já usados (R09 R2 §1; achado K-02-A: 18 textos da CAL-02 repetiam textos da CAL-01).
 * Igualdade BYTE A BYTE (sha256 do UTF-8) do texto inteiro e do "corpo" (sem a 1ª linha de instrução), mais sobreposição de linhas longas
 * como informação. Função pura sobre listas de textos; a leitura dos corpora de referência está em refCorpora.ts.
 * Colisão exata => o gerador/pipeline deve regenerar ou excluir o texto; este módulo só detecta e relata (nada é "ajustado").
 */
import { sha256Hex } from './util.js';

export interface RefCorpus { name: string; source: string; fileSha256: string | 'UNKNOWN'; expectedCount: number | null; texts: Array<{ id: string; text: string }> }
export interface MyText { id: string; kind: 's1' | 'dialog_system' | 'dialog_turn'; text: string }

export interface CollisionReport {
  schema: 'otk.h2eval.text_collision_report.v1'; refs: Array<{ name: string; source: string; fileSha256: string; count: number; expectedCount: number | null; countMatchesExpected: boolean | null }>;
  mine: { texts: number; byKind: Record<string, number> };
  exactCollisions: Array<{ mine: string; ref: string; refId: string; on: 'text' | 'body' }>;
  lineOverlap: { minLineChars: number; textsWithOverlap: Array<{ mine: string; sharedLongLines: number }>; flagThresholdLines: number; totalSharedLongLines: number };
  verdict: 'NO_EXACT_COLLISION' | 'EXACT_COLLISION'; notes: string[];
}

/** corpo = texto sem a primeira linha (a instrução das tarefas do S1); para outros tipos, o próprio texto */
const bodyOf = (t: MyText): string => { if (t.kind !== 's1') return t.text; const i = t.text.indexOf('\n\n'); return i >= 0 ? t.text.slice(i + 2) : t.text; };

export function collisionReport(mine: readonly MyText[], refs: readonly RefCorpus[], opts: { minLineChars?: number; flagThresholdLines?: number } = {}): CollisionReport {
  const minLen = opts.minLineChars ?? 40; const thr = opts.flagThresholdLines ?? 3;
  const bySha = new Map<string, Array<{ ref: string; id: string }>>(); const refLines = new Map<string, Set<string>>();
  for (const r of refs) {
    const ls = new Set<string>();
    for (const t of r.texts) {
      const h = sha256Hex(t.text); const a = bySha.get(h) ?? []; a.push({ ref: r.name, id: t.id }); bySha.set(h, a);
      for (const line of t.text.split('\n')) { const l = line.trim(); if (l.length >= minLen) ls.add(l); }
    }
    refLines.set(r.name, ls);
  }
  const exact: CollisionReport['exactCollisions'] = []; const overlap: CollisionReport['lineOverlap']['textsWithOverlap'] = []; let total = 0;
  for (const m of mine) {
    for (const [on, s] of [['text', m.text], ['body', bodyOf(m)]] as const) for (const hit of bySha.get(sha256Hex(s)) ?? []) if (!exact.some((e) => e.mine === m.id && e.ref === hit.ref && e.refId === hit.id && e.on === on)) exact.push({ mine: m.id, ref: hit.ref, refId: hit.id, on });
    let shared = 0; const seen = new Set<string>();
    for (const line of m.text.split('\n')) { const l = line.trim(); if (l.length < minLen || seen.has(l)) continue; seen.add(l); if ([...refLines.values()].some((s) => s.has(l))) shared += 1; }
    if (shared > 0) { overlap.push({ mine: m.id, sharedLongLines: shared }); total += shared; }
  }
  const byKind: Record<string, number> = {}; for (const m of mine) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  return {
    schema: 'otk.h2eval.text_collision_report.v1',
    refs: refs.map((r) => ({ name: r.name, source: r.source, fileSha256: r.fileSha256, count: r.texts.length, expectedCount: r.expectedCount, countMatchesExpected: r.expectedCount === null ? null : r.expectedCount === r.texts.length })),
    mine: { texts: mine.length, byKind }, exactCollisions: exact,
    lineOverlap: { minLineChars: minLen, textsWithOverlap: overlap.filter((o) => o.sharedLongLines >= thr), flagThresholdLines: thr, totalSharedLongLines: total },
    verdict: exact.length ? 'EXACT_COLLISION' : 'NO_EXACT_COLLISION',
    notes: ['igualdade byte a byte do texto e do corpo (sem a instrução) contra cada texto de referência', 'sobreposição de linhas longas é informativa (limiar de sinalização configurável)', 'a ausência de colisão vale só para os corpora listados em `refs`'],
  };
}
