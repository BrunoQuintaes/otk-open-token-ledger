#!/usr/bin/env node
/**
 * review_tenant_log.mjs — read-only review of an OTK_TENANT_LOG file after the M24-SEC-01 fix (RUN-M1-24H, ADV-M24-05).
 *
 * Before b163fa6 a tenant role could create or change records in the tenant registry (proxy tokens). The fix blocks new
 * writes, but src/api/tenantCrud.ts re-registers every ACTIVE record of OTK_TENANT_LOG at boot, so a token created that
 * way before the update is still accepted. The log does not store who created a record (the audit chain is in memory
 * only), so this tool cannot tell platform records from tenant-made ones: it lists every active record, marks the ones
 * created or updated before --before (the date the fix was deployed) and leaves the decision to the operator, who
 * deactivates through the platform credential (DELETE /admin/tenants/:id). It never changes the file and never prints a
 * token: only a sha256 prefix, to match a record against a token the operator holds.
 *
 *   node scripts/ops/review_tenant_log.mjs <tenant-log.jsonl> [--before 2026-10-10T00:00:00Z] [--json]
 *
 * Exit: 0 nothing to review · 1 at least one active record created/updated before --before (or any active record when
 * --before is omitted) · 64 usage error or unreadable file.
 *
 * Tested by test/unit/review_tenant_log.test.ts.
 *
 * @module scripts/ops/review_tenant_log
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--before');
const bi = args.indexOf('--before');
const before = bi !== -1 ? args[bi + 1] : null;
const asJson = args.includes('--json');
function usage(msg) { process.stderr.write(`review_tenant_log: ${msg}\n`); process.exit(64); }
if (!file) usage('usage: review_tenant_log.mjs <tenant-log.jsonl> [--before ISO-8601] [--json]');
if (bi !== -1 && (!before || Number.isNaN(Date.parse(before)))) usage('--before must be an ISO-8601 date');

let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { usage(`cannot read ${file}: ${e.code ?? e.message}`); }

// tenantCrud appends a full record on create and rewrites the file on update/delete: the last line of a tenant wins
const latest = new Map();
let malformed = 0;
for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    if (r && typeof r.tenantId === 'string' && typeof r.token === 'string' && r.tenantId && r.token) latest.set(r.tenantId, r);
    else malformed++;
  } catch { malformed++; }
}

const cutoff = before ? Date.parse(before) : null;
const records = [...latest.values()].map((r) => {
  const created = Date.parse(r.createdAt ?? '');
  const updated = Date.parse(r.updatedAt ?? '');
  const touchedBefore = cutoff === null ? null
    : (Number.isNaN(created) || created < cutoff || Number.isNaN(updated) || updated < cutoff);
  return {
    tenantId: r.tenantId,
    role: r.role ?? null,
    active: r.active === true,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
    tokenSha256Prefix: crypto.createHash('sha256').update(r.token).digest('hex').slice(0, 12),
    review: r.active === true && (cutoff === null || touchedBefore === true),
  };
}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.tenantId.localeCompare(b.tenantId));

const toReview = records.filter((r) => r.review);
const summary = { schema: 'otk.tenant_log_review.v1', before, records: records.length, active: records.filter((r) => r.active).length, toReview: toReview.length, malformedLines: malformed };
if (asJson) {
  process.stdout.write(JSON.stringify({ ...summary, items: records }) + '\n');
} else {
  for (const r of records) {
    process.stdout.write(`${r.review ? 'REVIEW' : 'ok    '}  ${r.tenantId}  role=${r.role}  active=${r.active}  created=${r.createdAt}  updated=${r.updatedAt}  token-sha256=${r.tokenSha256Prefix}\n`);
  }
  process.stdout.write(JSON.stringify(summary) + '\n');
}
process.exitCode = toReview.length > 0 ? 1 : 0;
