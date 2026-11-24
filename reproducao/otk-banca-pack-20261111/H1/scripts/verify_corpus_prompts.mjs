#!/usr/bin/env node
// Verificação OFFLINE do corpus e dos prompts da H1 (baseline 7606bc9b, campanha OVERNIGHT 2). Sem rede, sem dependências.
//   node verify_corpus_prompts.mjs [--h1dir <pasta H1 do pacote>] [--out <arquivo.json>]
// O que faz:
//   1. Regenera o corpus com o gerador ORIGINAL (generator/corpus.ts, byte-idêntico à baseline; Node >= 24 executa .ts por remoção de tipos),
//      com os parâmetros declarados na campanha (semente 20261007, 9 grupos/família, 2 variantes/grupo), e confere o sha256 contra:
//      (a) o valor registrado em cada manifesto de campanha (campaign.corpus.sha256), (b) o RESUMO_CAMPANHA.md, (c) o arquivo corpus/*.jsonl do pacote.
//   2. Reconstrói cada prompt (prefixo fixo + texto do documento), confere com corpus/prompts.jsonl e com docs_table.csv (sha256, nº de caracteres).
//   3. Confere promptSha256/promptChars registrados nos manifestos (plannedCalls) contra os prompts reconstruídos (corpus e prompts especiais).
// Saída: JSON com os resultados; exit 0 = tudo bateu, exit 3 = alguma divergência (nada é "ajustado").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const H1DIR = path.resolve(arg('h1dir', path.join(here, '..')));
const OUT = arg('out');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const PARAMS = { seed: 20261007, groupsPerFamily: 9, variantsPerGroup: 2 };
const EXPECTED_CORPUS_SHA = '043b2561b898a375aad62d13be0c4822ccddd2b2d2c94738fdb97462885353e6';
const TEMPLATE_PREFIX = 'Resuma em uma frase curta o texto a seguir.\n\n';
const CAMPAIGN = path.join(H1DIR, 'inputs', 'h1_subset', 'docs', '_ops', 'OVERNIGHT2_20261006');

const CG = await import(pathToFileURL(path.join(H1DIR, 'generator', 'corpus.ts')).href);
const docs = CG.generateCorpus(PARAMS);
const jsonl = CG.corpusToJsonl(docs);
const corpusSha = CG.sha256(jsonl);
const byId = new Map(docs.map((d) => [d.id, d]));
const checks = []; const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

add('corpus regenerado == sha esperado (043b2561…)', corpusSha === EXPECTED_CORPUS_SHA, { regenerated: corpusSha, expected: EXPECTED_CORPUS_SHA, docs: docs.length });
const shipped = fs.readFileSync(path.join(H1DIR, 'corpus', 'corpus_seed20261007_g9_v2.jsonl'), 'utf8');
add('corpus regenerado == corpus/corpus_seed20261007_g9_v2.jsonl (byte a byte)', shipped === jsonl, { shippedSha: sha(shipped) });

// manifestos de campanha
const manifests = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!e.name.startsWith('synthetic')) walk(p); } else if (e.name.endsWith('_manifest.json')) manifests.push(p); } })(path.join(CAMPAIGN, 'campaign'));
manifests.sort();
const mj = manifests.map((f) => ({ f: path.relative(H1DIR, f).split(path.sep).join('/'), m: JSON.parse(fs.readFileSync(f, 'utf8')) }));
const withCorpus = mj.filter((x) => x.m.campaign?.corpus);
const mShas = [...new Set(withCorpus.map((x) => x.m.campaign.corpus.sha256))];
const mParams = [...new Set(withCorpus.map((x) => `${x.m.campaign.corpus.seed}/${x.m.campaign.corpus.groupsPerFamily}/${x.m.campaign.corpus.variantsPerGroup}`))];
add('todos os manifestos com corpus registram o mesmo sha == regenerado', mShas.length === 1 && mShas[0] === corpusSha && withCorpus.length > 0, { manifestsWithCorpus: withCorpus.length, shas: mShas });
add('parâmetros dos manifestos == 20261007/9/2', mParams.length === 1 && mParams[0] === '20261007/9/2', { params: mParams });
const resumoPath = path.join(CAMPAIGN, 'campaign', 'RESUMO_CAMPANHA.md');
const resumo = fs.existsSync(resumoPath) ? fs.readFileSync(resumoPath, 'utf8') : '';
const rs = (resumo.match(/Corpus: semente 20261007, sha256\s+`([0-9a-f]{64})`/) ?? [])[1] ?? null;
add('RESUMO_CAMPANHA.md registra o mesmo sha', rs === corpusSha, { resumo: rs });

