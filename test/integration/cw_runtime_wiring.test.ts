/**
 * N2 — the API server loads the signed CU weights table at startup (with R01's V2 signature).
 *
 * Real: API server child process, cwRuntime, CUWeightsLoader (EIP-191 over the canonical
 * V2 message), POST/GET /receipts. Substitute: an ephemeral signing key generated here.
 * Current failure mode (static weights when the signature is invalid) is D4, still open.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnApi, stopApi, waitReady, freePort, type ApiChild } from './fixtures/apiChild.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { buildSignedMessage, type CWJson } from '../../src/economics/CUWeightsLoader.js';

let stderrLog = '';
async function start(port: number, env: NodeJS.ProcessEnv): Promise<ApiChild> {
  const c = spawnApi(port, env);
  c.proc.stderr?.on('data', (d) => { stderrLog += String(d); });
  return c;
}

describe('N2 — signed weights table is loaded by the running API', () => {
  let port: number;
  let api: ApiChild | undefined;
  let tableFile: string;
  let env: NodeJS.ProcessEnv;
  const signer = Wallet.createRandom();
  let table: CWJson;

  before(async () => {
    port = await freePort();
    tableFile = path.join(mkdtempSync(path.join(tmpdir(), 'otk-cw-')), 'cw.json');
    table = {
      version: 'itest-cw-v2', validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
      weights: { openai: { 'gpt-4o': { inputWeight: 1, outputWeight: 3, latencyWeight: 0 } } },
      signedBy: signer.address, signature: '',
    };
    table.signature = await signer.signMessage(buildSignedMessage(table));
    env = { ...process.env, NODE_ENV: 'test', OTK_RECEIPT_LOG: '', PROVER_URL: 'disabled',
      OTK_CW_JSON_FILE: tableFile, OTK_TRUSTED_SIGNERS: signer.address.toLowerCase() };
    delete env['OTK_TENANTS']; delete env['OTK_DB_URL']; delete env['OTK_REDIS_URL'];
  });
  after(async () => { await stopApi(api); });

  async function submitAndRead(id: string): Promise<string> {
    const base = `http://127.0.0.1:${port}`;
    const post = await fetch(`${base}/receipts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: id, provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 20, costUnits: 70, userId: '1', nonce: '1' }) });
    assert.equal(post.status, 201);
    const got = await (await fetch(`${base}/receipts/${id}`)).json() as { receipt: { cwVersion: string } };
    return got.receipt.cwVersion;
  }

  it('valid V2 signature → the table is loaded; receipts name the weights actually used', async () => {
    writeFileSync(tableFile, JSON.stringify(table));
    stderrLog = '';
    api = await start(port, env);
    try {
      await waitReady(api, 'cw_runtime valid');
      // N2: the running API loaded and verified the signed table
      assert.match(stderrLog, /CW JSON loaded successfully \(version=itest-cw-v2\)/);
      // S0-F01b: this assertion used to expect 'itest-cw-v2', but the CU of the receipt is
      // computed with the static weights (the v1 weighted-sum table is not a multiplicative
      // CU table, D5). A receipt now names the weights that produced its CU.
      assert.equal(await submitAndRead('cw-valid-1'), 'static');
    } finally { await stopApi(api); }
  });

  it('tampered weight (3 → 900) → table rejected, receipts stay on static weights', async () => {
    const tampered = structuredClone(table);
    tampered.weights.openai!['gpt-4o']!.outputWeight = 900;
    writeFileSync(tableFile, JSON.stringify(tampered));
    api = await start(port, env);
    try {
      await waitReady(api, 'cw_runtime tampered');
      assert.equal(await submitAndRead('cw-tampered-1'), 'static');
    } finally { await stopApi(api); }
  });
});
