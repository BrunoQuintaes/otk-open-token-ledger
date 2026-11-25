/**
 * `otk receipts export` com um PostgreSQL SIMULADO em memória (nenhum banco real, nenhuma variável
 * de ambiente lida: o openPool é injetado) e `otk keyring export --history`.
 *
 * In English: tests the `otk receipts export` and `otk keyring export --history` subcommands of `scripts/verify/otk.ts`
 * (`runCli` with an injected database pool), against an in-memory database double that answers only the exporter's
 * two queries with the same filter (admission time window and tenant).
 *
 * Strategy / scenarios: period and tenant filtering, the `.jsonl` plus manifest output, and the verify command
 * accepting the exported folder (a tampered stored receipt is caught); the database option must be a variable NAME,
 * and a connection string is never accepted nor printed; a database error, including one while opening the
 * connection, exits with code 1 without echoing the driver message; an empty period yields an empty file and a
 * "no receipts" warning; the keyring history export includes retired and revoked keys, drops annotations and lets
 * `--key` override a key's status.
 *
 * Needs: temporary directories; no real database, no environment variable, no network.
 *
 * Run just this file: `npx tsx --test test/verifier/receipts_export.test.ts`
 *
 * @module test/verifier/receipts_export.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { encodeJson } from '../../src/operations/codec.js';
import { digestReceiptV3 } from '../../src/receipt/v3/receiptCrypto.js';
import { digestConferenceV1 } from '../../src/receipt/v3/receiptCrypto.js';
import { parsePublicKeyRing } from '../../src/verifier/index.js';
import { runCli, type CliDeps } from '../../scripts/verify/otk.js';
import { conferenceFixture } from '../fixtures/d1d8/a/receiptFixture.js';
import { KEYRING_FINGERPRINT, KEYRING_TEXT, prodReceipt, rc, TEST_KEYS } from './vetores.js';

interface RRow { tenant_id: string; operation_id: string; receipt_digest: string; receipt: Record<string, unknown>; envelope: unknown }
interface CRow { tenant_id: string; operation_id: string; report_digest: string; report: unknown; envelope: unknown }
const asJsonb = (v: unknown) => JSON.parse(encodeJson(v)) as Record<string, unknown>;

/**
 * Banco simulado: só as duas consultas do exportador, com o mesmo filtro (admittedAt, tenant).
 *
 * @param receipts - Stored receipt rows.
 * @param confs - Stored conference rows (returned for the receipts the receipt query selects).
 * @param opts - `failWith`: every query throws this error.
 * @returns The pool double, the list of query texts received and whether `end` was called.
 */
function fakePg(receipts: RRow[], confs: CRow[], opts: { failWith?: Error } = {}) {
  const calls: string[] = [];
  let ended = false;
  const match = (r: RRow, p: unknown[]) => {
    const at = String((r.receipt['timing'] as { admittedAt: string }).admittedAt);
    return at >= String(p[0]) && at < String(p[1]) && (p[2] === null || r.tenant_id === p[2]);
  };
  const pool = {
    async query(text: string, params: unknown[] = []) {
      calls.push(text);
      if (opts.failWith) throw opts.failWith;
      const sel = receipts.filter((r) => match(r, params)).sort((a, b) => (a.tenant_id + a.operation_id < b.tenant_id + b.operation_id ? -1 : 1));
      if (text.includes('FROM otk_conferences')) {
        const keys = new Set(sel.map((r) => `${r.tenant_id}/${r.operation_id}`));
        const rows = confs.filter((c) => keys.has(`${c.tenant_id}/${c.operation_id}`));
        return { rows: rows as never[], rowCount: rows.length };
      }
      return { rows: sel as never[], rowCount: sel.length };
    },
    async end() { ended = true; },
  };
  return { pool, calls, ended: () => ended };
}