// prompts
const prompts = fs.readFileSync(path.join(H1DIR, 'corpus', 'prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let pOk = 0; const pBad = [];
for (const p of prompts) { const d = byId.get(p.docId); const want = d ? TEMPLATE_PREFIX + d.text : null; if (want !== null && p.prompt === want && p.prompt_sha256 === sha(want)) pOk++; else pBad.push(p.docId); }
add('prompts.jsonl: prefixo + texto do corpus e sha256 conferem (216)', prompts.length === docs.length && pOk === docs.length, { prompts: prompts.length, ok: pOk, bad: pBad.slice(0, 5) });
const promptByLabel = new Map(prompts.map((p) => [p.label, { sha: p.prompt_sha256, chars: p.prompt.length }]));

// docs_table.csv
const dt = fs.readFileSync(path.join(H1DIR, 'corpus', 'docs_table.csv'), 'utf8').split('\n').filter(Boolean);
const hdr = dt[0].split(','); const col = (n) => hdr.indexOf(n);
let dOk = 0; const splitCount = { train: 0, validation: 0, test: 0 };
for (const line of dt.slice(1)) { const c = line.split(','); const d = byId.get(c[col('docId')]); if (!d) continue; splitCount[c[col('split')]] = (splitCount[c[col('split')]] ?? 0) + 1;
  if (c[col('text_sha256')] === sha(d.text) && c[col('prompt_sha256')] === sha(TEMPLATE_PREFIX + d.text) && Number(c[col('prompt_chars_utf16')]) === (TEMPLATE_PREFIX + d.text).length && c[col('split')] === CG.splitOf(d.group)) dOk++; }
add('docs_table.csv: sha256 do texto/prompt, nº de caracteres e split conferem (216)', dt.length - 1 === docs.length && dOk === docs.length, { rows: dt.length - 1, ok: dOk, splitCount });

// prompts especiais (cacheprobe e besu) vêm de special_prompts.json (já com sha/chars)
const sp = JSON.parse(fs.readFileSync(path.join(H1DIR, 'corpus', 'special_prompts.json'), 'utf8')).cacheprobe_and_besu;
const spOk = sp.every((s) => s.prompt_sha256 === sha(s.prompt) && s.prompt_chars === s.prompt.length);
add('special_prompts.json: sha256/chars dos prompts de cacheprobe e besu conferem', spOk, { n: sp.length });
for (const s of sp) promptByLabel.set(s.name.startsWith('cache') ? 'cache-*' : 'besu', { sha: s.prompt_sha256, chars: s.prompt_chars });

// plannedCalls dos manifestos x prompts reconstruídos
let n = 0, shaEq = 0, charsEq = 0; const bad = [];
for (const { f, m } of mj) for (const pc of m.plannedCalls ?? []) { n++; const key = /^cache-/.test(pc.label) ? 'cache-*' : pc.label; const mine = promptByLabel.get(key);
  const a = !!mine && mine.sha === pc.promptSha256; const b = !!mine && mine.chars === pc.promptChars; if (a) shaEq++; if (b) charsEq++; if (!a || !b) bad.push([f, pc.label]); }
add('plannedCalls dos manifestos: promptSha256 e promptChars == prompt reconstruído', n > 0 && shaEq === n && charsEq === n, { entries: n, shaEqual: shaEq, charsEqual: charsEq, bad: bad.slice(0, 5) });

const ok = checks.every((c) => c.ok);
const result = { schema: 'otk.banca.h1.verify_corpus_prompts.v1', baseline: '7606bc9be46bde8c1bc427c2eb4873bc1a474779', params: PARAMS, corpusSha256: corpusSha, ok, checks };
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FALHA'} ${c.name}`);
console.log(ok ? 'VERIFICACAO: TUDO BATEU' : 'VERIFICACAO: DIVERGENCIA (nada foi ajustado)');
process.exit(ok ? 0 : 3);
