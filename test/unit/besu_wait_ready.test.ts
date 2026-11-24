/**
 * RUN-M1-24H-20261010 (R §6.4): in the RUN-S reproduction the inline Besu wait exited 0 in 1 s with no output and the
 * deploy then hit a closed RPC. tools/besu/wait_ready.mjs must report READY only on observed evidence (right chain id,
 * block >= minimum and advancing, expected validator count) and always print one JSON status line; every other outcome
 * is a non-zero exit. Runs the real script against an in-process fake JSON-RPC server (no Docker, no network).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'besu', 'wait_ready.mjs');
const CHAIN = 16466;

type Mode = { chainId: number; block: () => number; validators: number; rpcError?: boolean; garbage?: boolean; chainHex?: () => string; noPeers?: boolean };
let mode: Mode;
let server: http.Server;
let rpc = '';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id, method } = JSON.parse(body);
      if (mode.garbage) { res.end('<html>starting</html>'); return; }
      if (mode.noPeers && method === 'net_peerCount') { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not enabled' } })); return; }
      if (mode.rpcError) { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'not ready' } })); return; }
      const result = method === 'eth_chainId' ? (mode.chainHex ? mode.chainHex() : '0x' + mode.chainId.toString(16))
        : method === 'eth_blockNumber' ? '0x' + mode.block().toString(16)
        : method === 'ibft_getValidatorsByBlockNumber' ? Array.from({ length: mode.validators }, (_, i) => `0x${String(i).padStart(40, '0')}`)
        : method === 'net_peerCount' ? '0x6' : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

function run(args: string[]): Promise<{ code: number | null; json: Record<string, any> | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 30000 }, (err, stdout) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let json: Record<string, any> | null = null;
      try { json = lines.length === 1 ? JSON.parse(lines[0]) : null; } catch { json = null; }
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, json, stdout });
    });
  });
}
const fast = ['--interval-ms', '20', '--request-timeout-ms', '2000'];
const counter = (start: number) => { let b = start; return () => b++; };

describe('Besu readiness: READY only with observed evidence, one JSON line always', () => {
  it('READY when chain id, advancing block >= min and validator count all match', async () => {
    mode = { chainId: CHAIN, block: counter(3), validators: 7 };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--min-block', '5', '--timeout-ms', '10000', ...fast]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json?.status, 'READY');
    assert.ok(r.json?.observation.block >= 5);
    assert.ok(r.json?.observation.block > r.json?.observation.firstBlock);
    assert.equal(r.json?.observation.validators, 7);
  });

  it('WRONG_CHAIN (exit 3) when another chain answers on the port', async () => {
    mode = { chainId: CHAIN + 1, block: counter(100), validators: 7 };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--timeout-ms', '10000', ...fast]);
    assert.equal(r.code, 3);
    assert.equal(r.json?.status, 'WRONG_CHAIN');
    assert.equal(r.json?.observedChainId, CHAIN + 1);
  });

  it('TIMEOUT (exit 2) when the block number never advances, even above the minimum', async () => {
    mode = { chainId: CHAIN, block: () => 50, validators: 7 };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--max-attempts', '4', ...fast]);
    assert.equal(r.code, 2);
    assert.equal(r.json?.status, 'TIMEOUT');
    assert.equal(r.json?.lastObservation.block, 50);
  });

  it('TIMEOUT when the validator set is smaller than expected', async () => {
    mode = { chainId: CHAIN, block: counter(10), validators: 6 };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--max-attempts', '4', ...fast]);
    assert.equal(r.code, 2);
    assert.equal(r.json?.lastObservation.validators, 6);
  });

  it('TIMEOUT while below the minimum block', async () => {
    mode = { chainId: CHAIN, block: counter(0), validators: 7 };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--min-block', '1000', '--max-attempts', '4', ...fast]);
    assert.equal(r.code, 2);
    assert.equal(r.json?.status, 'TIMEOUT');
  });

  it('keeps waiting through RPC errors and non-JSON answers, then TIMEOUT with the last error', async () => {
    mode = { chainId: CHAIN, block: counter(10), validators: 7, rpcError: true };
    const a = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--max-attempts', '3', ...fast]);
    assert.equal(a.code, 2);
    assert.match(String(a.json?.lastError), /RPC error/);
    mode = { chainId: CHAIN, block: counter(10), validators: 7, garbage: true };
    const b = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--max-attempts', '3', ...fast]);
    assert.equal(b.code, 2);
    assert.ok(b.json?.lastError);
  });

  it('ADV-M24-14: a malformed chain id is retried (not WRONG_CHAIN) and READY follows once it is valid', async () => {
    let n = 0;
    mode = { chainId: CHAIN, block: counter(10), validators: 7, chainHex: () => (n++ < 2 ? 'starting' : '0x' + CHAIN.toString(16)) };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--timeout-ms', '10000', ...fast]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json?.status, 'READY');
    assert.ok(r.json?.attempts >= 3);
    mode = { chainId: CHAIN, block: counter(10), validators: 7, chainHex: () => '0xZZ' };
    const bad = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--max-attempts', '3', ...fast]);
    assert.equal(bad.code, 2);
    assert.match(String(bad.json?.lastError), /malformed quantity/);
  });

  it('ADV-M24-14: net_peerCount disabled does not block READY (peers null)', async () => {
    mode = { chainId: CHAIN, block: counter(10), validators: 7, noPeers: true };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--timeout-ms', '10000', ...fast]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json?.observation.peers, null);
  });

  it('ADV-M24-14: a chain that stopped after its first advance is not READY when the rest catches up later', async () => {
    // poll 1: 40, poll 2: 45 (validator set still incomplete), poll 3+: 45 forever with the full set. Comparing with the
    // FIRST observation (45 > 40) would read the stalled chain as READY; comparing with the previous one does not.
    let poll = 0;
    mode = { chainId: CHAIN, validators: 6, block: () => { poll++; if (poll >= 3) mode.validators = 7; return poll === 1 ? 40 : 45; } };
    const r = await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--validators', '7', '--max-attempts', '6', ...fast]);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json?.status, 'TIMEOUT');
    assert.equal(r.json?.lastObservation.block, 45);
    assert.equal(r.json?.lastObservation.previousBlock, 45);
  });

  it('closed port: TIMEOUT with a connection error, never READY', async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    const r = await run(['--rpc', `http://127.0.0.1:${port}`, '--chain-id', String(CHAIN), '--max-attempts', '3', ...fast]);
    assert.equal(r.code, 2);
    assert.equal(r.json?.status, 'TIMEOUT');
    assert.equal(r.json?.lastObservation, null);
  });

  it('DEMO-02 (RUN-M1-RESUME-R2): a request that never settles and holds no handle is retried until TIMEOUT, not EVENT_LOOP_DRAINED', async () => {
    // reproduces the class seen in the package demo of 12/10 (status EVENT_LOOP_DRAINED after 1 s, Docker port relay
    // accepting before Besu listens) and in RUN-S (exit 0 in 1 s without output): a pending fetch whose only timer is
    // the unref'd AbortSignal.timeout() lets Node's event loop drain
    const hung = 'data:text/javascript,globalThis.fetch=()=>new Promise(()=>{})';
    const r = await new Promise<{ code: number | null; json: Record<string, any> | null }>((resolve) => {
      execFile(process.execPath, ['--import', hung, SCRIPT, '--rpc', rpc, '--chain-id', String(CHAIN), '--max-attempts', '2', '--interval-ms', '20', '--request-timeout-ms', '300'],
        { timeout: 30000 }, (err, stdout) => {
          let json: Record<string, any> | null = null;
          try { json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { json = null; }
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, json });
        });
    });
    assert.equal(r.json?.status, 'TIMEOUT', JSON.stringify(r.json));
    assert.equal(r.code, 2);
    assert.equal(r.json?.attempts, 2);
    assert.match(String(r.json?.lastError), /request timeout/);
  });

  // ADV-R2-R7: the other two hang shapes of a request
  const runWithFetch = (fetchSource: string, extra: string[] = []) => new Promise<{ code: number | null; json: Record<string, any> | null; ms: number }>((resolve) => {
    const t0 = Date.now();
    execFile(process.execPath, ['--import', `data:text/javascript,${fetchSource}`, SCRIPT, '--rpc', rpc, '--chain-id', String(CHAIN), '--max-attempts', '2', '--interval-ms', '20', '--request-timeout-ms', '300', ...extra],
      { timeout: 30000 }, (err, stdout) => {
        let json: Record<string, any> | null = null;
        try { json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { json = null; }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, json, ms: Date.now() - t0 });
      });
  });
  it('ADV-R2-R7: a response whose body never arrives is retried until TIMEOUT', async () => {
    const r = await runWithFetch('globalThis.fetch=async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})');
    assert.equal(r.json?.status, 'TIMEOUT', JSON.stringify(r.json));
    assert.equal(r.code, 2);
    assert.match(String(r.json?.lastError), /request timeout/);
  });
  it('ADV-R2-R7: a fetch that ignores the abort and holds a ref\'d handle does not keep the process alive after TIMEOUT', async () => {
    const r = await runWithFetch('globalThis.fetch=()=>new Promise(()=>{setInterval(()=>{},1000)})');
    assert.equal(r.json?.status, 'TIMEOUT', JSON.stringify(r.json));
    assert.equal(r.code, 2);
    assert.ok(r.ms < 15000, `process ended ${r.ms} ms after start (would hang until the 30 s test timeout before the fix)`);
  });
  it('ADV-R2-R7: --request-timeout-ms 0 is a usage error', async () => {
    assert.equal((await run(['--rpc', rpc, '--chain-id', String(CHAIN), '--request-timeout-ms', '0'])).code, 64);
  });

  it('usage error (exit 64) without --chain-id or with a bad --rpc', async () => {
    assert.equal((await run(['--rpc', rpc])).code, 64);
    assert.equal((await run(['--rpc', 'localhost:1', '--chain-id', '1'])).code, 64);
  });
});
