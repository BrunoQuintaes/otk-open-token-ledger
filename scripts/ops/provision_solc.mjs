#!/usr/bin/env node
// H1-D6 (OTK-H1-MEGA-S01-S24-20261013): verifiable solc provisioning for Hardhat 3 when binaries.soliditylang.org is
// unreachable (HHE905/HHE904 behind a restrictive proxy). Never installs a compiler whose bytes do not match the
// hashes pinned below. The pins are the values of the official build lists (solc-bin), cross-checked on 2026-10-13
// through two independent channels for the native build: the solc-bin repository and the GitHub release asset
// solc-static-linux v0.8.24 were byte-identical (same sha256 and keccak256).
//
// Source tried in order: an existing file in the Hardhat cache, then github raw of ethereum/solc-bin (gh-pages).
// The official list.json files are downloaded too and must contain exactly the pinned hashes for this version;
// they are installed unmodified, so Hardhat performs its own sha256 verification as well.
//
//   node scripts/ops/provision_solc.mjs [--check]     (--check: verify what is installed, download nothing)
// exit 0 = installed/verified, 1 = verification failed (nothing installed), 2 = network/usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keccak256 } = require('ethers');

const PINS = {
  'linux-amd64': {
    path: 'solc-linux-amd64-v0.8.24+commit.e11b9ed9',
    sha256: 'fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f',
    keccak256: '5a127e73ef8c90f2df60ff2fe9dd79709da9e90d2d075cf05784c9a3efee2528',
    source: 'linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9',
  },
  wasm: {
    path: 'soljson-v0.8.24+commit.e11b9ed9.js',
    sha256: '11b054b55273ec55f6ab3f445eb0eb2c83a23fed43d10079d34ac3eabe6ed8b1',
    keccak256: '1b6ceeabad21bbb2011ba13373160f7c4d46c11371a354243ee1be07159345f3',
    // wasm/<file> in solc-bin is a symlink to bin/<file>; raw GitHub serves the link text, so fetch the target
    source: 'bin/soljson-v0.8.24+commit.e11b9ed9.js',
  },
};
const VERSION = '0.8.24';
const RAW = 'https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages';
const CACHE = path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'hardhat-nodejs', 'compilers-v3');
const checkOnly = process.argv.includes('--check');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const kec = (b) => keccak256(b).slice(2);
async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

let failed = false;
const report = [];
for (const [platform, pin] of Object.entries(PINS)) {
  const dir = path.join(CACHE, platform);
  const binPath = path.join(dir, pin.path);
  const listPath = path.join(dir, 'list.json');
  try {
    let list = fs.existsSync(listPath) ? fs.readFileSync(listPath) : null;
    if (!list && !checkOnly) list = await fetchBytes(`${RAW}/${platform}/list.json`);
    if (!list) throw new Error('list.json missing');
    const build = JSON.parse(list.toString('utf8')).builds.find((b) => b.version === VERSION && b.path === pin.path);
    if (!build || build.sha256 !== `0x${pin.sha256}` || build.keccak256 !== `0x${pin.keccak256}`) {
      throw new Error(`official list.json does not carry the pinned hashes for ${pin.path}`);
    }
    let bin = fs.existsSync(binPath) ? fs.readFileSync(binPath) : null;
    if (!bin && !checkOnly) bin = await fetchBytes(`${RAW}/${pin.source}`);
    if (!bin) throw new Error('compiler file missing');
    const got = { sha256: sha256(bin), keccak256: kec(bin) };
    if (got.sha256 !== pin.sha256 || got.keccak256 !== pin.keccak256) {
      throw new Error(`hash mismatch for ${pin.path}: sha256 ${got.sha256}, keccak256 ${got.keccak256}`);
    }
    if (!checkOnly) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(listPath, list);
      fs.writeFileSync(binPath, bin, { mode: platform === 'wasm' ? 0o644 : 0o755 });
    }
    report.push({ platform, file: pin.path, sha256: got.sha256, keccak256: got.keccak256, status: checkOnly ? 'verified' : 'installed' });
  } catch (e) {
    failed = true;
    report.push({ platform, file: pin.path, status: 'FAILED', error: e.message });
  }
}
console.log(JSON.stringify({ solc: VERSION, cache: CACHE, report }, null, 2));
process.exit(failed ? 1 : 0);
