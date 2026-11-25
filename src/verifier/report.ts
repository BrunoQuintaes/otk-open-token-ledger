/**
 * Serialização determinística do relatório (JSON e CSV) e saída para humanos do comando.
 * O JSON é JSON.stringify com 2 espaços + "\n": a ordem das chaves é a da construção em core.ts,
 * igual no Node e no navegador. sha256 sobre os bytes UTF-8 desse texto.
 *
 * (English) Deterministic serialization of the verification report (JSON and CSV) and the human-readable
 * output of the command; the visible texts are in Portuguese.
 *
 * @module src/verifier/report
 */
import { ethers } from 'ethers';
import { NAO_GARANTE, TEXTOS, VERDICT_LABEL } from './textos.js';
import type { VerificationReport } from './types.js';

/**
 * Serializes a report as JSON indented with 2 spaces plus a final newline.
 *
 * @param r - Report to serialize.
 * @returns The JSON text.
 */
export function serializeReport(r: VerificationReport): string {
  return JSON.stringify(r, null, 2) + '\n';
}

/**
 * SHA-256 of the UTF-8 bytes of {@link serializeReport}.
 *
 * @param r - Report.
 * @returns Lowercase hex digest without `0x`.
 */
export function reportSha256(r: VerificationReport): string {
  return ethers.sha256(ethers.toUtf8Bytes(serializeReport(r))).slice(2);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // evita fórmula em planilha (=, +, -, @) e escapa aspas
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV para planilha (separador ";" — padrão do Excel em português; "\r\n"; BOM fica a cargo de quem grava).
 *
 * @param r - Report.
 * @returns CSV text (header and one row per item); cells that start like a formula are prefixed with `'`.
 */
export function reportToCsv(r: VerificationReport): string {
  const head = ['id', 'tipo', 'arquivo', 'linha', 'veredito', 'codigo', 'o_que_aconteceu', 'data', 'provedor', 'modelo', 'tokens', 'cu', 'chave', 'assinado_em', 'somado', 'avisos'];
  const rows = r.items.map((it) => [
    it.id, it.kind, it.source.file, it.source.line, VERDICT_LABEL[it.verdict].pt, it.code, it.reasonPt,
    it.facts?.admittedAt ?? '', it.facts?.provider ?? '', it.facts ? (it.facts.modelReturned ?? it.facts.modelRequested ?? '') : '',
    it.facts ? it.facts.tokens.map((t) => `${t.name}=${t.count ?? '?'}`).join(' ') : '',
    it.facts?.cu ? `${it.facts.cu.units}/${it.facts.cu.scale}` : '',
    it.keyId ?? '', it.signedAt ?? '', it.counted ? 'sim' : 'não',
    it.warnings.map((w) => w.code).join(' '),
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/**
 * Saída para humanos do `otk verify` (sem cores; o comando pinta se o terminal suportar).
 *
 * @param r - Report.
 * @returns Plain multi-line text (Portuguese).
 */
export function renderHuman(r: VerificationReport): string {
  const out: string[] = [];
  out.push('Verificador de recibos OTK ' + r.verifierVersion);
  const k = r.keyring;
  if (k.convertedFrom) out.push(`Chaveiro: ${k.name} é o anel público do bot; foi lido por conversão, sem perder nenhuma chave.`);
  if (k.anchor === 'anchored') out.push(`Chaveiro: ${k.name} — impressão digital confere (${k.fingerprint}).`);
  else if (k.anchor === 'not_anchored') out.push(`Chaveiro: ${k.name} — NÃO ancorado (impressão digital ${k.fingerprint}; use --fingerprint com a publicada pelo operador).`);
  else if (k.anchor === 'mismatch') out.push(`Chaveiro: ${k.name} — a impressão digital digitada NÃO confere (calculada ${k.fingerprint}).`);
  else if (k.anchor === 'invalid') out.push(`Chaveiro: ${k.name} — inválido: ${k.error}`);
  else if (k.anchor === 'unknown_format') out.push(`Chaveiro: ${k.name} — ${k.error}. Escolha o chaveiro que o operador entregou.`);
  else out.push('Chaveiro: nenhum.');
  out.push('');
  for (const it of r.items) {
    const lbl = VERDICT_LABEL[it.verdict].cli;
    const where = it.source.file ? ` (${it.source.file}${it.source.line ? `:${it.source.line}` : ''})` : '';
    out.push(`${lbl} ${it.id}${where} — ${TEXTOS[it.code].short}. ${it.reasonPt}${it.detail ? ` [${it.detail}]` : ''}`);
    if (it.verdict !== 'verde') out.push(`        Significa: ${it.meaningPt}`);
    for (const w of it.warnings) out.push(`        + ${VERDICT_LABEL[w.verdict].cli} ${w.textPt}`);
  }
  const s = r.summary;
  out.push('');
  out.push('Resumo');
  out.push(`  Itens: ${s.total.verde} verde(s), ${s.total.amarelo} amarelo(s), ${s.total.vermelho} vermelho(s).`);
  out.push(`  Recibos: ${s.receipts.verde} verde(s), ${s.receipts.amarelo} amarelo(s), ${s.receipts.vermelho} vermelho(s); somados: ${s.counted.counted}.`);
  out.push(`  Tokens somados (só recibos com assinatura conferida, verdes e amarelos): ${s.counted.tokens.map((t) => `${t.name}=${t.sum ?? 'desconhecido'}${t.sum !== null && t.unknown ? ` (+${t.unknown} recibo(s) sem valor)` : ''}`).join(', ') || '—'}`);
  // sem nenhum recibo somado não há CU a mostrar: "desconhecida", nunca "0" (o JSON mantém a soma vazia)
  out.push(`  CU somado: ${s.counted.counted === 0 ? 'desconhecida (nenhum recibo somado)' : (s.counted.cu.sum ?? 'desconhecida')}${s.counted.cu.unknown ? ` (${s.counted.cu.unknown} recibo(s) sem CU)` : ''}`);
  for (const g of s.byMonth) out.push(`  Mês ${g.key}: ${g.verde}/${g.amarelo}/${g.vermelho} (verde/amarelo/vermelho), CU ${g.cu.sum ?? 'desconhecido'}`);
  for (const g of s.byProviderModel) out.push(`  ${g.key}: ${g.verde}/${g.amarelo}/${g.vermelho}, CU ${g.cu.sum ?? 'desconhecido'}`);
  if (s.redItems.length) out.push(`  Vermelhos (fora das somas): ${s.redItems.join(', ')}`);
  out.push('');
  out.push('O que isto NÃO garante');
  for (const n of NAO_GARANTE) out.push(`  - ${n}`);
  out.push('');
  out.push(`Resultado: ${VERDICT_LABEL[r.overall].cli} (código de saída ${r.exitCode})`);
  return out.join('\n') + '\n';
}
