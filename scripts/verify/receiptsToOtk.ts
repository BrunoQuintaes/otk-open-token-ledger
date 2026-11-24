/**
 * Conciliação a partir de recibos verificados (desenho §3(d), passo 7 da carta VERIFICADOR_MVP):
 * transforma SÓ os recibos verdes e amarelos (item.counted) em OtkRecord, com source
 * 'verified_receipt_v3'. Vermelhos, duplicatas e outros provedores vão para `excluded` com o motivo.
 *
 * O recibo v3 traz uma cotação de preço, não dinheiro confirmado: confirmedMoney fica null (nunca
 * um valor inventado) e a nota diz isso. A comparação de quantidades por categoria funciona normalmente.
 */
import { quantitiesFromNormalizedUsage, type OtkLoadResult } from '../../src/reconciliation/otkSource.js';
import type { OtkRecord, ReconProvider } from '../../src/reconciliation/types.js';
import { toJsonValue } from '../../src/operations/codec.js';
import { reportSha256, verifyBundleDetailed, type InputFile, type VerifyOptions } from '../../src/verifier/index.js';

export interface ReceiptsWindow { provider: ReconProvider; start: string; end: string; tenantId?: string | null }

export function loadOtkFromVerifiedReceipts(input: InputFile[], keyRing: InputFile, opts: VerifyOptions, w: ReceiptsWindow): OtkLoadResult & { verificationSha256: string; red: number } {
  const { report, receipts } = verifyBundleDetailed(input, keyRing, opts);
  const records: OtkRecord[] = [];
  const excluded: OtkLoadResult['excluded'] = [];
  let red = 0;
  report.items.forEach((it, i) => {
    if (it.kind !== 'receipt') return;
    if (it.verdict === 'vermelho') { red++; excluded.push({ id: it.id, reason: `recibo reprovado no verificador: ${it.code}` }); return; }
    if (!it.counted) {
      const has = (c: string) => it.code === c || it.warnings.some((x) => x.code === c);
      excluded.push({ id: it.id, reason: has('duplicate') ? 'cópia de recibo já contado' : has('not_in_totals') ? `assinatura não conferida (${it.code}): não entra nas somas` : 'fora do período do verificador' });
      return;
    }
    const r = receipts.get(i);
    if (!r) { excluded.push({ id: it.id, reason: 'recibo não decodificado' }); return; }
    if (r.provider !== w.provider) { excluded.push({ id: it.id, reason: `provedor ${r.provider}` }); return; }
    if (w.tenantId && r.key.tenantId !== w.tenantId) { excluded.push({ id: it.id, reason: 'outro cliente' }); return; }
    const observedAt = typeof r.usage.observedAt === 'string' ? new Date(r.usage.observedAt).toISOString() : new Date(r.timing.admittedAt).toISOString();
    if (observedAt < w.start || observedAt >= w.end) { excluded.push({ id: it.id, reason: 'fora da janela da conciliação' }); return; }
    const notes: string[] = [`recibo ${it.verdict} no verificador (${it.code})`];
    for (const x of it.warnings) notes.push(`aviso do verificador: ${x.code}`);
    if (r.usage.completeness !== 'complete') notes.push(`usage completeness ${r.usage.completeness}`);
    const wire = toJsonValue(r.usage.categories) as Array<{ name: string; count: string | null; inclusion: string }>;
    const quantities = quantitiesFromNormalizedUsage(wire, notes);
    notes.push('o recibo traz cotação de preço, não dinheiro confirmado: confirmedMoney = null');
    records.push({
      source: 'verified_receipt_v3', tenantId: r.key.tenantId, operationId: r.key.operationId, provider: w.provider,
      modelRequested: r.usage.modelRequested, modelReturned: r.usage.modelReturned ?? null,
      providerRequestId: r.usage.providerRequestId ?? null,
      quantities, priceTableVersion: r.price?.priceTable?.version ?? r.config.priceTable?.version ?? null,
      confirmedMoney: null, moneyState: null, moneyOrigin: 'otk_receipt_v3 (sem dinheiro confirmado no recibo)', moneyRoundingHalfUnits: 0n,
      observedAt, notes,
    });
  });
  const sha = reportSha256(report);
  return {
    records, excluded, digests: [sha], verificationSha256: sha, red,
    description: `recibos v3 verificados: ${records.length} usados (verdes e amarelos), ${red} reprovados (vermelhos) fora; relatório do verificador sha256 ${sha}; chaveiro ${report.keyring.anchor}`,
  };
}
