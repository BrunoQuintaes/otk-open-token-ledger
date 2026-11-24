#!/usr/bin/env node
/**
 * Wrapper to execute circom-generated witness calculator in projects with "type":"module".
 * Usage:
 *   node scripts/zk/generate_witness.cjs <wasm> <input.json> <wtns> [witness_calculator.js_dir]
 *
 * Default witness_calculator dir:
 *   zk/build/metering_v1_js
 */
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [,, wasmPath, inputPath, wtnsPath, wcDirArg] = process.argv;
if (!wasmPath || !inputPath || !wtnsPath) {
  die("Usage: node scripts/zk/generate_witness.cjs <wasm> <input.json> <wtns> [witness_calculator_dir]");
}

const wcDir = wcDirArg || path.join("zk", "build", "metering_v1_js");
const wcFile = path.join(wcDir, "witness_calculator.js");
if (!fs.existsSync(wcFile)) die(`Missing witness_calculator.js at: ${wcFile}`);

const requireFromWcDir = createRequire(path.resolve(wcFile));
const wc = requireFromWcDir("./witness_calculator.js");

(async () => {
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const buffer = fs.readFileSync(wasmPath);

  const calculator = await wc(buffer);
  const witness = await calculator.calculateWTNSBin(input, 0);

  fs.writeFileSync(wtnsPath, witness);
  console.log(`OK: wrote witness -> ${wtnsPath}`);
})().catch((e) => {
  console.error("Witness generation failed:", e);
  process.exit(1);
});
