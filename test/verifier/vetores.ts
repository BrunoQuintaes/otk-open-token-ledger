/**
 * Vetores de teste do verificador (VERIFICADOR_MVP, C160). Recibos assinados na hora com CHAVES DE
 * TESTE fixas e públicas (abaixo): nunca uma chave real. A assinatura ECDSA do ethers é determinística
 * (RFC 6979), então o mesmo código gera os mesmos bytes — e o mesmo sha256 do relatório.
 *
 * Cada caso usa uma operação própria (op-<caso>) para que as asserções sejam por id.
 *
 * In English: builds the test vectors of the offline receipt verifier (`src/verifier`). Receipts are signed on the
 * fly with fixed, public TEST keys (never a real key); because ethers' ECDSA signatures are deterministic (RFC 6979),
 * the same code always yields the same bytes and the same report sha256. Each case uses its own operation id
 * (`op-<case>`) so assertions can address items by id. The cases cover a valid receipt and an identical duplicate,
 * eight kinds of tampering, format errors, envelope and key problems (wrong domain, unknown, revoked and retired
 * keys, forged or altered dates, signer address vs declared key id), conference reports, store-level problems
 * (declared vs recomputed digest, conflicts, invalid JSON, a truncated last line), codec edge cases, content
 * warnings, a conference export with a misleading operator verdict, legacy formats and a few summary variations.
 *
 * Imported by `gera_vetores.ts`, `verificador.test.ts`, `receipts_export.test.ts` and the web verifier's vector
 * generator. Pure computation:
 * nothing is written to disk and nothing goes to the network.
 *
 * @module test/verifier/vetores
 */
import { ethers } from 'ethers';
import { createReceiptCrypto, digestReceiptV3, envelopeDigest } from '../../src/receipt/v3/receiptCrypto.js';
import { createKeyRing } from '../../src/receipt/v3/keyRing.js';
import { encodeJson } from '../../src/operations/codec.js';
import { hashCanonicalReceiptV1 } from '../../src/receipt/canonicalReceiptV1.js';
import { serializePublicKeyRing } from '../../src/verifier/index.js';
import type { InputFile, PublicKeyEntry } from '../../src/verifier/index.js';
import type { PrivateReceiptV3, SignedEnvelope } from '../../src/types/d1d8/index.js';
import { conferenceFixture, receiptFixture } from '../fixtures/d1d8/a/receiptFixture.js';

// CHAVES DE TESTE (públicas, sem valor; só para os vetores)
/**
 * Fixed TEST wallets: `op` (active operator key), `retired`, `revoked` and `outsider` (not in the keyring). Their
 * private keys are repeated-byte constants and therefore public; never use them for anything real.
 */
export const TEST_KEYS = {
  op: new ethers.Wallet('0x' + '11'.repeat(32)),
  retired: new ethers.Wallet('0x' + '22'.repeat(32)),
  revoked: new ethers.Wallet('0x' + '33'.repeat(32)),
  outsider: new ethers.Wallet('0x' + '44'.repeat(32)),
};
const CIRCUIT = 'metering_v3@sha256:test';
/** Instant (ISO 8601, UTC) at which the `retired` test key stopped being valid for new signatures. */
export const RETIRED_AT = '2026-11-10T00:00:00.000Z';

/** Public keyring of the test operator: one active, one retired (at {@link RETIRED_AT}) and one revoked key. */
export const KEYRING_ENTRIES: PublicKeyEntry[] = [
  { keyId: 'teste-op-2026-11', address: TEST_KEYS.op.address, status: 'active' },
  { keyId: 'teste-op-2026-10', address: TEST_KEYS.retired.address, status: 'retired', retiredAt: RETIRED_AT },
  { keyId: 'teste-op-2026-09', address: TEST_KEYS.revoked.address, status: 'revoked' },
];
/** The test keyring serialized exactly as the verifier expects `chaveiro.json` (the fingerprint is over these bytes). */
export const KEYRING_TEXT = serializePublicKeyRing({ schema: 'otk.keyring.public.v1', operator: 'operador-de-teste', keys: KEYRING_ENTRIES });
/**
 * Wraps {@link KEYRING_TEXT} as a verifier input file named `chaveiro.json`.
 *
 * @returns A new input file object on each call.
 */
