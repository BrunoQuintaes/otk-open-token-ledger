#!/usr/bin/env node
/**
 * STOPGATE-01 P2.2: deterministic fingerprint of the compiled contracts (tools/hardhat/artifacts/contracts), to compare
 * a Hardhat upgrade against the baseline. For each contract: sha256 of the creation bytecode, of the deployed bytecode
 * with and without the CBOR metadata trailer, and of the canonical ABI JSON. Prints JSON (sorted) to stdout.
 * Usage: node scripts/ops/hardhat_artifact_fingerprint.mjs [artifactsDir]
 *
 * The default artifacts folder is relative to the working directory, so run it from the repository root. It only
 * reads; it does not compile. Files whose name starts with "artifacts", debug files (.dbg.json) and JSON without
 * contractName/bytecode are skipped. Hashes are of the hex text as stored in the artifact, not of the decoded bytes.
 *
 * @module scripts/ops/hardhat_artifact_fingerprint
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve(process.argv[2] ?? 'tools/hardhat/artifacts/contracts');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/**
 * strip the solc CBOR metadata trailer (last 2 bytes = its length)
 *
 * Unlike evm_bytecode.mjs it does not check that the trailer starts with a CBOR map header; if the declared
 * length does not fit, the code is returned unchanged.
 *
 * @param hex - Bytecode hex, with or without `0x`.
 * @returns The hex without `0x` and without the trailer.
 */
function stripMeta(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length < 4) return h;
  const len = parseInt(h.slice(-4), 16);
  const cut = h.length - 4 - len * 2;
  return cut > 0 ? h.slice(0, cut) : h;
}
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;

const out = {};
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && !e.name.endsWith('.dbg.json') && !e.name.startsWith('artifacts')) {
      const a = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!a.contractName || a.bytecode === undefined) continue;
      out[`${a.sourceName}:${a.contractName}`] = {
        bytecode: sha(a.bytecode),
        deployedBytecode: sha(a.deployedBytecode),
        deployedBytecodeNoMetadata: sha(stripMeta(a.deployedBytecode)),
        abi: sha(JSON.stringify(canon(a.abi))),
      };
    }
  }
};
walk(dir);
process.stdout.write(JSON.stringify(Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]])), null, 2) + '\n');
