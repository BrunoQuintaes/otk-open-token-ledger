/**
 * Fixtures de diálogos sintéticos para as outras frentes do B2 (INTERFACES.md §9): `fixtures/dialogs.testseed.json` guarda 1 diálogo S3 e 1 S2
 * gerados com a semente de TESTE e prefixo parametrizável. Este teste regenera e exige igualdade (a fixture não pode ficar velha);
 * `H2C_WRITE_FIXTURES=1 tsx --test .../fixtures_sync.test.ts` reescreve o arquivo (só quando o gerador muda de propósito).
 *
 * English summary: guards the shared dialog fixture `test/h2eval/cache/fixtures/dialogs.testseed.json` (one
 * hit-attempt dialog and one no-hit control dialog built with the test seed). The test rebuilds the fixture from
 * the dialog generator and fails when the file on disk differs, so other test folders never read a stale fixture.
 *
 * Module under test: `scripts/h2eval/cache/dialogs.ts` (`makeDialog`, `contentOf`, `renderCall`).
 *
 * Strategy: a single regenerate-and-compare check (canonical-JSON sha256 of the rebuilt fixture against the file),
 * plus the arms and the minimum prefix length of the stored dialogs.
 *
 * Needs: read access to the fixture file. Environment variable read: `H2C_WRITE_FIXTURES` (when `1`, the test first
 * rewrites the fixture file, so only set it when the generator changed on purpose).
 *
 * Run just this file: `npx tsx --test test/h2eval/cache/fixtures_sync.test.ts`
 *
 * @module test/h2eval/cache/fixtures_sync.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentOf, makeDialog, renderCall } from '../../../scripts/h2eval/cache/dialogs.js';
import { canonicalJson, sha256Hex } from '../../../scripts/h2eval/corpus/util.js';
import { TEST_SEED } from './helpers.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialogs.testseed.json');
const PREFIX_CHARS = 19000; // ≈ 4 500 tokens (o200k) / 5 200 (cl100k); parametrizável

function build() {
  const s3 = makeDialog(TEST_SEED, 'S3_HITATTEMPT', 'CONFIRMATORY', 0, 'train', PREFIX_CHARS); const s2 = makeDialog(TEST_SEED, 'S2_NOHIT', 'CONFIRMATORY', 0, 'train', PREFIX_CHARS);
  const calls = (d: typeof s3) => ([1, 2, 3] as const).map((k) => ({ call: k, promptSha256: contentOf(d, k).promptSha256, bodySha256: { anthropic: renderCall(d, k, { provider: 'anthropic', model: 'claude-haiku-4-5', maxOutputTokens: 24 }).bodySha256, openai: renderCall(d, k, { provider: 'openai', model: 'gpt-4o-mini', maxOutputTokens: 24 }).bodySha256, google: renderCall(d, k, { provider: 'google', model: 'gemini-3.5-flash-lite', maxOutputTokens: 24 }).bodySha256 } }));
  return { schema: 'h2eval.cache.fixture.dialogs.v1', note: 'SINTÉTICO, semente de TESTE (não é a semente do estudo); prefixo parametrizável por prefixChars', seed: TEST_SEED, prefixChars: PREFIX_CHARS, dialogs: [s3, s2].map((d) => ({ dialog: d, calls: calls(d) })) };
}

test('fixture dialogs.testseed.json acompanha o gerador (regenera e compara)', () => {
  const fx = build();
  if (process.env['H2C_WRITE_FIXTURES'] === '1') { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(fx, null, 1) + '\n'); }
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')) as typeof fx;
  assert.equal(sha256Hex(canonicalJson(onDisk)), sha256Hex(canonicalJson(fx)), 'fixture velha: regenerar com H2C_WRITE_FIXTURES=1');
  assert.equal(onDisk.dialogs[0]!.dialog.arm, 'S3_HITATTEMPT'); assert.equal(onDisk.dialogs[1]!.dialog.arm, 'S2_NOHIT'); assert.ok(onDisk.dialogs.every((x) => x.dialog.prefix.length >= 18000));
});