export const keyringFile = (): InputFile => ({ name: 'chaveiro.json', bytes: new TextEncoder().encode(KEYRING_TEXT) });

const ring = createKeyRing(KEYRING_ENTRIES.map((k) => ({ ...k, address: k.address as `0x${string}` })));
const SIGNED_AT = '2026-11-05T12:00:03.000Z';
/** Receipt signer of the test operator (active key, clock fixed at the signing instant), so signatures repeat. */
export const rc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'teste-op-2026-11', wallet: TEST_KEYS.op }, now: () => new Date(SIGNED_AT) });

/**
 * Recibo de produção (sem perfil de desenvolvimento), de modo que o caso válido possa ser verde.
 *
 * A production-profile receipt, so that the valid case can be green.
 *
 * @param op - Case name; the operation id becomes `op-<op>`.
 * @param o - Optional overrides: `admittedAt` (ISO 8601), `model` (requested and returned), `provider`, and `cu`
 *   (CU units at scale 1; default from the base fixture).
 * @returns A new, mutable unsigned receipt.
 */
export function prodReceipt(op: string, o: { admittedAt?: string; model?: string; provider?: string; cu?: bigint } = {}): PrivateReceiptV3 {
  const r = receiptFixture({ circuitId: CIRCUIT, operationId: `op-${op}`, admittedAt: o.admittedAt ?? '2026-11-05T12:00:00.000Z', publicCommitment: '123', cuUnits: o.cu });
  r.config.developmentProfile = false;
  r.cu.developmentProfile = false;
  if (o.model) { r.usage.modelReturned = o.model; r.usage.modelRequested = o.model; }
  if (o.provider) { r.provider = o.provider; r.usage.provider = o.provider; }
  return r;
}

/**
 * Signs a receipt envelope with an arbitrary wallet and declared key id, bypassing the keyring (used to build forged,
 * revoked, retired and mismatched-signer cases).
 *
 * @param wallet - Signing wallet.
 * @param keyId - Key id written in the envelope (need not match the wallet).
 * @param r - Receipt whose digest is signed.
 * @param signedAt - Declared signing instant (ISO 8601); defaults to the fixed signing instant.
 * @param domain - Envelope domain; defaults to the private receipt domain.
 * @returns The signed envelope.
 */
export async function signWith(wallet: ethers.Wallet, keyId: string, r: PrivateReceiptV3, signedAt = SIGNED_AT, domain: SignedEnvelope['domain'] = 'OTK_PRIVATE_RECEIPT_V3'): Promise<SignedEnvelope> {
  const unsigned = { schema: 'otk.envelope.v1' as const, domain, payloadDigest: digestReceiptV3(r), alg: 'eip191-secp256k1' as const, signer: wallet.address as `0x${string}`, keyId, signedAt };
  const signature = (await wallet.signMessage(ethers.getBytes(envelopeDigest(unsigned)))) as `0x${string}`;
  return { ...unsigned, signature };
}

/**
 * Encodes one receipt-store line (`kind: 'receipt'`) as the operation store writes it.
 *
 * @param receipt - Receipt object (possibly tampered).
 * @param envelope - Signed envelope (possibly altered).
 * @param digest - Declared digest; defaults to the digest recomputed from `receipt`.
 * @returns One line of JSON text (bigints encoded as text by the codec), without a trailing newline.
 */
export const storeLine = (receipt: unknown, envelope: unknown, digest?: string): string =>
  encodeJson({ kind: 'receipt', digest: digest ?? digestReceiptV3(receipt as PrivateReceiptV3), envelope, receipt });

const mutate = (r: PrivateReceiptV3, f: (x: PrivateReceiptV3) => void): PrivateReceiptV3 => { const c = structuredClone(r); f(c); return c; };

