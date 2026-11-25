/**
 * H2-EVAL / R13 — colisão de texto contra os corpora já usados (R09 R2 §1; achado K-02-A: 18 textos da CAL-02 repetiam textos da CAL-01).
 * Igualdade BYTE A BYTE (sha256 do UTF-8) do texto inteiro e do "corpo" (sem a 1ª linha de instrução), mais sobreposição de linhas longas
 * como informação. Função pura sobre listas de textos; a leitura dos corpora de referência está em refCorpora.ts.
 * Colisão exata => o gerador/pipeline deve regenerar ou excluir o texto; este módulo só detecta e relata (nada é "ajustado").
 *
 * In English: pure text-collision check of a new corpus against corpora already used. Exact equality is byte-level
 * (SHA-256 of the UTF-8 text) on the whole text and on its body (S1 text without the first instruction paragraph);
 * shared long lines are reported as information only. Called by `corpus/build.ts`; re-exported by `cache/index.ts`.
 * It detects and reports only; it never edits or drops texts.
 *
 * @module scripts/h2eval/corpus/collision
 */
import { sha256Hex } from './util.js';

/**
 * One reference corpus already used by an earlier evaluation, loaded by `refCorpora.ts`.
 *
 * Fields: `name` label in the report; `source` where the texts were read from; `fileSha256` SHA-256 of the source
 * file or `'UNKNOWN'`; `expectedCount` expected number of texts (`null` = unknown); `texts` the texts with their ids.
 */
export interface RefCorpus { name: string; source: string; fileSha256: string | 'UNKNOWN'; expectedCount: number | null; texts: Array<{ id: string; text: string }> }
/**
 * One text of the new corpus to compare: an S1 prompt, a dialog system prefix or a dialog user turn.
 * `id` is the prompt id, or `<dialogId>/system` / `<dialogId>/turnN`; only `s1` texts have a separate body.
 */
export interface MyText { id: string; kind: 's1' | 'dialog_system' | 'dialog_turn'; text: string }

/** Report written as `text_collision_report.json`; `verdict` is `EXACT_COLLISION` when any exact match was found. */
export interface CollisionReport {
  schema: 'otk.h2eval.text_collision_report.v1'; refs: Array<{ name: string; source: string; fileSha256: string; count: number; expectedCount: number | null; countMatchesExpected: boolean | null }>;
  mine: { texts: number; byKind: Record<string, number> };
  exactCollisions: Array<{ mine: string; ref: string; refId: string; on: 'text' | 'body' }>;
  lineOverlap: { minLineChars: number; textsWithOverlap: Array<{ mine: string; sharedLongLines: number }>; flagThresholdLines: number; totalSharedLongLines: number };
  verdict: 'NO_EXACT_COLLISION' | 'EXACT_COLLISION'; notes: string[];
}

/**
 * corpo = texto sem a primeira linha (a instrução das tarefas do S1); para outros tipos, o próprio texto
 *
 * @param t - Text of the new corpus.
 * @returns For `s1`, the text after the first blank line (whole text if none); otherwise the text itself.
 */
const bodyOf = (t: MyText): string => { if (t.kind !== 's1') return t.text; const i = t.text.indexOf('\n\n'); return i >= 0 ? t.text.slice(i + 2) : t.text; };

/**
 * Compares every new text with every reference text and returns the collision report.
 *
 * @param mine - Texts of the new corpus (not mutated).
 * @param refs - Reference corpora already used (not mutated).
 * @param opts - `minLineChars`: shortest trimmed line, in characters, counted as a "long line" (default 40);
 *   `flagThresholdLines`: shared long lines a text needs to be listed in `lineOverlap.textsWithOverlap` (default 3).
 * @returns The report; `verdict` is `EXACT_COLLISION` when any text or body has the same SHA-256 as a reference text.
 */
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
