// Refaz, SEM REDE e sem chave de API, os resultados numéricos das coletas de 7/10 e 23/11 listados no README (parte 6), e compara com os valores auditados.
//   npm run reproduzir-tudo                 (ou: node --import ./reproducao/ferramentas/sem_rede.mjs reproducao/reproduzir_tudo.mjs)
//   opcional: --out <pasta>                 (padrão: pasta temporária nova)
// Partes:
//   A. Coleta de 7/10/2026 (H1) e verificação da calibração Anthropic: pacote da banca, ZIP sha256 3943637b…
//   B. Tabela dos tokens declarados pelos 8 modelos da CMP8 (23/11/2026)
//   C. Tabela "estimado pelo OTK × declarado" da CMP8, e a prova de que o registro de cada envio foi gravado ANTES dele (com a contagem do OTK quando o modelo é suportado)
//   D. Conferência dos recibos de exemplo no verificador (e conferência do chaveiro do operador e da página)
// Saída: uma linha OK/FALHOU por item e RESULTADO_REPRODUCAO.json na pasta de saída. Código de saída 0 só se tudo deu OK.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process'; import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARDA = path.join(RAIZ, 'reproducao', 'ferramentas', 'sem_rede.mjs');
const iOut = process.argv.indexOf('--out');
const OUT = iOut > 0 ? path.resolve(process.argv[iOut + 1]) : path.join(RAIZ, 'saida-reproducao', new Date().toISOString().replace(/[:.]/g, '-').replace('Z', ''));
const rel = (p) => path.relative(RAIZ, p) || '.';
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) { console.error(`A pasta de saída já tem arquivos: ${OUT}. Use uma pasta vazia ou nova.`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shaArq = (p) => sha(fs.readFileSync(p));
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const envFilho = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(GUARDA).href}`.trim() };
const TSX = path.join(RAIZ, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const roda = (nome, args, cwd = RAIZ) => {
  const r = spawnSync(process.execPath, args, { cwd, env: envFilho, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(path.join(OUT, `${nome}.log.txt`), `$ node ${args.join(' ')}\n(cwd ${path.relative(RAIZ, cwd) || '.'})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n--- exit ${r.status}\n`);
  return r;
};
const itens = [];
const item = (parte, nome, ok, detalhe) => { itens.push({ parte, nome, ok: !!ok, detalhe }); console.log(`${ok ? 'OK     ' : 'FALHOU '} ${parte}. ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const tenta = (parte, nome, fn) => { try { fn(); } catch (e) { item(parte, nome, false, `erro: ${e.message}`); } };
if (!fs.existsSync(TSX)) { console.error('Falta instalar as dependências: rode primeiro  npm ci'); process.exit(3); }
console.log(`Reprodução sem rede. Pasta de saída: ${rel(OUT)}\n`);

// ───── A. 7/10 (pacote da banca)
const PACOTE = path.join(RAIZ, 'reproducao', 'otk-banca-pack-20261111');
tenta('A', 'ZIP do pacote da banca tem o sha256 esperado (3943637b…)', () => {
  const s = shaArq(path.join(RAIZ, 'reproducao', 'otk-banca-pack-20261111.zip'));
  item('A', 'ZIP do pacote da banca tem o sha256 esperado (3943637b…)', s === '3943637bef45c2c21a6b143f0cfa8829f22df70b306e85901cbdb23ade738224', s);
});
tenta('A', 'Pacote: hashes, sanitização, H1 de 7/10 (30 de 30 arquivos) e CAL-ANTH (19 de 20)', () => {
  const r = roda('A_pacote_banca', [path.join(PACOTE, 'tools', 'reproduce_all.mjs'), '--out', path.join(OUT, 'A_pacote_banca')], PACOTE);
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'A_pacote_banca', 'REPRODUCAO_PACOTE.json'), 'utf8')); } catch { /* sem relatório */ }
  const passos = j?.steps ? j.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}`).join('; ') : 'sem relatório';
  item('A', 'Pacote: hashes, sanitização, H1 de 7/10 (30 de 30 arquivos) e CAL-ANTH (19 de 20)', r.status === 0 && j?.ok === true, passos);
});

// ───── B. Tabela CMP8 (8 modelos)
const CMP8 = path.join(RAIZ, 'reproducao', 'cmp8');
const ESP = path.join(CMP8, 'esperado');
tenta('B', 'Tabela dos 8 modelos (CMP8): .tex idêntico byte a byte ao auditado', () => {
  const o = path.join(OUT, 'B_tabela_cmp8');
  const r = roda('B_tabela_cmp8', [path.join(CMP8, 'scripts', 'analise_cmp8.mjs'), '.', path.join('..', 'referencia_710', 'h1_chamadas.csv'), o, '--rotulo', 'REAL', '--dir-google', 'google_v1_3,google'], path.join(CMP8, 'dados'));
  if (r.status !== 0) throw new Error(`analise_cmp8.mjs saiu com ${r.status}`);
  const t = shaArq(path.join(o, 'tabela_cmp8.tex'));
  item('B', 'Tabela dos 8 modelos (CMP8): .tex idêntico byte a byte ao auditado', t === shaArq(path.join(ESP, 'tabela_cmp8.tex')) && t === '5a9d6feac2f9e51c5880141f1e6225d3f836d93f97c4fd4aeb8c58f8c223785d', t);
  // JSON: igual ao auditado (sha baed13cf…) fora data de geração e caminho dos arquivos de origem (os sha256 das origens são comparados)
  const norm = (j) => { const c = structuredClone(j); delete c.geradoUtc; for (const f of Object.values(c.fontes ?? {})) delete f.arquivo; if (c.referencia710) delete c.referencia710.csv; return canon(c); };
  const e = fs.readFileSync(path.join(ESP, 'tabela_cmp8.json'));
  const igual = norm(JSON.parse(fs.readFileSync(path.join(o, 'tabela_cmp8.json'), 'utf8'))) === norm(JSON.parse(e.toString('utf8')));
  item('B', 'Tabela dos 8 modelos (CMP8): JSON igual ao auditado (tabela_cmp8.json V1_3, sha baed13cf…), fora data e caminhos', igual && sha(e) === 'baed13cfa673dc46435f126ba7b88fb529664e16bf6ec01d68a9b6eb1f49c164', `esperado ${sha(e).slice(0, 12)}…`);
});

// ───── C. Estimado × declarado e prova de "gravado antes"
tenta('C', 'Estimado do OTK × declarado (CMP8)', () => {
  const o = path.join(OUT, 'C_estimado');
  const r = roda('C_estimado', [TSX, path.join(CMP8, 'scripts', 'estimado_cmp8.mts'), o]);
  if (r.status !== 0) throw new Error(`estimado_cmp8.mts saiu com ${r.status}`);
  const r2 = roda('C_estimado_tex', [path.join(CMP8, 'scripts', 'tex_estimado.mjs'), o]);
  if (r2.status !== 0) throw new Error(`tex_estimado.mjs saiu com ${r2.status}`);
  const l = shaArq(path.join(o, 'linhas_estimado.jsonl'));
  item('C', 'Estimado × declarado: as 1.720 linhas (texto × modelo) idênticas byte a byte às auditadas', l === shaArq(path.join(ESP, 'linhas_estimado.jsonl')) && l === '8608af93a993e1e23e3b1795e6c8335e056d8071950abd388174cb0fd10752f4', l);
  const t = shaArq(path.join(o, 'tabela_estimado.tex'));
  item('C', 'Estimado × declarado: .tex idêntico byte a byte ao auditado', t === shaArq(path.join(ESP, 'tabela_estimado.tex')) && t === '4e0d854729616f85778016b9612ba682050f49a8d1fb025b4ce5091c7e7085f2', t);
  const norm = (j) => { const c = structuredClone(j); delete c.geradoUtc; for (const m of c.tabela ?? []) if (m.perfil) delete m.perfil.arquivo; return canon(c); };
  const e = fs.readFileSync(path.join(ESP, 'tabela_estimado.json'));
  const igual = norm(JSON.parse(fs.readFileSync(path.join(o, 'tabela_estimado.json'), 'utf8'))) === norm(JSON.parse(e.toString('utf8')));
  item('C', 'Estimado × declarado: JSON igual ao auditado (tabela_estimado.json V2, sha 685654f6…), fora data e caminhos', igual && sha(e) === '685654f672dd4f3a02d52767133246f75963e7be97fba7e1a85da98acc039119', `esperado ${sha(e).slice(0, 12)}…`);
});
tenta('C', 'Registro da contagem gravado ANTES de cada envio', () => {
  const o = path.join(OUT, 'C_prova_previsao_antes.json');
  const r = roda('C_prova_previsao_antes', [TSX, path.join(CMP8, 'scripts', 'prova_previsao_antes_cmp8.mts'), path.join(CMP8, 'dados'), o]);
  const a = JSON.parse(fs.readFileSync(o, 'utf8')); const e = JSON.parse(fs.readFileSync(path.join(ESP, 'prova_previsao_antes_cmp8.json'), 'utf8'));
  const prov = Object.keys(e.provedores);
  const mesmos = prov.every((p) => canon(a.provedores[p]?.porModelo) === canon(e.provedores[p].porModelo) && String(a.provedores[p]?.cadeia).startsWith('OK'));
  const enviadas = prov.reduce((s, p) => s + Object.values(a.provedores[p]?.porModelo ?? {}).reduce((x, m) => x + (m.enviadas ?? 0), 0), 0);
  const antes = prov.reduce((s, p) => s + Object.values(a.provedores[p]?.porModelo ?? {}).reduce((x, m) => x + (m.snapshotAntesDoEnvio ?? 0), 0), 0);
  const comContagem = prov.reduce((s, p) => s + Object.values(a.provedores[p]?.porModelo ?? {}).reduce((x, m) => x + (m.estado_ESTIMATED ?? 0), 0), 0); // só para o texto impresso
  item('C', 'Registro da contagem gravado ANTES de cada envio (cadeia do journal conferida; contagens iguais às auditadas)', r.status === 0 && a.veredito === e.veredito && a.falhas === 0 && mesmos, `${antes} de ${enviadas} envios com o registro gravado antes; ${comContagem} deles com a contagem do OTK`);
});

// ───── D. Verificador
tenta('D', 'Verificador: recibos de exemplo', () => {
  const VET = path.join(RAIZ, 'test', 'verifier', 'vetores');
  const esp = JSON.parse(fs.readFileSync(path.join(VET, 'esperado.json'), 'utf8'));
  const r0 = roda('D_vetores_check', [TSX, path.join(RAIZ, 'test', 'verifier', 'gera_vetores.ts'), '--check']);
  item('D', 'Verificador: os recibos de exemplo no disco são os que o código gera (19 arquivos)', r0.status === 0, r0.stdout.trim());
  for (const [rotulo, extra, chave] of [['com a impressão digital', ['--fingerprint', esp.impressaoDigital], 'comImpressaoDigital'], ['sem a impressão digital', [], 'semImpressaoDigital']]) {
    const r = roda(`D_verify_${chave}`, [TSX, path.join(RAIZ, 'scripts', 'verify', 'otk.ts'), 'verify', path.join(VET, 'recibos'), '--keyring', path.join(VET, 'chaveiro.json'), ...extra, '--json']);
    fs.writeFileSync(path.join(OUT, `D_relatorio_${chave}.json`), r.stdout);
    const s = sha(Buffer.from(r.stdout, 'utf8')); let vs = null; try { vs = JSON.parse(r.stdout); } catch { /* */ }
    const n = vs?.summary ?? vs?.resumo ?? null;
    item('D', `Verificador: relatório dos recibos de exemplo ${rotulo} igual ao esperado`, s === esp.relatorioSha256[chave] && r.status === esp.exitCode[chave], `sha ${s.slice(0, 12)}…, código de saída ${r.status}${n ? '' : ''}`);
  }
  const ch = shaArq(path.join(RAIZ, 'chaveiro', 'chaveiro_operador_otk.json'));
  item('D', 'Chaveiro do operador: impressão digital igual à publicada na dissertação (c9dcbb90…)', ch === 'c9dcbb90ec0b9fd79a1da4764821e11f5a46f9073a3c991f00c1daa000f72fdc', ch);
  const pg = shaArq(path.join(RAIZ, 'web', 'verificador', 'verificador-otk.html'));
  item('D', 'Página do verificador: sha256 igual ao registrado (2bef5dd8…)', pg === '2bef5dd84fcf7289ae5e76cf74e329eb6bda55f479415b898da364786efdc2fc', pg);
});

const ok = itens.every((i) => i.ok);
const res = { schema: 'otk.repo_publico.reproducao.v1', ok, node: process.version, semRede: 'conexões para fora da máquina bloqueadas por reproducao/ferramentas/sem_rede.mjs', itens };
fs.writeFileSync(path.join(OUT, 'RESULTADO_REPRODUCAO.json'), JSON.stringify(res, null, 1) + '\n');
console.log(`\n${ok ? 'TUDO OK' : 'ALGO FALHOU'}: ${itens.filter((i) => i.ok).length} de ${itens.length} itens. Detalhes em ${rel(path.join(OUT, 'RESULTADO_REPRODUCAO.json'))}`);
process.exit(ok ? 0 : 1);
