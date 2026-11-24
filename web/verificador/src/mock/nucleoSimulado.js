// Núcleo SIMULADO, só para testar a interface sem o núcleo real (mesma assinatura de
// src/verifier/index.ts do VERIFICADOR_MVP). Não confere assinatura nenhuma: lê o veredito
// escrito em cada linha. A página construída com ele mostra um aviso vermelho fixo.
export const SIMULADO = true;
const dec = new TextDecoder();

export function verifyBundle(input, keyRing, opts = {}) {
  const items = [];
  for (const f of [...input].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    dec.decode(f.bytes).split('\n').forEach((ln, i) => {
      if (!ln.trim()) return;
      let o;
      try { o = JSON.parse(ln); } catch { o = { verdict: 'vermelho', code: 'invalid_json' }; }
      items.push({
        id: o.id ?? `${f.name}#${i + 1}`, kind: 'receipt', source: { file: f.name, line: i + 1 },
        verdict: o.verdict ?? 'verde', code: o.code ?? 'ok', reasonPt: o.reasonPt ?? '', meaningPt: o.meaningPt ?? '', notGuaranteedPt: o.notGuaranteedPt ?? '',
        detail: null, signer: null, keyId: o.keyId ?? null, signedAt: o.signedAt ?? null, digestRecomputed: null, digestDeclared: null,
        warnings: o.warnings ?? [], facts: o.facts ?? null, inPeriod: true, counted: o.verdict !== 'vermelho',
      });
    });
  }
  const t = { verde: 0, amarelo: 0, vermelho: 0 };
  for (const it of items) t[it.verdict]++;
  const fp = opts.fingerprint ?? null;
  return {
    schema: 'otk.verification_report.v1', verifierVersion: 'SIMULADO',
    options: { fingerprint: fp, since: null, until: null },
    keyring: { name: keyRing?.name ?? null, fingerprint: null, fingerprintExpected: fp, anchor: keyRing ? (fp ? 'anchored' : 'not_anchored') : 'missing', keys: [], error: null },
    inputs: [], overall: t.vermelho ? 'vermelho' : t.amarelo ? 'amarelo' : 'verde', exitCode: 0, items,
    summary: { total: t, receipts: t, byMonth: [], byDay: [], byProviderModel: [], counted: { key: '', ...t, counted: 0, tokens: [], cu: { sum: '0', unknown: 0 } }, redItems: [] },
    notGuaranteedPt: [],
  };
}
export const serializeReport = (r) => JSON.stringify(r, null, 2) + '\n';
export const reportToCsv = (r) => 'id;veredito\r\n' + r.items.map((i) => `${i.id};${i.verdict}`).join('\r\n') + '\r\n';
