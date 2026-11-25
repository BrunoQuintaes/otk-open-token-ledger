/**
 * F4 (C160 DEFESA_CIRCUITO, 23/11/2026): o verificador aceita o anel público do bot
 * (otk.bridge.keyring_file.v1) convertendo-o sem perda; formato desconhecido dá "formato de chaveiro
 * não reconhecido" (amarelo), não "foi mexido"; textos para leigo sem "schema"; CU sem recibo somado
 * aparece como "desconhecida". Só chaves de TESTE, mais o anel PÚBLICO B5F (só endereço, sem segredo).
 *
 * In English: the verifier accepts the public keyring file written by the operator's bot (`otk.bridge.keyring_file.v1`)
 * by converting it without loss; an unknown keyring format is reported as "keyring format not recognized" (yellow),
 * never as tampering; texts for lay readers avoid the word "schema"; CU with no counted receipt is shown as unknown.
 *
 * Module under test: `src/verifier/index.ts` (keyring conversion, parsing, verification, rendering) and the command
 * `runCli` of `scripts/verify/otk.ts`.
 *
 * Strategy / scenarios: the bot keyring gives the same verdicts as the equivalent public keyring, with and without a
 * fingerprint; lossless conversion (key id, address, status, retirement date and order) with closed field sets; the
 * real public keyring of a deployed operator converts to the fingerprint quoted in the thesis; unknown format; the bot
 * keyring dropped among the receipts is recognized as a keyring; lay texts; unknown CU; and the existing public-keyring
 * path still yields the committed report sha256.
 *
 * Needs: the committed vectors and the public keyring copy in `test/verifier/f4/` (read only; addresses only, no
 * secret) and a temporary directory. No network.
 *
 * Run just this file: `npx tsx --test test/verifier/f4_anel_do_bot.test.ts`
 *
 * @module test/verifier/f4_anel_do_bot.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_KEYRING_SCHEMA, NAO_GARANTE, TEXTOS, UNKNOWN_KEYRING_FORMAT, convertBridgeKeyRing, convertBridgeKeyRingBytes,
  parsePublicKeyRing, renderHuman, reportSha256, serializeReport, sha256Hex, verifyBundle, type InputFile,
} from '../../src/verifier/index.js';
import { runCli } from '../../scripts/verify/otk.js';
import { buildVectors, KEYRING_ENTRIES, KEYRING_FINGERPRINT, keyringFile } from './vetores.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);
const vectors = await buildVectors();

/** Anel do bot com as MESMAS chaves de teste do chaveiro dos vetores (formato do gera_chave_operador.mjs: 1 espaço). */
const BRIDGE_TEXT = `${JSON.stringify({ schema: BRIDGE_KEYRING_SCHEMA, keys: KEYRING_ENTRIES }, null, 1)}\n`;
const bridgeFile = (): InputFile => ({ name: 'otk_keyring_teste.json', bytes: enc(BRIDGE_TEXT) });
const BRIDGE_FP = sha256Hex(enc(BRIDGE_TEXT));

/** Anel público real da B5F-2 (cópia byte a byte de C:/otk-a2/c160/estado/registro/otk_keyring_b5f.json). */
const B5F_BYTES = new Uint8Array(readFileSync(join(HERE, 'f4', 'otk_keyring_b5f.json')));
const B5F_SHA = '2a65cd7f82c66b061ee54a8b74e4981cac4b9af2027a55b82e1fd3bac6e9dcaf';
const DISSERTACAO_FP = 'c9dcbb90ec0b9fd79a1da4764821e11f5a46f9073a3c991f00c1daa000f72fdc';

