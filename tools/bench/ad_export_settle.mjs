#!/usr/bin/env node
// FECHAMENTO_GEMINI_AD / A — export, from the bench database, when each operation's settlement (ledger debit, written in the
// settlement transaction) and its outbox effects (persist_receipt, project_redis) happened. Clock skew from run_manifest.json.
//   node tools/bench/ad_export_settle.mjs <dir-with-run_manifest.json>      (needs OTK_TEST_PG_URL)
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
const dir = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(dir, 'run_manifest.json'), 'utf8'));
const u = new URL(process.env.OTK_TEST_PG_URL); u.pathname = `/${m.database}`;
const db = new pg.Pool({ connectionString: String(u), max: 1 });
const skew = Number(m.pgClockSkewMs ?? 0);
const q = await db.query(`SELECT o.operation_id,
  (SELECT (extract(epoch from l.created_at)*1000)::float8 FROM otk_ledger l WHERE l.tenant_id = o.tenant_id AND l.operation_id = o.operation_id LIMIT 1) AS debit,
  (SELECT (extract(epoch from x.done_at)*1000)::float8 FROM otk_outbox x WHERE x.tenant_id = o.tenant_id AND x.operation_id = o.operation_id AND x.kind = 'persist_receipt') AS receipt_done,
  (SELECT (extract(epoch from x.done_at)*1000)::float8 FROM otk_outbox x WHERE x.tenant_id = o.tenant_id AND x.operation_id = o.operation_id AND x.kind = 'project_redis') AS redis_done
  FROM otk_operations o`);
const f = (v) => (v === null || v === undefined ? '' : (Number(v) - skew).toFixed(1));
fs.writeFileSync(path.join(dir, 'settle_times.csv'), ['op_id,debit_epoch_ms,receipt_done_epoch_ms,redis_done_epoch_ms', ...q.rows.map((r) => [r.operation_id, f(r.debit), f(r.receipt_done), f(r.redis_done)].join(','))].join('\n') + '\n');
console.log(JSON.stringify({ operations: q.rows.length, withDebit: q.rows.filter((r) => r.debit !== null).length }));
await db.end();