/**
 * Expected verifier outcome for one item: its id (`<tenant>/<operation>` or `<file>#<line>`), the verdict
 * (`verde` = valid, `amarelo` = warning or unsupported, `vermelho` = invalid), the reason code and, when relevant,
 * the item kind.
 */
export interface Expect { id: string; verdict: 'verde' | 'amarelo' | 'vermelho'; code: string; kind?: string }

/**
 * Conjunto completo: arquivos + o veredito esperado de cada item.
 *
 * @returns The input files (under `recibos/`, including a non-receipt file and a copy of the keyring) and the
 *   expected outcome of each item, in a fixed order.
 */
export async function buildVectors(): Promise<{ files: InputFile[]; expect: Expect[] }> {
  const lines: Record<string, string[]> = {};
  const add = (file: string, line: string) => { (lines[file] ??= []).push(line); };
  const expect: Expect[] = [];
  const T = 'tenant-test-a';

  // 1. válido
  const ok = prodReceipt('valido');
  add('recibos/a_validos.jsonl', storeLine(ok, await rc.signReceipt(ok)));
  expect.push({ id: `${T}/op-valido`, verdict: 'verde', code: 'ok' });
  // duplicata idêntica em outro arquivo (não soma duas vezes)
  add('recibos/z_copias.jsonl', storeLine(ok, await rc.signReceipt(ok)));

  // 2. os 8 tipos de alteração já testados (test/unit/d1d8_a_receipt_crypto.test.ts)
  const alter: Array<[string, (x: PrivateReceiptV3) => void, string]> = [
    ['contagem', (x) => { x.usage.categories[0]!.count = 101n; }, 'op-alt-contagem'],
    ['ausente-zero', (x) => { x.usage.categories[2]!.count = 0n; }, 'op-alt-ausente-zero'],
    ['tenant', (x) => { x.key.tenantId = 'tenant-test-b'; }, 'op-alt-tenant'],
    ['operacao', (x) => { x.key.operationId = 'op-alt-operacao-trocada'; }, 'op-alt-operacao-trocada'],
    ['compromisso', (x) => { x.publicCommitment = '124'; }, 'op-alt-compromisso'],
    ['pesos-cu', (x) => { x.config.cuWeights.version = 'cw-test-2026-09-30.2'; }, 'op-alt-pesos-cu'],
    ['cu-exato', (x) => { x.cu.cu = { units: 121n, scale: 1n }; }, 'op-alt-cu-exato'],
    ['origem', (x) => { x.source = 'client_declared'; }, 'op-alt-origem'],
  ];
  for (const [name, f, opId] of alter) {
    const r = prodReceipt(`alt-${name}`);
    const env = await rc.signReceipt(r);
    const bad = mutate(r, f);
    // a linha guarda o resumo do original (como o store gravou), o recibo vem alterado
    add('recibos/b_alterados.jsonl', storeLine(bad, env, env.payloadDigest));
    const tenant = name === 'tenant' ? 'tenant-test-b' : T;
    expect.push({ id: `${tenant}/${opId}`, verdict: 'vermelho', code: 'digest_mismatch' });
  }

  // 3. schema trocado e contentDigests preenchido
  {
    const r = prodReceipt('schema'); const env = await rc.signReceipt(r);
    const bad = mutate(r, (x) => { (x as { schema: string }).schema = 'otk.receipt.v2'; });
    add('recibos/c_formato.jsonl', storeLine(bad, env, env.payloadDigest));
    expect.push({ id: `${T}/op-schema`, verdict: 'amarelo', code: 'unsupported_version' });
    const r2 = prodReceipt('conteudo'); const env2 = await rc.signReceipt(r2);
    const bad2 = mutate(r2, (x) => { (x as { contentDigests: unknown }).contentDigests = { prompt: '0x00' }; });
    add('recibos/c_formato.jsonl', storeLine(bad2, env2, env2.payloadDigest));
    expect.push({ id: `${T}/op-conteudo`, verdict: 'vermelho', code: 'malformed' });
  }

  // 4. envelope: domínio, chave desconhecida, data alterada, forjada, revogada, aposentada antes/depois, data fora do formato
  {
    const r = prodReceipt('dominio'); const env = await rc.signReceipt(r);
    add('recibos/d_chaves.jsonl', storeLine(r, { ...env, domain: 'OTK_CONFERENCE_V1' }));
    expect.push({ id: `${T}/op-dominio`, verdict: 'vermelho', code: 'wrong_domain' });
  }
  {
    const r = prodReceipt('chave-fora'); const env = await signWith(TEST_KEYS.outsider, 'outra-chave', r);
    add('recibos/d_chaves.jsonl', storeLine(r, env));
    expect.push({ id: `${T}/op-chave-fora`, verdict: 'amarelo', code: 'unauthorized_signer' });
  }
  {
    const r = prodReceipt('data-alterada'); const env = await rc.signReceipt(r);
    add('recibos/d_chaves.jsonl', storeLine(r, { ...env, signedAt: '2026-11-05T12:00:04.000Z' }));
    expect.push({ id: `${T}/op-data-alterada`, verdict: 'vermelho', code: 'bad_signature' });
  }
  {
    const r = prodReceipt('forjada'); const env = await rc.signReceipt(r);
    const forged = { ...env, signature: (await TEST_KEYS.outsider.signMessage(ethers.getBytes(envelopeDigest(env)))) as `0x${string}` };
    add('recibos/d_chaves.jsonl', storeLine(r, forged));
    expect.push({ id: `${T}/op-forjada`, verdict: 'vermelho', code: 'bad_signature' });
  }
  {
    const r = prodReceipt('revogada'); const env = await signWith(TEST_KEYS.revoked, 'teste-op-2026-09', r);
    add('recibos/d_chaves.jsonl', storeLine(r, env));
    expect.push({ id: `${T}/op-revogada`, verdict: 'vermelho', code: 'revoked_key' });
  }
  {
    const r = prodReceipt('aposentada-antes'); const env = await signWith(TEST_KEYS.retired, 'teste-op-2026-10', r, '2026-11-09T23:59:59.999Z');
    add('recibos/d_chaves.jsonl', storeLine(r, env));
    expect.push({ id: `${T}/op-aposentada-antes`, verdict: 'amarelo', code: 'retired_key_before_date' });
    const r2 = prodReceipt('aposentada-depois'); const env2 = await signWith(TEST_KEYS.retired, 'teste-op-2026-10', r2, '2026-11-10T00:00:00.001Z');
    add('recibos/d_chaves.jsonl', storeLine(r2, env2));
    expect.push({ id: `${T}/op-aposentada-depois`, verdict: 'vermelho', code: 'revoked_key' });
  }
  {
    const r = prodReceipt('data-formato'); const env = await rc.signReceipt(r);
    add('recibos/d_chaves.jsonl', storeLine(r, { ...env, signedAt: '2026-11-05 12:00:03' }));
    expect.push({ id: `${T}/op-data-formato`, verdict: 'vermelho', code: 'malformed' });
  }

  // 4b. X1 (B2): a decisão é pelo endereço que assinou, não pelo keyId declarado
  {
    const b2: Array<[string, ethers.Wallet, string, string, string, boolean]> = [
      // [caso, carteira que assina, keyId declarado, signedAt, código esperado, recibo alterado?]
      ['x1-revogada-keyid-ativa', TEST_KEYS.revoked, 'teste-op-2026-11', SIGNED_AT, 'revoked_key', false],
      ['x1-revogada-keyid-inventado', TEST_KEYS.revoked, 'chave-inventada', SIGNED_AT, 'revoked_key', false],
      ['x1-aposentada-depois-keyid-inventado', TEST_KEYS.retired, 'chave-inventada', '2026-11-10T00:00:00.001Z', 'revoked_key', false],
      ['x1-aposentada-depois-keyid-ativa', TEST_KEYS.retired, 'teste-op-2026-11', '2026-11-10T00:00:00.001Z', 'revoked_key', false],
      ['x1-fora-keyid-ativa', TEST_KEYS.outsider, 'teste-op-2026-11', SIGNED_AT, 'bad_signature', false],
      ['x1-alterado-fora-keyid-ativa', TEST_KEYS.outsider, 'teste-op-2026-11', SIGNED_AT, 'bad_signature', true],
      ['x1-alterado-revogada-keyid-inventado', TEST_KEYS.revoked, 'chave-inventada', SIGNED_AT, 'revoked_key', true],
      ['x1-ativa-keyid-aposentada', TEST_KEYS.op, 'teste-op-2026-10', SIGNED_AT, 'bad_signature', false],
    ];
    for (const [nm, wallet, keyId, at, code, altered] of b2) {
      const r = prodReceipt(nm);
      if (altered) r.usage.categories[0]!.count = 1_000_000n; // alterado e reassinado
      add('recibos/n_x1.jsonl', storeLine(r, await signWith(wallet, keyId, r, at)));
      expect.push({ id: `${T}/op-${nm}`, verdict: 'vermelho', code });
    }
    // envelope.signer trocado sem reassinar, keyId da ativa
    const r = prodReceipt('x1-signer-trocado'); const env = await rc.signReceipt(r);
    add('recibos/n_x1.jsonl', storeLine(r, { ...env, signer: TEST_KEYS.outsider.address }));
    expect.push({ id: `${T}/op-x1-signer-trocado`, verdict: 'vermelho', code: 'bad_signature' });
    // B1: alterado + envelope.alg trocado, resumo da linha recalculado: amarelo, mas fora das somas
    const a = prodReceipt('x1-alg-trocado'); const ea = await rc.signReceipt(a);
    a.usage.categories[0]!.count = 1_000_000n;
    add('recibos/n_x1.jsonl', storeLine(a, { ...ea, alg: 'eip191-secp256k1x', payloadDigest: digestReceiptV3(a) }));
    expect.push({ id: `${T}/op-x1-alg-trocado`, verdict: 'amarelo', code: 'unsupported_version' });
  }

  // 5. conferência válida e conferência movida para outro recibo (vínculo trocado)
  {
    const r1 = prodReceipt('conf-1'); const r2 = prodReceipt('conf-2');
    add('recibos/e_conferencia.jsonl', storeLine(r1, await rc.signReceipt(r1)));
    add('recibos/e_conferencia.jsonl', storeLine(r2, await rc.signReceipt(r2)));
    expect.push({ id: `${T}/op-conf-1`, verdict: 'verde', code: 'ok' }, { id: `${T}/op-conf-2`, verdict: 'verde', code: 'ok' });
    const rep = conferenceFixture(digestReceiptV3(r1), { tenantId: T, operationId: 'op-conf-1' });
    const renv = await rc.signConference(rep);
    add('recibos/e_conferencia.jsonl', encodeJson({ kind: 'conference', digest: renv.payloadDigest, envelope: renv, report: rep }));
    // a mesma conferência assinada apresentada como sendo do recibo 2 (chave trocada, resumo do 1)
    const moved = structuredClone(rep); moved.key = { tenantId: T, operationId: 'op-conf-2' };
    const menv = await rc.signConference(moved);
    add('recibos/e_conferencia.jsonl', encodeJson({ kind: 'conference', digest: menv.payloadDigest, envelope: menv, report: moved }));
    expect.push({ id: `${T}/op-conf-1`, kind: 'conference', verdict: 'verde', code: 'ok' });
    expect.push({ id: `${T}/op-conf-2`, kind: 'conference', verdict: 'vermelho', code: 'binding_mismatch' });
  }

  // 6. resumo declarado ≠ recalculado; conflito (mesma chave, dois recibos); JSON inválido no meio; última linha cortada
  {
    const r = prodReceipt('resumo-declarado'); const env = await rc.signReceipt(r);
    add('recibos/f_arquivo.jsonl', storeLine(r, env, '0x' + 'ab'.repeat(32)));
    expect.push({ id: `${T}/op-resumo-declarado`, verdict: 'vermelho', code: 'declared_digest_mismatch' });
    const c1 = prodReceipt('conflito'); const c2 = prodReceipt('conflito', { cu: 999n });
    add('recibos/f_arquivo.jsonl', storeLine(c1, await rc.signReceipt(c1)));
    add('recibos/f_arquivo.jsonl', '{"kind":"receipt", isto não é json');
    add('recibos/f_arquivo.jsonl', storeLine(c2, await rc.signReceipt(c2)));
    expect.push({ id: `${T}/op-conflito`, verdict: 'vermelho', code: 'conflict' });
    expect.push({ id: 'recibos/f_arquivo.jsonl#3', verdict: 'vermelho', code: 'invalid_json' });
  }

  // 7. codec: bigint como texto (normal), número JS no lugar do texto, "1e3", ""
  {
    const r = prodReceipt('codec-numero'); const env = await rc.signReceipt(r);
    const asNumber = JSON.parse(storeLine(r, env)) as { receipt: { usage: { categories: Array<{ count: unknown }> } } };
    asNumber.receipt.usage.categories[0]!.count = 100; // número JS com o mesmo valor
    add('recibos/g_codec.jsonl', JSON.stringify(asNumber));
    expect.push({ id: `${T}/op-codec-numero`, verdict: 'verde', code: 'ok' });
    for (const [nm, val] of [['codec-1e3', '1e3'], ['codec-vazio', '']] as const) {
      const x = prodReceipt(nm); const e = await rc.signReceipt(x);
      const j = JSON.parse(storeLine(x, e)) as { receipt: { usage: { categories: Array<{ count: unknown }> } } };
      j.receipt.usage.categories[0]!.count = val;
      add('recibos/g_codec.jsonl', JSON.stringify(j));
      expect.push({ id: `${T}/op-${nm}`, verdict: 'vermelho', code: 'codec_error' });
    }
    const big = prodReceipt('codec-grande'); const be = await rc.signReceipt(big);
    const jb = JSON.parse(storeLine(big, be)) as { receipt: { usage: { categories: Array<{ count: unknown }> } } };
    jb.receipt.usage.categories[0]!.count = 1e21; // número fora do inteiro seguro: recusado, nunca arredondado
    add('recibos/g_codec.jsonl', JSON.stringify(jb));
    expect.push({ id: `${T}/op-codec-grande`, verdict: 'vermelho', code: 'codec_error' });
  }

  // 8. avisos de conteúdo: perfil de desenvolvimento, uso incompleto, declarado pelo cliente
  {
    const d = receiptFixture({ circuitId: CIRCUIT, operationId: 'op-dev', admittedAt: '2026-11-06T09:00:00.000Z' });
    add('recibos/h_avisos.jsonl', storeLine(d, await rc.signReceipt(d)));
    expect.push({ id: `${T}/op-dev`, verdict: 'amarelo', code: 'development_profile' });
    const p = prodReceipt('parcial'); p.usage.completeness = 'partial';
    add('recibos/h_avisos.jsonl', storeLine(p, await rc.signReceipt(p)));
    expect.push({ id: `${T}/op-parcial`, verdict: 'amarelo', code: 'usage_incomplete' });
    const c = prodReceipt('declarado'); c.source = 'client_declared';
    add('recibos/h_avisos.jsonl', storeLine(c, await rc.signReceipt(c)));
    expect.push({ id: `${T}/op-declarado`, verdict: 'amarelo', code: 'source_not_observed' });
  }

  // 9. exportação otk.conference_export.v1 com recibo alterado e "verification" mentirosa do operador
  {
    const r = prodReceipt('export', { model: 'gpt-4o', admittedAt: '2026-10-20T08:00:00.000Z' }); const env = await rc.signReceipt(r);
    const bad = mutate(r, (x) => { x.usage.categories[1]!.count = 2n; });
    const exp = {
      ok: true, schema: 'otk.conference_export.v1', operationId: 'op-export',
      receipt: { digest: env.payloadDigest, payload: bad, envelope: env },
      conference: { state: 'not_produced', verdict: 'not_applicable' },
      verification: { receipt: { ok: true, signer: TEST_KEYS.op.address, keyId: 'teste-op-2026-11' }, conference: null },
      note: 'teste',
    };
    add('recibos/i_exportacao.json', encodeJson(exp));
    expect.push({ id: `${T}/op-export`, verdict: 'vermelho', code: 'digest_mismatch' });
    const r2 = prodReceipt('export-ok', { model: 'gpt-4o', admittedAt: '2026-10-21T08:00:00.000Z' }); const env2 = await rc.signReceipt(r2);
    add('recibos/j_exportacao_ok.json', encodeJson({ ok: true, schema: 'otk.conference_export.v1', operationId: 'op-export-ok', receipt: { digest: env2.payloadDigest, payload: r2, envelope: env2 }, conference: { state: 'not_produced', verdict: 'not_applicable' }, verification: null }));
    expect.push({ id: `${T}/op-export-ok`, verdict: 'verde', code: 'ok' });
  }

  // 10. legado OTK_RECEIPT_V1 (assinado pela chave ativa) e v2 (não suportado nesta versão); item desconhecido
  {
    const v1 = { provider: 'openai', model: 'gpt-4o', input_tokens: 100n, output_tokens: 20n, total_tokens: 120n, latency_ms: 900n, cost_unit: 120n, user_id: 'u-42', project_id: 'p-1', timestamp: 1790000000000n, nonce: 0n, epoch: 497222n };
    const h = hashCanonicalReceiptV1(v1);
    const s = await TEST_KEYS.op.signMessage(ethers.getBytes(h));
    add('recibos/k_legado.json', encodeJson([
      { format: 'otk_receipt_v1', payload: v1, signature: { rawHash: h, signature: s } },
      { format: 'otk_receipt_v2', payload: v1, signature: { signature: s } },
      { qualquer: 'coisa' },
    ]));
    expect.push({ id: 'recibos/k_legado.json#1', verdict: 'amarelo', code: 'legacy_format' });
    expect.push({ id: 'recibos/k_legado.json#2', verdict: 'amarelo', code: 'legacy_unsupported' });
    expect.push({ id: 'recibos/k_legado.json#3', verdict: 'amarelo', code: 'unrecognized_record' });
  }

  // 11. outro provedor/modelo e outro mês, para o resumo
  {
    const r = prodReceipt('anthropic', { provider: 'anthropic', model: 'claude-test', admittedAt: '2026-10-02T10:00:00.000Z', cu: 300n });
    add('recibos/l_outro.jsonl', storeLine(r, await rc.signReceipt(r)));
    expect.push({ id: `${T}/op-anthropic`, verdict: 'verde', code: 'ok' });
  }

  // última linha cortada (sem "\n" no fim) num arquivo próprio
  const files: InputFile[] = Object.entries(lines).map(([name, ls]) => ({ name, bytes: new TextEncoder().encode(ls.join('\n') + '\n') }));
  {
    const r = prodReceipt('cortado'); const full = storeLine(r, await rc.signReceipt(r));
    const r0 = prodReceipt('antes-do-corte'); const first = storeLine(r0, await rc.signReceipt(r0));
    files.push({ name: 'recibos/m_cortado.jsonl', bytes: new TextEncoder().encode(first + '\n' + full.slice(0, Math.floor(full.length / 2))) });
    expect.push({ id: `${T}/op-antes-do-corte`, verdict: 'verde', code: 'ok' });
    expect.push({ id: 'recibos/m_cortado.jsonl#2', verdict: 'amarelo', code: 'truncated_line' });
  }
  // um arquivo que não é recibo e o próprio chaveiro arrastado junto
  files.push({ name: 'recibos/LEIA.txt', bytes: new TextEncoder().encode('não é recibo') });
  files.push({ name: 'recibos/chaveiro.json', bytes: new TextEncoder().encode(KEYRING_TEXT) });
  return { files, expect };
}

/** Impressão digital do chaveiro de teste (sha256 dos bytes). */
export const KEYRING_FINGERPRINT = ethers.sha256(new TextEncoder().encode(KEYRING_TEXT)).slice(2);
