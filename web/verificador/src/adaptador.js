// Adaptador fino entre a página e o núcleo do VERIFICADOR_MVP (VERIFICADOR_WEB, C160).
// Não verifica nada por conta própria: entrega os bytes ao núcleo e serializa o relatório com a
// MESMA função que o comando usa (serializeReport), para o JSON baixado ser idêntico, byte a byte.
// 'otk-nucleo' é resolvido no build: src/verifier/index.ts do worktree (real) ou o simulado.
import * as nucleo from 'otk-nucleo';
import { sha256 } from 'ethers';
import { reservaPara } from './textos.js';

export const usandoSimulado = Object.prototype.hasOwnProperty.call(nucleo, 'SIMULADO');

/**
 * files: [{ path, bytes: Uint8Array }]  path = caminho relativo com "/" incluindo a pasta escolhida
 *        (igual ao webkitRelativePath e ao que o comando registra); arquivo solto = só o nome.
 * keyring: { path, bytes } ou null
 * fingerprint: texto colado pelo usuário, como veio (o núcleo normaliza e valida).
 */
export function verificar({ files, keyring, fingerprint }) {
  const fp = String(fingerprint ?? '').trim();
  const report = nucleo.verifyBundle(
    files.map((f) => ({ name: f.path, bytes: f.bytes })),
    keyring ? { name: keyring.path, bytes: keyring.bytes } : null,
    { fingerprint: fp === '' ? null : fp },
  );
  const json = nucleo.serializeReport(report);
  return {
    report, json,
    sha256: sha256(new TextEncoder().encode(json)).slice(2),
    csv: '﻿' + nucleo.reportToCsv(report),
    itens: report.items.map(vista),
  };
}

const VEREDITOS = ['verde', 'amarelo', 'vermelho'];

// Leitura de um item do relatório para a tela (nunca altera o relatório).
export function vista(it) {
  const res = reservaPara(it.code);
  const f = it.facts ?? null;
  return {
    id: String(it.id ?? ''),
    kind: it.kind ?? null,
    arquivo: it.source ? `${it.source.file}${it.source.line ? `:${it.source.line}` : ''}` : null,
    verdict: VEREDITOS.includes(it.verdict) ? it.verdict : 'vermelho',
    code: it.code ?? 'desconhecido',
    data: f?.admittedAt ?? null,
    provedor: f?.provider ?? null,
    modelo: f ? (f.modelReturned ?? f.modelRequested ?? null) : null,
    temFatos: !!f,
    tokens: f ? f.tokens : null,
    cu: f?.cu ? fracao(f.cu.units, f.cu.scale) : null,
    cuStatus: f?.cuStatus ?? null,
    reasonPt: it.reasonPt || res.reasonPt,
    meaningPt: it.meaningPt || res.meaningPt,
    notGuaranteedPt: it.notGuaranteedPt || res.notGuaranteedPt,
    detail: it.detail ?? null,
    signer: it.signer ?? null, keyId: it.keyId ?? null, signedAt: it.signedAt ?? null,
    digestRecomputed: it.digestRecomputed ?? null, digestDeclared: it.digestDeclared ?? null,
    counted: !!it.counted,
    avisos: (Array.isArray(it.warnings) ? it.warnings : []).map((w) => ({
      code: w.code, verdict: VEREDITOS.includes(w.verdict) ? w.verdict : 'amarelo', textPt: w.textPt || reservaPara(w.code).reasonPt,
    })),
  };
}

/** CU exato {units, scale} (texto decimal; valor = units / scale, scale potência de dez, common.ts)
 * → texto com vírgula, sem arredondar. Escala que não é potência de dez aparece como fração. */
export function fracao(units, scale) {
  const u = BigInt(units); const sc = BigInt(scale);
  if (sc <= 0n || !/^10*$/.test(sc.toString())) return `${u}/${sc}`;
  const s = sc.toString().length - 1;
  if (s === 0) return u.toString();
  const neg = u < 0n; const a = (neg ? -u : u).toString().padStart(s + 1, '0');
  return (neg ? '-' : '') + a.slice(0, a.length - s) + ',' + a.slice(a.length - s);
}
