/**
 * Serialization of a ReconciliationReport: canonical JSON (bigint as strings, stable order, no clock)
 * plus a Markdown table OTK | PROVIDER | ABS_DIFF | REL_DIFF | EXPLANATION. Same input → same bytes.
 *
 * @module reconciliation/report
 */
import { createHash } from 'node:crypto';
import type { Comparison, ReconciliationReport } from './types.js';

/**
 * Serializes a report as indented JSON (bigints as decimal strings) with a final newline.
 *
 * @param report - Report to serialize; key order follows the object as built by the matcher.
 * @returns The JSON text.
 */
export function reportJson(report: ReconciliationReport): string {
  return `${JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v), 2)}\n`;
}

/**
 * SHA-256 of a serialized report.
 *
 * @param json - Text from {@link reportJson}.
 * @returns Lowercase hex digest (64 characters, no `0x`).
 */
export function reportDigest(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

const cell = (s: string | null | undefined): string => (s === null || s === undefined || s === '' ? '-' : s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
const unit = (c: Comparison): string => (c.metric === 'tokens' ? 'tokens' : (c.currency ?? '?'));

/**
 * Renders a report as a Markdown document for people (its headings and labels are in Portuguese).
 *
 * @param report - Report to render.
 * @param jsonDigest - Digest of the JSON form, printed in the document so both can be tied together.
 * @returns The Markdown text.
 */
export function reportMarkdown(report: ReconciliationReport, jsonDigest: string): string {
  const out: string[] = [];
  const origin = report.providerDataOrigin === 'REAL'
    ? '**Dados do provedor: REAL** (arquivo exportado pelo provedor; ver digests abaixo).'
    : '**Dados do provedor: FIXTURE (SINTÉTICO).** Este relatório testa o pipeline; não prova nada sobre a cobrança real do provedor.';
  out.push(`# Conciliação OTK x ${report.provider}`);
  out.push('');
  out.push(origin);
  if (report.otkSource.kind.includes('fixture')) out.push('', '**Lado OTK: SINTÉTICO** (registros de fixture, não medidos).');
  out.push('');
  out.push(`- Janela: [${report.window.start}, ${report.window.end}) (fuso para dias sem período do provedor: ${report.window.timezone}); tenant: ${report.window.tenantId ?? '-'}`);
  out.push(`- Lado OTK: ${report.otkSource.description}; ${report.otkSource.recordCount} operação(ões) na janela; sha256: ${report.otkSource.digests.join(', ')}`);
  out.push(`- Nível de agregação: ${report.aggregationLevel}. ${report.aggregationNote}`);
  out.push(`- Política de arredondamento: ${report.roundingPolicy}; tabela de aliases: ${report.aliasTable}; tolerância de borda de período: ${report.timingToleranceMs} ms`);
  out.push(`- Tabelas de preço carregadas: ${report.priceTables.join(', ') || '(nenhuma)'}`);
  out.push(`- sha256 do JSON deste relatório: ${jsonDigest}`);
  out.push('');
  out.push('## Arquivos do provedor');
  out.push('');
  out.push('| Mapeamento | Proveniência do mapeamento | Origem | Marcador sintético | Linhas | Período | sha256 |');
  out.push('|---|---|---|---|---|---|---|');
  for (const s of report.statements) out.push(`| ${cell(s.mappingId)} | ${s.provenance} | ${s.origin} | ${cell(s.syntheticMarker)} | ${s.lineCount} | ${s.period.start} a ${s.period.end} | ${s.sourceDigest} |`);
  out.push('');
  out.push('## Totais');
  out.push('');
  const t = report.totals;
  out.push(`- Uso (sem impostos, créditos e ajustes): OTK ${cell(t.usage?.otk)} x provedor ${cell(t.usage?.provider)} ${cell(t.currency)}; ABS_DIFF ${cell(t.usage?.absDiff)}; REL_DIFF ${cell(t.usage?.relDiff)}`);
  out.push(`- Impostos do provedor: ${cell(t.providerTax)}; créditos: ${cell(t.providerCredits)}; ajustes: ${cell(t.providerAdjustments)}; líquido do provedor (linhas no escopo): ${cell(t.providerNet)}`);
  out.push(`- Contagem por classificação (linhas de categoria, requisição, linha do provedor e registro OTK): ${Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || 'nenhuma'}`);
  out.push('');
  out.push('## Resultados');
  out.push('');
  out.push('| Nível | Modelo | Período | Categoria | Classificação | Unidade | OTK | PROVIDER | ABS_DIFF | REL_DIFF | EXPLANATION |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    const period = r.key.periodStart ? `${r.key.periodStart} a ${r.key.periodEnd}` : '-';
    const cmps = [r.quantity, r.amount].filter((c): c is Comparison => c !== null);
    if (cmps.length === 0) {
      out.push(`| ${r.level} | ${cell(r.key.model)} | ${period} | ${cell(r.key.category)} | ${r.classification} | - | - | - | - | - | ${cell(r.explanation)} |`);
      continue;
    }
    cmps.forEach((c, i) => {
      const rel = c.relDiff ?? (c.relDiffNote ? `n/a (${c.relDiffNote})` : '-');
      out.push(`| ${r.level} | ${cell(r.key.model)} | ${period} | ${cell(r.key.category)} | ${r.classification} | ${unit(c)} | ${cell(c.otk)} | ${cell(c.provider)} | ${cell(c.absDiff)} | ${cell(rel)} | ${i === 0 ? cell(r.explanation) : '(mesma linha)'} |`);
    });
  }
  if (report.adjustments.length > 0) {
    out.push('');
    out.push('## Impostos, créditos e ajustes (separados do uso)');
    out.push('');
    out.push('| Linha | Tipo | Valor | Moeda | Descrição |');
    out.push('|---|---|---|---|---|');
    for (const a of report.adjustments) out.push(`| ${a.lineId} | ${a.kind} | ${cell(a.amount)} | ${cell(a.currency)} | ${cell(a.description)} |`);
  }
  if (report.outOfScope.length > 0) {
    out.push('');
    out.push('## Linhas fora do escopo (mantidas, não conciliadas)');
    out.push('');
    out.push('| Linha | Valor | Moeda | Descrição |');
    out.push('|---|---|---|---|');
    for (const a of report.outOfScope) out.push(`| ${a.lineId} | ${cell(a.amount)} | ${cell(a.currency)} | ${cell(a.description)} |`);
  }
  if (report.excluded.length > 0) {
    out.push('');
    out.push('## Excluídos da comparação');
    out.push('');
    out.push('| Lado | Id | Motivo |');
    out.push('|---|---|---|');
    for (const x of report.excluded) out.push(`| ${x.side} | ${cell(x.id)} | ${cell(x.reason)} |`);
  }
  if (report.matches.length > 0) {
    out.push('');
    out.push('## Junções feitas (nunca por valor)');
    out.push('');
    out.push('| Grupo | Nível | Campos da junção | Linhas do provedor | Operações OTK |');
    out.push('|---|---|---|---|---|');
    for (const m of report.matches) out.push(`| ${cell(m.groupId)} | ${m.aggregationLevel} | ${m.joinedOn.join(', ')} | ${m.providerLineIds.length} | ${m.otkOperationIds.length} |`);
  }
  if (report.warnings.length > 0) {
    out.push('');
    out.push('## Avisos');
    out.push('');
    for (const w of report.warnings) out.push(`- ${cell(w)}`);
  }
  out.push('');
  return out.join('\n');
}
