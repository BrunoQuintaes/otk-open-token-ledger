// Materializa o LEDGER_OPENING dos pilotos Sonnet/Opus, por GO limitado da C157 secao 9.2 (autorizacao autoral concedida por esta ordem; materializada pela coordenadora; NAO e ato presencial).
// COPIA NOVA de mk_opening_r5.mts (que cita a C156 secao 3.3 e NUNCA deve ser reusada para esta abertura): so o signedBy muda; a logica de heranca e identica.
// Uso (cwd = worktree do executor): tsx scripts/h2eval/tools/mk_opening_c157.mts --from-dir <pasta anterior fechada> --label "<texto>" --closed-utc <UTC> --out <pasta nova>/LEDGER_OPENING.json
// Herda TODO o comprometido da pasta anterior: (abertura anterior settled+uncertain, nas suas categorias) + liquidado + incerto da propria pasta. Recusa se houver reserva aberta.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { sha256Canon } from '../core/canon.js';
import { openLedger, validateLedgerOpening } from '../core/ledger.js';

const argv = process.argv.slice(2);
const need = (k: string) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : undefined; if (!v) { console.error(`falta --${k}`); process.exit(2); } return v; };
const from = need('from-dir'); const out = need('out'); if (existsSync(out)) { console.error('arquivo ja existe; nunca sobrescrever'); process.exit(3); }
const prev = JSON.parse(readFileSync(`${from}/LEDGER_OPENING.json`, 'utf8')) as { providers: Record<string, { settledUsd: string; uncertainUsd: string }>; digestSha256: string };
const ledgerSha256 = createHash('sha256').update(readFileSync(`${from}/ledger.jsonl`)).digest('hex');
const st = openLedger(`${from}/ledger.jsonl`, { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, undefined, prev as never).state() as { providers: Record<string, { spentUsd: string; possiblyChargedUsd: string; reservedUsd: string; operations: number }> };
const toPico = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 12n + BigInt((f + '0'.repeat(12)).slice(0, 12)); };
const usd = (p: bigint) => { const s = p.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`.replace(/0+$/, '').replace(/\.$/, '.0'); };
const providers: Record<string, { settledUsd: string; uncertainUsd: string }> = {};
for (const [p, v] of Object.entries(st.providers)) {
  if (BigInt(v.reservedUsd) !== 0n) { console.error(`${p}: reserva aberta na pasta anterior`); process.exit(4); }
  const pp = prev.providers?.[p];
  const settled = BigInt(v.spentUsd) + (pp ? toPico(pp.settledUsd) : 0n); const uncertain = BigInt(v.possiblyChargedUsd) + (pp ? toPico(pp.uncertainUsd) : 0n);
  if (settled + uncertain === 0n) continue;
  providers[p] = { settledUsd: usd(settled), uncertainUsd: usd(uncertain) };
}
const o: Record<string, unknown> = {
  schema: 'h2eval.ledger_opening.v1',
  fromStudy: { label: need('label'), ledgerSha256, closedUtc: need('closed-utc') },
  providers,
  signedBy: 'human:Bruno (C157 secao 9.2, GO limitado dos pilotos Sonnet/Opus; literal inputs/LITERAL/c157/C157_NOTURNA_20261112T043920Z.txt sha256 146b67994ec83f9c1c929f0a0b0ccd84652fcb8d899ee075f95a19e2fe47b138; autorizacao autoral concedida por esta ordem e materializada pela coordenadora; nao e ato presencial)',
};
o.digestSha256 = sha256Canon(o);
validateLedgerOpening(o as never);
writeFileSync(out, JSON.stringify(o, null, 1), { flag: 'wx' });
console.log(JSON.stringify({ out, ledgerSha256, providers, operationsPrevFolder: st.providers.anthropic?.operations, digestSha256: o.digestSha256 }));
