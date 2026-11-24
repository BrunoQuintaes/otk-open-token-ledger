/**
 * Academic demo (RUN-M1-24H-20261010, OTK-D20-F03-S01-W02): verifies ONE receipt v3 produced by the synthetic demo run,
 * without credentials and without any provider call.
 *
 *   node --import tsx tools/academic_demo/verify_demo_receipt.mts --manifest <run>_manifest.json --besu-dir <network dir> --out <file.json>
 *   (OTK_TEST_PG_URL = admin URL of the demo PostgreSQL)
 *
 * Positive checks: the stored digest equals the recomputed digest; the operator signature verifies against the demo
 * network's operator address; the CU reference (FINAL profile) recomputed from the receipt usage equals an independent
 * oracle written from the archived public price row of gpt-4o-mini ($0.15 input, $0.075 cached, $0.60 output per MTok;
 * reference = gpt-4o-mini input, scale 1/1000).
 * Negative checks (must be REJECTED): a changed token count, a changed tenant, and a signature checked against another key.
 * Exit 0 only when every positive check passes and every negative case is rejected.
 * Scope: proves origin/integrity of the operator-signed receipt; NOT that the provider counted correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ethers } from 'ethers';
import type { CuReferenceProfileV1 } from '../../src/types/d1d8/index.ts';
import { computeCuReference } from '../../src/economics/cuReference.ts';
import { decodeReceiptV3 } from '../../src/operations/codec.ts';
import { createKeyRing, createReceiptCrypto, digestReceiptV3 } from '../../src/zk/v3/index.ts';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const manifestPath = arg('manifest'); const besuDir = arg('besu-dir'); const out = arg('out');
const admin = process.env['OTK_TEST_PG_URL'];
if (!manifestPath || !besuDir || !out || !admin) { console.error('usage: --manifest --besu-dir --out (and OTK_TEST_PG_URL)'); process.exit(2); }

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { database: string; runId: string; commit: string };
const network = JSON.parse(fs.readFileSync(path.join(besuDir, 'network.json'), 'utf8')) as { dev: { operator: string }; chainId: number };
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/cu_reference/otk.cu.reference.v1.2026-10.json'), 'utf8')) as CuReferenceProfileV1;

const u = new URL(admin); u.pathname = `/${manifest.database}`;
const db = new pg.Client({ connectionString: String(u) });
await db.connect();
const row = (await db.query("SELECT operation_id, receipt, envelope, receipt_digest FROM otk_receipts_v3 WHERE tenant_id = 'pilot-v3' ORDER BY created_at LIMIT 1")).rows[0] as
  { operation_id: string; receipt: unknown; envelope: unknown; receipt_digest: string } | undefined;
await db.end();
if (!row) { console.error('no receipt v3 in the demo database'); process.exit(1); }

const receipt = decodeReceiptV3(row.receipt);
const envelope = row.envelope as Parameters<ReturnType<typeof createReceiptCrypto>['verifyReceipt']>[1];
// the ring maps the envelope's keyId to the operator address of THIS demo network (never trusted from the envelope)
const keyId = String((row.envelope as { keyId?: unknown }).keyId);
const ring = createKeyRing([{ keyId, address: network.dev.operator as `0x${string}`, status: 'active' }]);
const crypto = createReceiptCrypto({ keyRing: ring });
const digest = digestReceiptV3(receipt);
const verify = crypto.verifyReceipt(receipt, envelope);

// independent oracle (archived price row, not the profile file): CU as an exact fraction =
// (in*150000 + cached*75000 + out*600000) / (150000 * 1000), compared with cu.exact by cross-multiplication (ADV-M24-17)
const q = Object.fromEntries(receipt.usage.categories.map((c) => [c.name, c.count === null ? null : BigInt(c.count)]));
const inUncached = (q['input'] ?? 0n) - (q['input_cache_read'] ?? 0n);
const oracleNum = inUncached * 150000n + (q['input_cache_read'] ?? 0n) * 75000n + (q['output'] ?? 0n) * 600000n;
const oracleDen = 150000n * 1000n;
const cu = computeCuReference(receipt.usage, profile);
const sameFraction = cu.status === 'computed' && BigInt(cu.exact!.numerator) * oracleDen === oracleNum * BigInt(cu.exact!.denominator);

// negative cases: each tampered copy must be refused
const clone = () => decodeReceiptV3(JSON.parse(JSON.stringify(row.receipt)));
const tamperedCount = clone();
const cat = tamperedCount.usage.categories.find((c) => c.count !== null)!;
(cat as { count: bigint | null }).count = BigInt(cat.count!) + 1n;
const tamperedTenant = clone();
(tamperedTenant.key as { tenantId: string }).tenantId = 'another-tenant';
const otherRing = createKeyRing([{ keyId, address: ethers.Wallet.createRandom().address as `0x${string}`, status: 'active' }]);
const negatives = {
  changedTokenCount: crypto.verifyReceipt(tamperedCount, envelope),
  changedTenant: crypto.verifyReceipt(tamperedTenant, envelope),
  otherOperatorKey: createReceiptCrypto({ keyRing: otherRing }).verifyReceipt(receipt, envelope),
};

const checks = {
  storedDigestEqualsRecomputed: row.receipt_digest.toLowerCase() === digest.toLowerCase(),
  operatorSignatureVerifies: verify.ok === true,
  cuReferenceComputed: cu.status === 'computed',
  cuReferenceEqualsIndependentOracle: sameFraction,
  negativeChangedTokenCountRejected: negatives.changedTokenCount.ok === false,
  negativeChangedTenantRejected: negatives.changedTenant.ok === false,
  negativeOtherKeyRejected: negatives.otherOperatorKey.ok === false,
};
const ok = Object.values(checks).every(Boolean);
const report = {
  schema: 'otk.academic_demo.receipt_check.v1', ok, runId: manifest.runId, commit: manifest.commit, chainId: network.chainId,
  operationId: row.operation_id, receiptDigest: digest, model: receipt.usage.modelReturned,
  usage: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v === null ? null : v.toString()])),
  cuReference: { profileId: profile.profileId, label: cu.label, exact: cu.exact, oracle: `${oracleNum}/${oracleDen}` },
  checks, negatives: Object.fromEntries(Object.entries(negatives).map(([k, v]) => [k, { ok: v.ok, reason: (v as { reason?: string }).reason ?? null }])),
  scope: 'origin and integrity of an operator-signed receipt of a SYNTHETIC provider; not a proof that a real provider counted correctly',
};
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok, checks }));
process.exit(ok ? 0 : 1);
