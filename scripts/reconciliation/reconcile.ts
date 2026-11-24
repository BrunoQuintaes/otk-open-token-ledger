/**
 * OVERNIGHT 20261005 (Phase 10) — reconcile OTK usage/cost with a provider statement (offline).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/reconciliation/reconcile.ts \
 *     --provider=anthropic|openai|gemini --origin=REAL|FIXTURE \
 *     --statement=<file> --mapping=<bundled id | mapping.json> [--statement=... --mapping=...]   (paired in order)
 *     [--declared-timezone=<UTC|+HH:MM|IANA>]   (only for exports whose dates carry no timezone)
 *     [--accept-unverified-mapping]             (required to run REAL data through an UNVERIFIED_ASSUMPTION mapping)
 *     OTK side, one of:
 *       --otk-ledger=<pilot ledger .jsonl> [--otk-ledger=...] [--ledger-price-table-version=<version>]
 *       --otk-pg-env=<NAME of the env var holding the PostgreSQL URL> --tenant=<tenant id>
 *       --otk-fixture=<SYNTHETIC OTK records .json> (demonstrations only; requires --origin=FIXTURE)
 *       --otk-receipts=<folder|file> [--otk-receipts=...] --keyring=<public keyring .json> [--fingerprint=<sha256>]
 *                      (receipts v3 checked by the offline verifier; only green and yellow receipts are used)
 *     --window-start=<ISO UTC> --window-end=<ISO UTC> [--window-timezone=UTC]
 *     [--price-table=<price table .json>] (repeatable) [--timing-tolerance-ms=120000]
 *     --out-dir=<dir>
 *
 * Writes <out-dir>/reconciliation_<provider>_<REAL|FIXTURE>.{json,md,json.sha256}. Same inputs → same bytes.
 * No network call is made to any provider; the PostgreSQL URL is read from the named variable and never printed.
 * Exit: 0 report written (whatever the classifications); 2 usage error; 3 import/validation error.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  importProviderStatement, loadMapping, loadOtkFromFixtureJson, loadOtkFromPilotLedger, loadOtkFromPostgres, mergeOtkLoads, reconcile,
  reportDigest, reportJson, reportMarkdown, RECON_PROVIDERS, StatementImportError, MappingError,
} from '../../src/reconciliation/index.js';
import type { DataOrigin, OtkLoadResult, ProviderStatement, ReconProvider } from '../../src/reconciliation/index.js';
import { parsePriceTableV1 } from '../../src/pricing/priceUsage.js';
import { assertTimezone } from '../../src/reconciliation/time.js';
import { collectInputs } from '../verify/otk.js';
import { loadOtkFromVerifiedReceipts } from '../verify/receiptsToOtk.js';

class UsageError extends Error {}

const all = (n: string): string[] => process.argv.filter((a) => a.startsWith(`--${n}=`)).map((a) => a.slice(n.length + 3));
const one = (n: string): string | undefined => { const v = all(n); if (v.length > 1) throw new UsageError(`--${n} given more than once`); return v[0]; };
const need = (n: string): string => { const v = one(n); if (!v) throw new UsageError(`--${n}=... is required`); return v; };
const flag = (n: string): boolean => process.argv.includes(`--${n}`);
const isoUtc = (n: string): string => {
  const v = need(n);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) throw new UsageError(`--${n} must be an ISO UTC instant ending in Z`);
  return new Date(v).toISOString();
};

async function main(): Promise<number> {
  const provider = need('provider') as ReconProvider;
  if (!RECON_PROVIDERS.includes(provider)) throw new UsageError(`--provider must be one of ${RECON_PROVIDERS.join(', ')}`);
  const origin = need('origin') as DataOrigin;
  if (origin !== 'REAL' && origin !== 'FIXTURE') throw new UsageError('--origin must be REAL or FIXTURE');
  const statements = all('statement');
  const mappings = all('mapping');
  if (statements.length === 0 || statements.length !== mappings.length) throw new UsageError('give one --mapping per --statement, in the same order');
  const tz = one('declared-timezone');
  if (tz !== undefined) assertTimezone(tz);
  const start = isoUtc('window-start');
  const end = isoUtc('window-end');
  if (end <= start) throw new UsageError('--window-end must be after --window-start');
  const windowTz = one('window-timezone') ?? 'UTC';
  assertTimezone(windowTz);
  const outDir = need('out-dir');
  const tol = one('timing-tolerance-ms');
  if (tol !== undefined && !/^\d{1,9}$/.test(tol)) throw new UsageError('--timing-tolerance-ms must be a non-negative integer');

  const imported: ProviderStatement[] = [];
  statements.forEach((path, i) => {
    if (origin === 'REAL' && /^fixture_/i.test(basename(path))) throw new UsageError(`${path} is named as a fixture but --origin=REAL`);
    const m = loadMapping(mappings[i]!);
    if (origin === 'REAL' && m.provenance.status === 'UNVERIFIED_ASSUMPTION' && !flag('accept-unverified-mapping')) {
      throw new UsageError(`mapping ${m.id} is UNVERIFIED_ASSUMPTION: check its columns against the real header, then pass --accept-unverified-mapping`);
    }
    imported.push(importProviderStatement(provider, readFileSync(path), m, { declaredOrigin: origin, ...(tz !== undefined ? { declaredTimezone: tz } : {}) }));
  });

  const tables = all('price-table').map((p) => parsePriceTableV1(JSON.parse(readFileSync(p, 'utf8'))));
  let otk: OtkLoadResult;
  const ledgers = all('otk-ledger');
  const pgEnv = one('otk-pg-env');
  const otkFixture = one('otk-fixture');
  const receiptPaths = all('otk-receipts');
  if ([ledgers.length > 0, pgEnv !== undefined, otkFixture !== undefined, receiptPaths.length > 0].filter(Boolean).length !== 1) throw new UsageError('give exactly one OTK source: --otk-ledger=..., --otk-pg-env=NAME, --otk-fixture=... or --otk-receipts=...');
  if (receiptPaths.length > 0) {
    const kr = need('keyring');
    const loaded = loadOtkFromVerifiedReceipts(collectInputs(receiptPaths), { name: basename(kr), bytes: new Uint8Array(readFileSync(kr)) },
      { fingerprint: one('fingerprint') ?? null }, { provider, start, end, tenantId: one('tenant') ?? null });
    process.stdout.write(`verified receipts: ${loaded.records.length} used, ${loaded.red} rejected (red); verifier report sha256 ${loaded.verificationSha256}\n`);
    otk = loaded;
  } else if (otkFixture !== undefined) {
    if (origin !== 'FIXTURE') throw new UsageError('--otk-fixture holds SYNTHETIC OTK records: only with --origin=FIXTURE');
    otk = loadOtkFromFixtureJson(readFileSync(otkFixture, 'utf8'), basename(otkFixture));
  } else if (ledgers.length > 0) {
    const ver = one('ledger-price-table-version') ?? null;
    otk = mergeOtkLoads(ledgers.map((p) => loadOtkFromPilotLedger(readFileSync(p, 'utf8'), { sourceName: basename(p), provider, priceTableVersion: ver })));
  } else {
    const name = pgEnv!;
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new UsageError('--otk-pg-env must be the NAME of an environment variable');
    const url = process.env[name];
    if (!url) throw new UsageError(`environment variable ${name} is empty`);
    const tenantId = need('tenant');
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      otk = await loadOtkFromPostgres(pool, { tenantId, provider, start, end });
    } finally {
      await pool.end();
    }
  }

  const report = reconcile({
    statements: imported, otk, priceTables: tables,
    window: { provider, start, end, timezone: windowTz, tenantId: one('tenant') ?? null },
    ...(tol !== undefined ? { timingToleranceMs: Number(tol) } : {}),
  });
  const json = reportJson(report);
  const digest = reportDigest(json);
  mkdirSync(outDir, { recursive: true });
  const stem = join(outDir, `reconciliation_${provider}_${report.providerDataOrigin}`);
  writeFileSync(`${stem}.json`, json);
  writeFileSync(`${stem}.json.sha256`, `${digest}  ${basename(stem)}.json\n`);
  writeFileSync(`${stem}.md`, reportMarkdown(report, digest));
  const counts = Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
  process.stdout.write(`provider data: ${report.providerDataOrigin}; ${report.aggregationLevel}; ${counts}\nwrote ${stem}.json (sha256 ${digest}) and .md\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  if (e instanceof UsageError) { process.stderr.write(`usage error: ${e.message}\n`); process.exitCode = 2; return; }
  if (e instanceof StatementImportError || e instanceof MappingError) { process.stderr.write(`${e.name}: ${e.message}\n`); process.exitCode = 3; return; }
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 3;
});