async function seed() {
  const receipts: RRow[] = []; const confs: CRow[] = [];
  const add = async (op: string, at: string, tenant = 'tenant-test-a', tamper = false) => {
    const r = prodReceipt(op, { admittedAt: at });
    r.key.tenantId = tenant;
    const env = await rc.signReceipt(r);
    const stored = asJsonb(r);
    if (tamper) ((stored['usage'] as { categories: Array<{ count: string }> }).categories[0]!).count = '5000';
    receipts.push({ tenant_id: tenant, operation_id: `op-${op}`, receipt_digest: digestReceiptV3(r), receipt: stored, envelope: asJsonb(env) });
    return r;
  };
  const r1 = await add('pg-1', '2026-11-03T10:00:00.000Z');
  await add('pg-2', '2026-11-04T23:59:59.999Z');
  await add('pg-adulterado', '2026-11-04T12:00:00.000Z', 'tenant-test-a', true);
  await add('pg-outro-cliente', '2026-11-04T12:00:00.000Z', 'tenant-test-b');
  await add('pg-fora', '2026-11-05T00:00:00.000Z');
  const rep = conferenceFixture(digestReceiptV3(r1), { tenantId: 'tenant-test-a', operationId: 'op-pg-1' });
  const renv = await rc.signConference(rep);
  confs.push({ tenant_id: 'tenant-test-a', operation_id: 'op-pg-1', report_digest: digestConferenceV1(rep), report: asJsonb(rep), envelope: asJsonb(renv) });
  return { receipts, confs };
}

function deps(pool: ReturnType<typeof fakePg>['pool'], seen: string[] = []): CliDeps {
  return { async openPool(name) { seen.push(name); return pool; } };
}

test('receipts export: período e cliente filtrados, .jsonl + MANIFEST, e o verify aceita a pasta', async () => {
  const { receipts, confs } = await seed();
  const db = fakePg(receipts, confs);
  const seen: string[] = [];
  const out = join(mkdtempSync(join(tmpdir(), 'otk-export-')), 'exportados');
  const r = await runCli(['receipts', 'export', '--since', '2026-11-01', '--until', '2026-11-04', '--tenant', 'tenant-test-a', '--out', out, '--pg-env', 'OTK_TESTE_PG_URL'], false, deps(db.pool, seen));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen, ['OTK_TESTE_PG_URL']);
  assert.equal(db.ended(), true);
  const files = readdirSync(out).sort();
  assert.deepEqual(files, ['MANIFEST_2026-11-01_2026-11-04_tenant-test-a.json', 'recibos_2026-11-01_2026-11-04_tenant-test-a.jsonl']);
  const jsonl = readFileSync(join(out, files[1]!), 'utf8');
  const man = JSON.parse(readFileSync(join(out, files[0]!), 'utf8'));
  assert.equal(man.schema, 'otk.receipts_export_manifest.v1');
  assert.equal(man.recibos, 3); // pg-1, pg-2 (23:59:59.999 do último dia) e o adulterado; nem o outro cliente nem o do dia 5
  assert.equal(man.conferencias, 1);
  assert.equal(man.sha256, ethers.sha256(ethers.toUtf8Bytes(jsonl)).slice(2));
  // a pasta exportada é verificada como qualquer outra
  const kr = join(out, '..', 'chaveiro.json'); writeFileSync(kr, KEYRING_TEXT);
  const v = await runCli(['verify', out, '--keyring', kr, '--fingerprint', KEYRING_FINGERPRINT, '--json']);
  assert.equal(v.code, 20);
  const rep = JSON.parse(v.stdout);
  const byId = (id: string, kind = 'receipt') => rep.items.find((i: { id: string; kind: string }) => i.id === id && i.kind === kind);
  assert.equal(byId('tenant-test-a/op-pg-1').verdict, 'verde');
  assert.equal(byId('tenant-test-a/op-pg-2').verdict, 'verde');
  assert.equal(byId('tenant-test-a/op-pg-1', 'conference').verdict, 'verde');
  assert.equal(byId('tenant-test-a/op-pg-adulterado').code, 'digest_mismatch'); // alterado dentro do banco
  assert.equal(rep.inputs.find((i: { name: string }) => i.name.endsWith(files[0]!)).format, 'export_manifest');
});

test('receipts export: --pg-env tem de ser um NOME; a URL nunca é aceita nem impressa', async () => {
  const { receipts, confs } = await seed();
  const db = fakePg(receipts, confs);
  const seen: string[] = [];
  const out = mkdtempSync(join(tmpdir(), 'otk-export-'));
  const url = 'postgres://usuario:senha-de-teste@host-de-teste/db';
  const r = await runCli(['receipts', 'export', '--since', '2026-11-01', '--until', '2026-11-04', '--out', out, '--pg-env', url], false, deps(db.pool, seen));
  assert.equal(r.code, 2);
  assert.deepEqual(seen, []);
  assert.ok(!r.stderr.includes('senha-de-teste') && !r.stdout.includes('senha-de-teste'));
  for (const bad of [[], ['--since', '2026-11-05', '--until', '2026-11-04'], ['--since', '2026-11-01']]) {
    const x = await runCli(['receipts', 'export', ...bad, '--out', out, '--pg-env', 'OTK_X'], false, deps(db.pool, seen));
    assert.equal(x.code, 2);
  }
  assert.deepEqual(seen, []);
});