test('D2: anel do bot é lido e dá os mesmos vereditos do chaveiro público equivalente', () => {
  const pub = verifyBundle(vectors.files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  const bot = verifyBundle(vectors.files, bridgeFile(), { fingerprint: BRIDGE_FP });
  assert.equal(bot.keyring.anchor, 'anchored');
  assert.equal(bot.keyring.convertedFrom, BRIDGE_KEYRING_SCHEMA);
  assert.equal(bot.keyring.fingerprint, BRIDGE_FP, 'impressão digital = sha256 do arquivo carregado (o do bot)');
  assert.deepEqual(bot.keyring.keys, pub.keyring.keys);
  assert.deepEqual(bot.items.map((i) => [i.id, i.kind, i.verdict, i.code, i.counted]), pub.items.map((i) => [i.id, i.kind, i.verdict, i.code, i.counted]));
  assert.deepEqual(bot.summary, pub.summary);
  assert.equal(bot.overall, pub.overall);
  // o recibo válido chega a verde com o anel do bot ancorado
  const ok = bot.items.find((i) => i.kind === 'receipt' && i.verdict === 'verde' && i.code === 'ok');
  assert.ok(ok, 'há recibo verde com o anel do bot');
});

test('D2: sem impressão digital o anel do bot fica não ancorado (amarelo), como o chaveiro público', () => {
  const bot = verifyBundle(vectors.files, bridgeFile(), {});
  assert.equal(bot.keyring.anchor, 'not_anchored');
  assert.ok(!bot.items.some((i) => i.verdict === 'verde' && i.kind === 'receipt' && i.code === 'ok' && i.warnings.length === 0));
  // impressão do chaveiro público NÃO serve para o arquivo do bot (bytes diferentes)
  const errada = verifyBundle(vectors.files, bridgeFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.equal(errada.keyring.anchor, 'mismatch');
});

test('D2: conversão sem perda (keyId, endereço, estado, retiredAt e ordem) e campos fechados', () => {
  const conv = convertBridgeKeyRing(JSON.parse(BRIDGE_TEXT));
  assert.deepEqual(conv.keys, KEYRING_ENTRIES);
  assert.equal(conv.operator, undefined, 'o anel do bot não tem operador; nada é inventado');
  assert.equal(convertBridgeKeyRing(JSON.parse(BRIDGE_TEXT), 'X').operator, 'X');
  const extraTopo = { schema: BRIDGE_KEYRING_SCHEMA, operator: 'x', keys: KEYRING_ENTRIES };
  assert.throws(() => convertBridgeKeyRing(extraTopo), /não é permitido/);
  const extraChave = { schema: BRIDGE_KEYRING_SCHEMA, keys: [{ ...KEYRING_ENTRIES[0], privateKey: '0x' + '11'.repeat(32) }] };
  assert.throws(() => convertBridgeKeyRing(extraChave), /não é permitido/);
  const p = parsePublicKeyRing(enc(JSON.stringify(extraChave)));
  assert.equal(p.ok, false);
  assert.equal(!p.ok && p.unknownFormat, false, 'anel do bot com campo proibido é inválido, não formato desconhecido');
  const r = verifyBundle([vectors.files[0]!], { name: 'anel.json', bytes: enc(JSON.stringify(extraChave)) }, {});
  assert.equal(r.items[0]!.code, 'keyring_invalid');
});

test('D2: anel B5F real → chaveiro convertido com operador "OTK A2 C160" tem a impressão c9dcbb90 (a da dissertação)', async () => {
  assert.equal(sha256Hex(B5F_BYTES), B5F_SHA, 'cópia do anel B5F íntegra');
  const p = parsePublicKeyRing(B5F_BYTES);
  assert.ok(p.ok && p.format === BRIDGE_KEYRING_SCHEMA);
  assert.equal(p.fingerprint, B5F_SHA);
  assert.deepEqual(p.ok && p.file.keys, [{ keyId: 'otk-v3-operator-a2-c160', address: '0xc455e678a8db7749769459d2eDcA9526B8367261', status: 'active' }]);
  const comOperador = convertBridgeKeyRingBytes(B5F_BYTES, 'OTK A2 C160');
  assert.equal(sha256Hex(enc(comOperador)), DISSERTACAO_FP);
  // sem operador a conversão é outra (o rótulo do operador entra nos bytes do chaveiro)
  const semOperador = convertBridgeKeyRingBytes(B5F_BYTES);
  assert.notEqual(sha256Hex(enc(semOperador)), DISSERTACAO_FP);
  // o comando faz o mesmo
  const d = mkdtempSync(join(tmpdir(), 'otk-f4-'));
  const anel = join(d, 'otk_keyring_b5f.json'); writeFileSync(anel, B5F_BYTES);
  const out = join(d, 'chaveiro.json');
  const res = await runCli(['keyring', 'convert', anel, '--operator', 'OTK A2 C160', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, new RegExp(DISSERTACAO_FP));
  assert.match(res.stdout, new RegExp(B5F_SHA));
  assert.equal(sha256Hex(new Uint8Array(readFileSync(out))), DISSERTACAO_FP);
  const fp = await runCli(['keyring', 'fingerprint', anel]);
  assert.equal(fp.code, 0); assert.equal(fp.stdout.trim(), B5F_SHA);
  // a página/verify aceita o anel B5F direto: anchored com o sha do próprio arquivo
  const v = verifyBundle([], { name: 'otk_keyring_b5f.json', bytes: B5F_BYTES }, { fingerprint: B5F_SHA });
  assert.equal(v.keyring.anchor, 'anchored');
  const v2 = verifyBundle([], { name: 'chaveiro.json', bytes: enc(comOperador) }, { fingerprint: DISSERTACAO_FP });
  assert.equal(v2.keyring.anchor, 'anchored');
  assert.equal(v2.keyring.convertedFrom, undefined);
});

test('D2: formato desconhecido → "formato de chaveiro não reconhecido" (amarelo), nunca "foi mexido"', () => {
  const casos: Array<[string, string]> = [
    ['outro formato', JSON.stringify({ schema: 'outro.formato.v9', keys: KEYRING_ENTRIES })],
    ['sem campo de formato', JSON.stringify({ keys: KEYRING_ENTRIES })],
    ['lista solta', JSON.stringify(KEYRING_ENTRIES)],
    ['não é JSON', 'isto não é um chaveiro\n'],
  ];
  for (const [nome, txt] of casos) {
    const r = verifyBundle(vectors.files, { name: 'x.json', bytes: enc(txt) }, {});
    assert.equal(r.keyring.anchor, 'unknown_format', nome);
    assert.ok(r.keyring.error!.startsWith(UNKNOWN_KEYRING_FORMAT), nome);
    const it = r.items.find((i) => i.kind === 'keyring')!;
    assert.equal(it.code, 'keyring_unknown_format', nome);
    assert.equal(it.verdict, 'amarelo', nome);
    for (const t of [it.reasonPt, it.meaningPt, it.notGuaranteedPt, it.detail ?? '']) assert.doesNotMatch(t, /foi mexido|mexido ou/i, nome);
    assert.match(it.reasonPt, /Formato de chaveiro não reconhecido/);
    assert.match(renderHuman(r), /formato de chaveiro não reconhecido/);
  }
});

test('D2: anel do bot no meio dos recibos é reconhecido como chaveiro (ignorado), não como item desconhecido', () => {
  const r = verifyBundle([...vectors.files, { name: 'recibos/otk_keyring_b5f.json', bytes: B5F_BYTES }], keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.equal(r.inputs.find((i) => i.name === 'recibos/otk_keyring_b5f.json')!.format, 'keyring_ignored');
  assert.ok(!r.items.some((i) => i.source.file === 'recibos/otk_keyring_b5f.json'));
});

test('D3: nenhum texto para leigo usa o jargão "schema"; erros do chaveiro em português simples', () => {
  for (const [code, t] of Object.entries(TEXTOS)) {
    for (const s of [t.short, t.reason, t.meaning, t.notGuaranteed]) assert.doesNotMatch(s, /schema/i, code);
  }
  for (const s of NAO_GARANTE) assert.doesNotMatch(s, /schema/i);
  const ruins = [
    { schema: 'otk.keyring.public.v1', keys: [] },
    { schema: 'otk.keyring.public.v1', keys: [{ keyId: 'a', address: '0x12', status: 'active' }] },
    { schema: 'otk.keyring.public.v1', keys: [{ keyId: 'a', address: KEYRING_ENTRIES[0]!.address, status: 'perdida' }] },
    { schema: 'otk.keyring.public.v1', extra: 1, keys: KEYRING_ENTRIES },
  ];
  for (const v of ruins) {
    const r = verifyBundle([], { name: 'c.json', bytes: enc(JSON.stringify(v)) }, {});
    assert.equal(r.keyring.anchor, 'invalid');
    assert.doesNotMatch(r.keyring.error!, /schema|keys\[|\.address|\.status/i, r.keyring.error!);
    const it = r.items.find((i) => i.kind === 'keyring')!;
    assert.equal(it.code, 'keyring_invalid'); assert.equal(it.verdict, 'vermelho');
    assert.doesNotMatch(it.reasonPt + it.meaningPt, /schema|otk\.keyring/i);
  }
});

test('D3: sem recibo somado a saída do comando diz "CU desconhecida", nunca "CU 0"; o JSON não muda', () => {
  const r = verifyBundle([], keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.equal(r.summary.counted.counted, 0);
  assert.equal(r.summary.counted.cu.sum, '0', 'o relatório JSON fica como antes (paridade e vetores)');
  const h = renderHuman(r);
  assert.match(h, /CU somado: desconhecida/);
  assert.doesNotMatch(h, /CU somado: 0/);
  // com recibo somado, o número continua
  const a = verifyBundle(vectors.files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  assert.match(renderHuman(a), new RegExp(`CU somado: ${a.summary.counted.cu.sum!.replace('.', '\\.')}`));
});

test('caminho atual igual: chaveiro público dá os mesmos bytes de relatório de antes (sha dos vetores)', () => {
  const esp = JSON.parse(readFileSync(join(HERE, 'vetores', 'esperado.json'), 'utf8'));
  const com = verifyBundle(vectors.files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  const sem = verifyBundle(vectors.files, keyringFile(), {});
  assert.equal(reportSha256(com), esp.relatorioSha256.comImpressaoDigital);
  assert.equal(reportSha256(sem), esp.relatorioSha256.semImpressaoDigital);
  assert.ok(!('convertedFrom' in com.keyring), 'campo novo só aparece com o anel do bot');
  assert.ok(!serializeReport(com).includes('convertedFrom'));
});
