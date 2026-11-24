/**
 * Prova, só leitura e sem rede, de que a coleta CMP8 (23/11/2026) GRAVOU a contagem local do OTK (L0) ANTES de enviar cada chamada.
 * Adaptação para o repositório público (REPO_PUBLICO, C160) de runs/C160/E2E_PREP/tools/prova_previsao_antes_cmp8.mts (E2E_PREP).
 * Única diferença: o journal publicado é o journal_sanitizado.jsonl, em que o identificador de resposta do provedor
 * (body.providerRequestId) foi trocado por "<REDIGIDO>" nas linhas marcadas "redigido": true. Por isso a cadeia é conferida assim:
 *   - toda linha: schema, seq = número da linha, prevHash = hash da linha anterior (o encadeamento inteiro);
 *   - linha NÃO redigida: o hash é recalculado (sha256 do JSON canônico sem o campo hash), com o canon do próprio executor;
 *   - linha redigida: o hash gravado é aceito como dado (o conteúdo dela não pode ser recalculado sem o id do provedor).
 * As linhas que a prova usa (PLANNED, PRECALL_SNAPSHOT_COMMITTED e SENT) nunca são redigidas: o hash delas é recalculado.
 * Depois, para cada operação enviada (SENT): existe PRECALL_SNAPSHOT_COMMITTED com seq MENOR e tsUtc <= o do SENT; o arquivo
 * snapshots/<op>.json tem o sha e o L0 gravados no journal; o L0 do journal = contagemLocal do TENTATIVAS_CMP8.jsonl.
 * Uso: npx tsx reproducao/cmp8/scripts/prova_previsao_antes_cmp8.mts reproducao/cmp8/dados <saida.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { canon, sha256Hex } from '../../../scripts/h2eval/core/canon.ts';
import { GENESIS_PREV } from '../../../scripts/h2eval/core/journal.ts';
import { H2EVAL_SCHEMA } from '../../../scripts/h2eval/types.ts';

type Linha = { schema: string; seq: number; tsUtc: string; kind: string; operationId: string; body: Record<string, unknown>; prevHash: string; hash: string; redigido?: boolean };
const [root, outFile] = process.argv.slice(2);
if (!root || !outFile) { console.error('uso: <reproducao/cmp8/dados> <saida.json>'); process.exit(2); }

function conferirCadeia(text: string): { linhas: Linha[]; recalculadas: number; redigidas: number } {
  const out: Linha[] = []; let prev = GENESIS_PREV; let recalculadas = 0; let redigidas = 0;
  const raw = text.split('\n').filter((l) => l.length > 0);
  for (let i = 0; i < raw.length; i++) {
    const l = JSON.parse(raw[i]!) as Linha;
    if (l.schema !== H2EVAL_SCHEMA.journal) throw new Error(`schema na linha ${i + 1}`);
    if (l.seq !== i + 1) throw new Error(`seq na linha ${i + 1}`);
    if (l.prevHash !== prev) throw new Error(`encadeamento na linha ${i + 1}`);
    if (l.redigido === true) {
      if (['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'SENT'].includes(l.kind)) throw new Error(`linha ${i + 1} (${l.kind}) redigida: a prova precisa dela íntegra`);
      redigidas++;
    } else {
      const { hash, ...rest } = l;
      if (sha256Hex(canon(rest)) !== hash) throw new Error(`hash na linha ${i + 1}`);
      recalculadas++;
    }
    prev = l.hash; out.push(l);
  }
  return { linhas: out, recalculadas, redigidas };
}

const out: Record<string, unknown> = { schema: 'otk.e2e_prep.prova_previsao_antes.v1', autor: 'REPO_PUBLICO (adaptação da E2E_PREP, C160)', geradoUtc: new Date().toISOString(), executor: 'b0ec6f2444c9648d13378ac5990a9e8ed7093b35', raiz: 'reproducao/cmp8/dados', provedores: {} };
let falhas = 0;
for (const p of ['openai', 'anthropic', 'google', 'google_v1_3']) {
  const dir = path.join(root, p);
  const jf = path.join(dir, 'journal_sanitizado.jsonl');
  if (!fs.existsSync(jf)) continue;
  const r: Record<string, unknown> = {};
  let L: Linha[];
  try { const c = conferirCadeia(fs.readFileSync(jf, 'utf8')); L = c.linhas; r['cadeia'] = `OK (${c.recalculadas} linhas com hash recalculado; ${c.redigidas} redigidas conferidas pelo encadeamento)`; }
  catch (e) { r['cadeia'] = `FALHA: ${String(e)}`; falhas++; (out['provedores'] as Record<string, unknown>)[p] = r; continue; }
  const model: Record<string, string> = {};
  const snap: Record<string, { seq: number; ts: string; L0: unknown; status: unknown; sha: unknown }> = {};
  const sent: Record<string, { seq: number; ts: string }> = {};
  for (const e of L) {
    if (e.kind === 'PLANNED') model[e.operationId] = String(e.body['modelRequested']);
    if (e.kind === 'PRECALL_SNAPSHOT_COMMITTED' && !snap[e.operationId]) snap[e.operationId] = { seq: e.seq, ts: e.tsUtc, L0: e.body['L0'], status: e.body['estimateStatus'], sha: e.body['snapshotSha256'] };
    if (e.kind === 'SENT' && !sent[e.operationId]) sent[e.operationId] = { seq: e.seq, ts: e.tsUtc };
  }
  const tent: Record<string, number | null> = {};
  const tf = path.join(dir, 'TENTATIVAS_CMP8.jsonl');
  if (fs.existsSync(tf)) for (const l of fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean)) { const t = JSON.parse(l) as { opId: string; contagemLocal?: number | null }; tent[t.opId] = t.contagemLocal ?? null; }
  const porModelo: Record<string, Record<string, number>> = {};
  const inc = (m: string, k: string) => { porModelo[m] ??= {}; porModelo[m][k] = (porModelo[m][k] ?? 0) + 1; };
  const exemplosFalha: string[] = [];
  for (const [op, s] of Object.entries(sent)) {
    const m = model[op] ?? 'DESCONHECIDO';
    inc(m, 'enviadas');
    const pc = snap[op];
    if (!pc) { inc(m, 'semSnapshot'); falhas++; exemplosFalha.push(`${op}:sem_snapshot`); continue; }
    if (!(pc.seq < s.seq && pc.ts <= s.ts)) { inc(m, 'snapshotDepoisDoEnvio'); falhas++; exemplosFalha.push(`${op}:ordem`); continue; }
    inc(m, 'snapshotAntesDoEnvio');
    inc(m, `estado_${String(pc.status)}`);
    const sf = path.join(dir, 'snapshots', `${op}.json`);
    if (!fs.existsSync(sf)) { inc(m, 'arquivoSnapshotAusente'); falhas++; continue; }
    const sj = JSON.parse(fs.readFileSync(sf, 'utf8')) as { counter?: { L0?: unknown }; snapshotSha256?: string };
    if (sj.snapshotSha256 !== undefined && sj.snapshotSha256 !== pc.sha) { inc(m, 'shaSnapshotDiverge'); falhas++; exemplosFalha.push(`${op}:sha`); }
    if (JSON.stringify(sj.counter?.L0) !== JSON.stringify(pc.L0)) { inc(m, 'L0ArquivoDiverge'); falhas++; exemplosFalha.push(`${op}:L0arquivo`); }
    if (typeof pc.L0 === 'number') {
      if (op in tent) { if (tent[op] === pc.L0) inc(m, 'L0IgualContagemLocalTentativa'); else { inc(m, 'L0DivergeTentativa'); falhas++; exemplosFalha.push(`${op}:L0tent`); } }
    }
  }
  r['porModelo'] = porModelo;
  r['exemplosFalha'] = exemplosFalha.slice(0, 10);
  (out['provedores'] as Record<string, unknown>)[p] = r;
}
out['falhas'] = falhas;
out['veredito'] = falhas === 0 ? 'L0_GRAVADO_ANTES_DO_ENVIO_EM_TODAS_AS_OPERACOES_ENVIADAS' : 'FALHAS';
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ veredito: out['veredito'], falhas }));
process.exit(falhas === 0 ? 0 : 1);