test('receipts export: erro do banco sai com código 1 sem repassar a mensagem do driver', async () => {
  const err = Object.assign(new Error('connection to host-de-teste user=usuario password=senha-de-teste failed'), { code: '28P01' });
  const db = fakePg([], [], { failWith: err });
  const r = await runCli(['receipts', 'export', '--since', '2026-11-01', '--until', '2026-11-04', '--out', mkdtempSync(join(tmpdir(), 'otk-export-')), '--pg-env', 'OTK_X'], false, deps(db.pool));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('28P01'));
  assert.ok(!/senha|password|host-de-teste|usuario/.test(r.stderr));
  assert.equal(db.ended(), true);
});

test('receipts export: período vazio gera .jsonl vazio e o verify diz "nenhum recibo" (amarelo)', async () => {
  const db = fakePg([], []);
  const out = join(mkdtempSync(join(tmpdir(), 'otk-export-')), 'vazio');
  const r = await runCli(['receipts', 'export', '--since', '2026-01-01', '--until', '2026-01-31', '--out', out, '--pg-env', 'OTK_X'], false, deps(db.pool));
  assert.equal(r.code, 0);
  const kr = join(out, '..', 'k.json'); writeFileSync(kr, KEYRING_TEXT);
  const v = await runCli(['verify', out, '--keyring', kr, '--fingerprint', KEYRING_FINGERPRINT, '--json']);
  assert.equal(v.code, 10);
  assert.equal(JSON.parse(v.stdout).items[0].code, 'no_receipts');
});

test('keyring export --history: inclui aposentadas e revogadas, descarta anotações, --key sobrepõe o estado', async () => {
  const d = mkdtempSync(join(tmpdir(), 'otk-hist-'));
  const hist = join(d, 'historico_chaves.json');
  writeFileSync(hist, JSON.stringify({ keys: [
    { keyId: 'teste-op-2026-09', address: TEST_KEYS.revoked.address, status: 'revoked', nota: 'vazou em 09/2026 (teste)' },
    { keyId: 'teste-op-2026-10', address: TEST_KEYS.retired.address, status: 'retired', retiredAt: '2026-11-10T00:00:00.000Z', nota: 'rotação' },
    { keyId: 'teste-op-2026-11', address: TEST_KEYS.op.address, status: 'active' },
  ] }));
  const out = join(d, 'chaveiro.json');
  const r = await runCli(['keyring', 'export', '--history', hist, '--operator', 'operador-de-teste', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const p = parsePublicKeyRing(new Uint8Array(readFileSync(out)));
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.file.keys.map((k) => k.status).sort(), ['active', 'retired', 'revoked']);
  assert.ok(!readFileSync(out, 'utf8').includes('nota'));
  // revogar a ativa agora, sem editar o histórico
  const out2 = join(d, 'chaveiro2.json');
  const r2 = await runCli(['keyring', 'export', '--history', hist, '--key', `teste-op-2026-11=${TEST_KEYS.op.address},revoked`, '--out', out2]);
  assert.equal(r2.code, 0, r2.stderr);
  const p2 = parsePublicKeyRing(new Uint8Array(readFileSync(out2)));
  assert.ok(p2.ok && p2.file.keys.find((k) => k.keyId === 'teste-op-2026-11')!.status === 'revoked');
  // histórico com aposentada sem data é recusado
  writeFileSync(hist, JSON.stringify([{ keyId: 'a', address: TEST_KEYS.retired.address, status: 'retired' }]));
  assert.equal((await runCli(['keyring', 'export', '--history', hist, '--out', join(d, 'x.json')])).code, 2);
  assert.equal((await runCli(['keyring', 'export', '--history', hist, '--from', hist, '--out', join(d, 'y.json')])).code, 2);
});

test('receipts export: erro ao ABRIR a conexão também sai só com o código (X1 R5)', async () => {
  const d: CliDeps = { async openPool() { throw Object.assign(new Error('getaddrinfo host-de-teste postgres://usuario:senha-de-teste@host-de-teste'), { code: 'ENOTFOUND' }); } };
  const r = await runCli(['receipts', 'export', '--since', '2026-11-01', '--until', '2026-11-04', '--out', mkdtempSync(join(tmpdir(), 'otk-export-')), '--pg-env', 'OTK_X'], false, d);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('ENOTFOUND'));
  assert.ok(!/senha|usuario|host-de-teste|postgres:/.test(r.stderr + r.stdout));
});
