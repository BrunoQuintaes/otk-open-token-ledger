/**
 * Verificador offline de recibos (VERIFICADOR_MVP, C160): vetores, chaveiro, comando, determinismo
 * e paridade Node × bundle de navegador (vm sem rede). Só chaves de TESTE (test/verifier/vetores.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
  NAO_GARANTE, TEXTOS, VerifierUsageError, normalizeFingerprint, parsePublicKeyRing, renderHuman, reportSha256, reportToCsv,
  serializePublicKeyRing, serializeReport, verifyBundle, type InputFile, type VerificationReport,
} from '../../src/verifier/index.js';
import { runCli } from '../../scripts/verify/otk.js';
import { buildVectors, KEYRING_FINGERPRINT, KEYRING_TEXT, keyringFile, prodReceipt, rc, storeLine, TEST_KEYS } from './vetores.js';
import { expectedFiles, VETORES_DIR } from './gera_vetores.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const enc = (s: string) => new TextEncoder().encode(s);

const vectors = await buildVectors();
const anchored = verifyBundle(vectors.files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT });

function find(r: VerificationReport, id: string, kind?: string) {
  return r.items.filter((i) => i.id === id && (kind ? i.kind === kind : i.kind !== 'conference'));
}

test('vetores: todo caso tem o veredito e o código esperados (chaveiro ancorado)', () => {
  assert.ok(vectors.expect.length >= 40);
  for (const e of vectors.expect) {
    const m = find(anchored, e.id, e.kind);
    assert.ok(m.length > 0, `item ausente: ${e.id}`);
    for (const it of m) {
      assert.equal(it.verdict, e.verdict, `${e.id}: ${it.code}`);
      if (it.code !== 'duplicate') assert.equal(it.code, e.code, e.id);
    }
  }
});

test('os 8 tipos de alteração são todos vermelhos (digest_mismatch), mesmo com o resumo original na linha', () => {
  const alt = anchored.items.filter((i) => i.source.file === 'recibos/b_alterados.jsonl');
  assert.equal(alt.length, 8);
  for (const it of alt) { assert.equal(it.verdict, 'vermelho'); assert.equal(it.code, 'digest_mismatch'); assert.equal(it.counted, false); }
});

test('exportação: o campo "verification" do operador é ignorado (dizia ok para um recibo alterado)', () => {
  const [it] = find(anchored, 'tenant-test-a/op-export');
  assert.equal(it!.verdict, 'vermelho');
  assert.equal(it!.code, 'digest_mismatch');
  assert.equal(anchored.inputs.find((i) => i.name === 'recibos/i_exportacao.json')!.format, 'conference_export_v1');
});

test('duplicata idêntica não soma duas vezes; conflito derruba os dois', () => {
  const v = find(anchored, 'tenant-test-a/op-valido');
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((i) => i.counted), [true, false]);
  assert.equal(v[1]!.code, 'duplicate');
  const c = find(anchored, 'tenant-test-a/op-conflito');
  assert.equal(c.length, 2);
  assert.ok(c.every((i) => i.verdict === 'vermelho' && i.code === 'conflict'));
});

test('linha cortada é relatada (não ignorada) e a linha anterior continua verificada', () => {
  const t = anchored.items.find((i) => i.id === 'recibos/m_cortado.jsonl#2')!;
  assert.equal(t.code, 'truncated_line');
  assert.equal(find(anchored, 'tenant-test-a/op-antes-do-corte')[0]!.verdict, 'verde');
});

test('arquivos que não são recibo e o chaveiro arrastado junto não viram recibo', () => {
  assert.equal(anchored.inputs.find((i) => i.name === 'recibos/LEIA.txt')!.format, 'ignored');
  assert.equal(anchored.inputs.find((i) => i.name === 'recibos/chaveiro.json')!.format, 'keyring_ignored');
});

test('chaveiro sem impressão digital: nada chega a verde ("chaveiro não ancorado")', () => {
  const r = verifyBundle(vectors.files, keyringFile(), {});
  assert.equal(r.keyring.anchor, 'not_anchored');
  const ok = find(r, 'tenant-test-a/op-valido')[0]!;
  assert.equal(ok.verdict, 'amarelo');
  assert.equal(ok.code, 'keyring_not_anchored');
  assert.equal(r.items.filter((i) => i.kind === 'receipt' && i.verdict === 'verde').length, 0);
  // vermelhos continuam vermelhos
  assert.equal(find(r, 'tenant-test-a/op-revogada')[0]!.verdict, 'vermelho');
});

test('impressão digital: normalização (0x, maiúsculas, ":"), divergente e formato inválido', () => {
  const pretty = '0x' + KEYRING_FINGERPRINT.toUpperCase().match(/.{1,4}/g)!.join(':');
  assert.equal(normalizeFingerprint(pretty), KEYRING_FINGERPRINT);
  const ok = verifyBundle([vectors.files[0]!], keyringFile(), { fingerprint: pretty });
  assert.equal(ok.keyring.anchor, 'anchored');
  const wrong = verifyBundle([vectors.files[0]!], keyringFile(), { fingerprint: 'ab'.repeat(32) });
  assert.equal(wrong.keyring.anchor, 'mismatch');
  assert.equal(wrong.overall, 'vermelho');
  assert.equal(wrong.items[0]!.code, 'keyring_fingerprint_mismatch');
  assert.ok(wrong.items.filter((i) => i.kind === 'receipt').every((i) => i.verdict !== 'verde'));
  assert.throws(() => verifyBundle([], keyringFile(), { fingerprint: 'abc' }), VerifierUsageError);
  assert.throws(() => verifyBundle([], keyringFile(), { since: '2026/11/01' }), VerifierUsageError);
});

test('sem chaveiro: assinatura não reconhecida, no máximo amarelo', () => {
  const r = verifyBundle([vectors.files[0]!], null, {});
  assert.equal(r.keyring.anchor, 'missing');
  const it = r.items.find((i) => i.kind === 'receipt')!;
  assert.equal(it.verdict, 'amarelo');
  assert.equal(it.code, 'unauthorized_signer');
  assert.ok(it.warnings.some((w) => w.code === 'keyring_missing'));
});

test('chaveiro público: só endereços e estado; campo extra, aposentada sem data e endereço repetido são recusados', () => {
  const base = JSON.parse(KEYRING_TEXT) as { keys: Array<Record<string, unknown>> };
  const withPriv = structuredClone(base); withPriv.keys[0]!['privateKey'] = '0x' + '11'.repeat(32);
  assert.equal(parsePublicKeyRing(enc(JSON.stringify(withPriv))).ok, false);
  const noDate = structuredClone(base); delete noDate.keys[1]!['retiredAt'];
  assert.equal(parsePublicKeyRing(enc(JSON.stringify(noDate))).ok, false);
  const dupAddr = structuredClone(base); dupAddr.keys[2]!['address'] = String(dupAddr.keys[0]!['address']).toLowerCase();
  assert.equal(parsePublicKeyRing(enc(JSON.stringify(dupAddr))).ok, false);
  const r = verifyBundle([vectors.files[0]!], { name: 'ruim.json', bytes: enc(JSON.stringify(withPriv)) }, {});
  assert.equal(r.keyring.anchor, 'invalid');
  assert.equal(r.items[0]!.code, 'keyring_invalid');
  assert.equal(r.overall, 'vermelho');
  // serialização canônica: idempotente e mesma impressão digital
  assert.equal(serializePublicKeyRing(JSON.parse(KEYRING_TEXT)), KEYRING_TEXT);
  assert.equal(parsePublicKeyRing(enc(KEYRING_TEXT)).fingerprint, KEYRING_FINGERPRINT);
});

test('resumo: só verdes e amarelos somados, por mês e por provedor/modelo; desconhecido nunca vira zero', () => {
  const s = anchored.summary;
  const counted = anchored.items.filter((i) => i.counted);
  assert.equal(s.counted.counted, counted.length);
  assert.ok(counted.every((i) => i.verdict !== 'vermelho'));
  assert.deepEqual(s.byMonth.map((g) => g.key), ['2026-10', '2026-11']);
  assert.ok(s.byProviderModel.some((g) => g.key === 'anthropic / claude-test'));
  const cache = s.counted.tokens.find((t) => t.name === 'input_cache_read')!;
  assert.equal(cache.unknown, s.counted.counted);
  assert.equal(cache.sum, null);
  assert.equal(s.redItems.length, anchored.items.filter((i) => i.verdict === 'vermelho').length);
});

test('resumo: CU com escalas diferentes somado exatamente (sem arredondar)', async () => {
  const a = prodReceipt('cu-a', { cu: 1205n }); a.cu.cu = { units: 1205n, scale: 10n };
  const b = prodReceipt('cu-b', { cu: 3n }); b.cu.cu = { units: 3n, scale: 1n };
  const f: InputFile = { name: 'cu.jsonl', bytes: enc([storeLine(a, await rc.signReceipt(a)), storeLine(b, await rc.signReceipt(b))].join('\n') + '\n') };
  const r = verifyBundle([f], keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.equal(r.overall, 'verde');
  assert.equal(r.summary.counted.cu.sum, '123.5');
});

test('período --since/--until: fora do período fica listado mas não somado', () => {
  const r = verifyBundle(vectors.files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT, since: '2026-11-01', until: '2026-11-30' });
  const out = find(r, 'tenant-test-a/op-anthropic')[0]!;
  assert.equal(out.inPeriod, false);
  assert.equal(out.counted, false);
  assert.deepEqual(r.summary.byMonth.map((g) => g.key), ['2026-11']);
});

test('determinismo: ordem de entrada não muda os bytes; nada de caminho absoluto nem relógio no relatório', () => {
  const rev = verifyBundle([...vectors.files].reverse(), keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.equal(serializeReport(rev), serializeReport(anchored));
  const json = serializeReport(anchored);
  assert.ok(!/[A-Za-z]:[\\/]/.test(json.replace(/"https?:[^"]*"/g, '')), 'caminho absoluto no relatório');
  assert.match(reportSha256(anchored), /^[0-9a-f]{64}$/);
});

test('todo veredito tem os três textos em português; nenhum código cru sozinho', () => {
  for (const [code, t] of Object.entries(TEXTOS)) {
    assert.ok(t.reason && t.meaning && t.notGuaranteed && t.short, code);
  }
  for (const it of anchored.items) assert.ok(it.reasonPt && it.meaningPt && it.notGuaranteedPt, it.id);
  assert.ok(NAO_GARANTE.length >= 6);
  assert.deepEqual(anchored.notGuaranteedPt, NAO_GARANTE);
});

test('saída para humanos e CSV', () => {
  const h = renderHuman(anchored);
  for (const s of ['[OK]', '[ATENÇÃO]', '[FALHOU]', 'O que isto NÃO garante', 'Resumo']) assert.ok(h.includes(s), s);
  const csv = reportToCsv(anchored);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, anchored.items.length + 1);
  assert.ok(lines[0]!.startsWith('id;tipo;arquivo'));
});

test('vetores no disco (test/verifier/vetores) são exatamente os regenerados', async () => {
  const m = await expectedFiles();
  for (const [name, bytes] of m) {
    assert.equal(Buffer.compare(readFileSync(join(VETORES_DIR, name)), Buffer.from(bytes)), 0, `${name} difere: rode npx tsx test/verifier/gera_vetores.ts`);
  }
});

test('comando: otk verify na pasta de vetores → 20; --json com o sha esperado; humano com [FALHOU]', async () => {
  const esperado = JSON.parse(readFileSync(join(VETORES_DIR, 'esperado.json'), 'utf8'));
  const kr = join(VETORES_DIR, 'chaveiro.json');
  const pasta = join(VETORES_DIR, 'recibos');
  const j = await runCli(['verify', pasta, '--keyring', kr, '--fingerprint', KEYRING_FINGERPRINT, '--json']);
  assert.equal(j.code, 20);
  assert.equal(j.stdout, serializeReport(anchored));
  assert.equal(reportSha256(JSON.parse(j.stdout)), esperado.relatorioSha256.comImpressaoDigital);
  const j2 = await runCli(['verify', pasta, '--keyring', kr, '--json']);
  assert.equal(reportSha256(JSON.parse(j2.stdout)), esperado.relatorioSha256.semImpressaoDigital);
  const h = await runCli(['verify', pasta, '--keyring', kr]);
  assert.equal(h.code, 20);
  assert.ok(h.stdout.includes('[FALHOU]') && h.stdout.includes('sha256 do relatório JSON'));
});

test('comando: códigos 0 (tudo verde), 10 (amarelo) e 2 (erro de uso); --out grava o mesmo JSON', async () => {
  const d = mkdtempSync(join(tmpdir(), 'otk-verify-'));
  const pasta = join(d, 'bons'); mkdirSync(pasta);
  writeFileSync(join(pasta, 'a.jsonl'), readFileSync(join(VETORES_DIR, 'recibos', 'a_validos.jsonl')));
  const kr = join(VETORES_DIR, 'chaveiro.json');
  assert.equal((await runCli(['verify', pasta, '--keyring', kr, '--fingerprint', KEYRING_FINGERPRINT])).code, 0);
  assert.equal((await runCli(['verify', pasta, '--keyring', kr])).code, 10);
  assert.equal((await runCli(['verify', pasta])).code, 2);
  assert.equal((await runCli(['verify', pasta, '--keyring', join(d, 'nao-existe.json')])).code, 2);
  assert.equal((await runCli(['verify', pasta, '--keyring', kr, '--fingerprint', 'xyz'])).code, 2);
  assert.equal((await runCli(['verify', join(d, 'nada'), '--keyring', kr])).code, 2);
  assert.equal((await runCli(['verify', pasta, '--keyring', kr, '--opcao-estranha'])).code, 2);
  assert.equal((await runCli([])).code, 2);
  const out = join(d, 'rel.json');
  const r = await runCli(['verify', join(pasta, 'a.jsonl'), '--keyring', kr, '--json', '--out', out]);
  assert.equal(readFileSync(out, 'utf8'), r.stdout);
});

test('comando: otk keyring export grava o chaveiro público e imprime a impressão digital (sha256 do arquivo)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'otk-keyring-'));
  const out = join(d, 'chaveiro.json');
  const r = await runCli(['keyring', 'export', '--operator', 'operador-de-teste',
    '--key', `teste-op-2026-11=${TEST_KEYS.op.address}`,
    '--key', `teste-op-2026-10=${TEST_KEYS.retired.address},retired,2026-11-10T00:00:00.000Z`,
    '--key', `teste-op-2026-09=${TEST_KEYS.revoked.address},revoked`, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), KEYRING_TEXT);
  assert.ok(r.stdout.includes(KEYRING_FINGERPRINT));
  const fp = await runCli(['keyring', 'fingerprint', out]);
  assert.equal(fp.stdout.trim(), KEYRING_FINGERPRINT);
  const from = join(d, 'entradas.json');
  writeFileSync(from, JSON.stringify(JSON.parse(KEYRING_TEXT).keys));
  const r2 = await runCli(['keyring', 'export', '--from', from, '--operator', 'operador-de-teste', '--out', join(d, 'k2.json')]);
  assert.equal(readFileSync(join(d, 'k2.json'), 'utf8'), KEYRING_TEXT, r2.stderr);
  assert.equal((await runCli(['keyring', 'export', '--key', 'x=0x123', '--out', join(d, 'k3.json')])).code, 2);
});

test('núcleo sem Node: nenhum import node: em src/verifier', () => {
  const dir = join(ROOT, 'src', 'verifier');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"](node:|fs|path|crypto|os)['"]/.test(src), f);
  }
});

test('paridade: bundle de navegador (esbuild IIFE) rodando num vm sem rede dá o mesmo sha256 que o comando', async () => {
  const b = await build({ entryPoints: [join(ROOT, 'src', 'verifier', 'index.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'OTKVerifier', write: false, logLevel: 'silent' });
  const code = b.outputFiles[0]!.text;
  assert.ok(!code.includes('require("node:'), 'bundle importa módulo do Node');
  // contexto sem fetch, XMLHttpRequest, WebSocket, require ou process: qualquer acesso à rede falharia
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder, Uint8Array, console: { log() {}, warn() {}, error() {} } };
  sandbox['self'] = sandbox; // como no navegador (o ethers procura self/window)
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const lib = sandbox['OTKVerifier'] as typeof import('../../src/verifier/index.js');
  assert.equal(typeof (sandbox as { fetch?: unknown }).fetch, 'undefined');
  // mesmos arquivos lidos do disco como o navegador os receberia (webkitRelativePath)
  const files: InputFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const n of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (n.isDirectory()) walk(join(dir, n.name), `${rel}/${n.name}`);
      else files.push({ name: `${rel}/${n.name}`, bytes: new Uint8Array(readFileSync(join(dir, n.name))) });
    }
  };
  walk(join(VETORES_DIR, 'recibos'), 'recibos');
  const kr = { name: 'chaveiro.json', bytes: new Uint8Array(readFileSync(join(VETORES_DIR, 'chaveiro.json'))) };
  const rep = lib.verifyBundle(files, kr, { fingerprint: KEYRING_FINGERPRINT });
  const cli = await runCli(['verify', join(VETORES_DIR, 'recibos'), '--keyring', join(VETORES_DIR, 'chaveiro.json'), '--fingerprint', KEYRING_FINGERPRINT, '--json']);
  assert.equal(lib.serializeReport(rep), cli.stdout);
  assert.equal(lib.reportSha256(rep), reportSha256(JSON.parse(cli.stdout)));
});

test('desempenho: 1.000 recibos verificados em menos de 5 s', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) { const r = prodReceipt(`perf-${i}`); lines.push(storeLine(r, await rc.signReceipt(r))); }
  const f: InputFile = { name: 'mil.jsonl', bytes: enc(lines.join('\n') + '\n') };
  const t0 = performance.now();
  const r = verifyBundle([f], keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  const ms = performance.now() - t0;
  assert.equal(r.summary.receipts.verde, 1000);
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
});

test('rede bloqueada: o comando verify não abre conexão nem chama fetch', async () => {
  const net = await import('node:net');
  const calls: string[] = [];
  const origConnect = net.Socket.prototype.connect;
  const origFetch = globalThis.fetch;
  net.Socket.prototype.connect = function blocked(this: unknown) { calls.push('socket'); throw new Error('rede bloqueada no teste'); } as typeof origConnect;
  globalThis.fetch = (async () => { calls.push('fetch'); throw new Error('rede bloqueada no teste'); }) as typeof fetch;
  try {
    const r = await runCli(['verify', join(VETORES_DIR, 'recibos'), '--keyring', join(VETORES_DIR, 'chaveiro.json'), '--fingerprint', KEYRING_FINGERPRINT, '--json']);
    assert.equal(r.code, 20);
    assert.equal(r.stdout, serializeReport(anchored));
  } finally {
    net.Socket.prototype.connect = origConnect;
    globalThis.fetch = origFetch;
  }
  assert.deepEqual(calls, []);
});

test('X1 B1: só entra nas somas o recibo cuja assinatura conferiu; amarelo sem assinatura conferida fica fora', () => {
  for (const it of anchored.items.filter((i) => i.counted)) {
    assert.ok(!['unsupported_version', 'unauthorized_signer', 'legacy_format', 'legacy_unsupported'].includes(it.code), it.id);
  }
  for (const id of ['tenant-test-a/op-schema', 'tenant-test-a/op-chave-fora', 'tenant-test-a/op-x1-alg-trocado']) {
    const it = find(anchored, id)[0]!;
    assert.equal(it.verdict, 'amarelo', id);
    assert.equal(it.counted, false, id);
    assert.ok(it.warnings.some((w) => w.code === 'not_in_totals' && /não entra nas somas/i.test(w.textPt)), id);
  }
  // amarelos com assinatura conferida continuam somados
  for (const id of ['tenant-test-a/op-aposentada-antes', 'tenant-test-a/op-dev', 'tenant-test-a/op-parcial']) assert.equal(find(anchored, id)[0]!.counted, true, id);
  const semAncora = verifyBundle(vectors.files, keyringFile(), {});
  assert.equal(find(semAncora, 'tenant-test-a/op-valido')[0]!.counted, true);
  // nenhum 1.000.000 forjado nas somas
  for (const t of anchored.summary.counted.tokens) assert.ok(t.sum === null || BigInt(t.sum) < 1_000_000n, t.name);
});

test('X1 B2: revogada/aposentada-depois/forjada decididas pelo endereço que assinou (9 casos vermelhos)', () => {
  const casos: Array<[string, string]> = [
    ['x1-revogada-keyid-ativa', 'revoked_key'], ['x1-revogada-keyid-inventado', 'revoked_key'],
    ['x1-aposentada-depois-keyid-inventado', 'revoked_key'], ['x1-aposentada-depois-keyid-ativa', 'revoked_key'],
    ['x1-fora-keyid-ativa', 'bad_signature'], ['x1-alterado-fora-keyid-ativa', 'bad_signature'],
    ['x1-alterado-revogada-keyid-inventado', 'revoked_key'], ['x1-ativa-keyid-aposentada', 'bad_signature'], ['x1-signer-trocado', 'bad_signature'],
  ];
  for (const [nm, code] of casos) {
    const it = find(anchored, `tenant-test-a/op-${nm}`)[0]!;
    assert.equal(it.verdict, 'vermelho', nm);
    assert.equal(it.code, code, nm);
    assert.equal(it.counted, false, nm);
  }
  // chave fora do chaveiro com keyId desconhecido continua amarelo, fora das somas
  const fora = find(anchored, 'tenant-test-a/op-chave-fora')[0]!;
  assert.equal(fora.code, 'unauthorized_signer');
  assert.equal(fora.counted, false);
});

test('X1 fuga: os recibos forjados do auditor (contagem 1.000.000) não entram nas somas nem na conciliação', async () => {
  const { loadOtkFromVerifiedReceipts } = await import('../../scripts/verify/receiptsToOtk.js');
  const f: InputFile = { name: 'fuga.jsonl', bytes: new Uint8Array(readFileSync(join(HERE, 'x1', 'fuga.jsonl'))) };
  const r = verifyBundle([f], keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  const forjados = r.items.filter((i) => i.facts?.tokens.some((t) => t.count === '1000000'));
  assert.ok(forjados.length >= 8, String(forjados.length));
  assert.ok(forjados.every((i) => !i.counted && i.verdict !== 'verde'));
  assert.equal(find(r, 'tenant-test-a/op-fuga-revogada')[0]!.code, 'revoked_key');
  for (const t of r.summary.counted.tokens) assert.ok(t.sum === null || BigInt(t.sum) < 1_000_000n);
  const rec = loadOtkFromVerifiedReceipts([f], keyringFile(), { fingerprint: KEYRING_FINGERPRINT }, { provider: 'openai', start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' });
  assert.ok(rec.records.every((x) => x.quantities.every((q) => q.count < 1_000_000n)));
  assert.ok(rec.excluded.some((e) => /assinatura não conferida/.test(e.reason)));
});
