/**
 * Passo 7: conciliação a partir de recibos verificados (só verdes e amarelos entram).
 *
 * In English: reconciliation against the provider's statement using only verified receipts.
 *
 * Under test: `loadOtkFromVerifiedReceipts` in `scripts/verify/receiptsToOtk.ts` (which receipts become usage records,
 * which are excluded and why: failed verification, duplicates, another provider), and the reconciliation command
 * `scripts/reconciliation/reconcile.ts` with `--otk-receipts`, run as a child process on the committed vectors and a
 * fixture statement; without a keyring it must stop with a usage error (exit 2).
 *
 * Needs: the committed vector folder `test/verifier/vetores/` and the reconciliation fixture (read only), `tsx` under
 * `node_modules`, and a temporary output directory. Paths are relative, so run from the repository root. No network.
 *
 * Run just this file: `npx tsx --test test/verifier/conciliacao.test.ts`
 *
 * @module test/verifier/conciliacao.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOtkFromVerifiedReceipts } from '../../scripts/verify/receiptsToOtk.js';
import { buildVectors, KEYRING_FINGERPRINT, keyringFile } from './vetores.js';

const W = { provider: 'openai' as const, start: '2026-09-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };

test('loadOtkFromVerifiedReceipts: vermelhos, cópias e outro provedor ficam fora, com o motivo', async () => {
  const { files } = await buildVectors();
  const r = loadOtkFromVerifiedReceipts(files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT }, W);
  assert.ok(r.records.length > 0);
  assert.ok(r.records.every((x) => x.source === 'verified_receipt_v3' && x.provider === 'openai' && x.confirmedMoney === null));
  const ids = new Set(r.records.map((x) => `${x.tenantId}/${x.operationId}`));
  assert.ok(ids.has('tenant-test-a/op-valido'));
  for (const bad of ['tenant-test-a/op-alt-contagem', 'tenant-test-a/op-revogada', 'tenant-test-a/op-conflito', 'tenant-test-a/op-export']) {
    assert.ok(!ids.has(bad), bad);
    assert.ok(r.excluded.some((e) => e.id === bad && /reprovado/.test(e.reason)), bad);
  }
  assert.ok(r.excluded.some((e) => e.id === 'tenant-test-a/op-anthropic' && /provedor anthropic/.test(e.reason)));
  assert.ok(r.excluded.some((e) => e.id === 'tenant-test-a/op-valido' && /cópia/.test(e.reason)));
  const ok = r.records.find((x) => x.operationId === 'op-valido')!;
  // input 100 sem cache conhecido; output 20
  assert.deepEqual(ok.quantities.map((q) => [q.category, q.count]), [['input', 100n], ['output', 20n]]);
  assert.match(r.description, /reprovados/);
});

test('reconcile.ts --otk-receipts: roda com os vetores e registra o sha256 do relatório do verificador', () => {
  const d = mkdtempSync(join(tmpdir(), 'otk-recon-rec-'));
  const V = 'test/verifier/vetores';
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/reconciliation/reconcile.ts',
    '--provider=openai', '--origin=FIXTURE',
    '--statement=test/fixtures/reconciliation/fixture_openai_usage_completions.json', '--mapping=openai_usage_completions_json',
    `--otk-receipts=${V}/recibos`, `--keyring=${V}/chaveiro.json`, `--fingerprint=${KEYRING_FINGERPRINT}`,
    '--window-start=2026-09-01T00:00:00Z', '--window-end=2026-12-01T00:00:00Z', `--out-dir=${d}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified receipts: \d+ used, \d+ rejected/);
  const out = readdirSync(d).find((f) => f.endsWith('.json'))!;
  assert.match(readFileSync(join(d, out), 'utf8'), /recibos v3 verificados/);
  // recibos sem chaveiro: erro de uso
  const no = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/reconciliation/reconcile.ts', '--provider=openai', '--origin=FIXTURE',
    '--statement=test/fixtures/reconciliation/fixture_openai_usage_completions.json', '--mapping=openai_usage_completions_json',
    `--otk-receipts=${V}/recibos`, '--window-start=2026-09-01T00:00:00Z', '--window-end=2026-12-01T00:00:00Z', `--out-dir=${d}`], { encoding: 'utf8' });
  assert.equal(no.status, 2);
});
