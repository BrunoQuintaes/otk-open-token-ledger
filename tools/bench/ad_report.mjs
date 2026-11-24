#!/usr/bin/env node
/**
 * FECHAMENTO_GEMINI_AD / A — derive every table and the chart of the overhead benchmark from raw.csv (no number typed
 * by hand). Warm-up rows are excluded from statistics but counted; failed requests are counted per cell and excluded
 * from latency statistics (they have no complete latency), never dropped silently.
 *
 *   node tools/bench/ad_report.mjs <dir-with-raw.csv> <out-md>
 * Writes <dir>/summary.json, <dir>/overhead.svg and the markdown report.
 */
import fs from 'node:fs';
import path from 'node:path';

const [dir, outMd] = process.argv.slice(2);
if (!dir || !outMd) { console.error('usage: ad_report.mjs <dir> <out-md>'); process.exit(4); }
const lines = fs.readFileSync(path.join(dir, 'raw.csv'), 'utf8').trim().split(/\r?\n/);
const head = lines[0].split(',');
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run_manifest.json'), 'utf8'));
// settlement (ledger debit) and outbox effect times exported from the bench database by ad_export_settle.mjs
const settle = new Map();
if (fs.existsSync(path.join(dir, 'settle_times.csv'))) {
  const sl = fs.readFileSync(path.join(dir, 'settle_times.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  for (const l of sl) { const [op, d, r, x] = l.split(','); settle.set(op, { debit: d === '' ? NaN : +d, receipt: r === '' ? NaN : +r, redis: x === '' ? NaN : +x }); }
}

const q = (s, p) => { if (!s.length) return null; const pos = (s.length - 1) * p; const lo = Math.floor(pos); const hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
function stats(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  const r = (v) => (v === null ? null : +v.toFixed(2));
  return { n: s.length, mean: r(mean), sd: r(sd), p50: r(q(s, 0.5)), p95: r(q(s, 0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
}
const measured = rows.filter((r) => r.warmup === 'false');
const warm = rows.length - measured.length;
const cells = [...new Set(measured.map((r) => r.cell))].sort();
const summary = { source: 'raw.csv', manifest: { commit: manifest.commit, tree: manifest.tree, dirty: manifest.dirty, planSha256: manifest.planSha256, seed: manifest.seed, blocks: manifest.blocks, perBlock: manifest.perBlock },
  warmupRows: warm, measuredRows: measured.length, failedMeasured: measured.filter((r) => r.ok !== 'true').length, cells: {} };
for (const c of cells) {
  const rc = measured.filter((r) => r.cell === c);
  const by = (p) => rc.filter((r) => r.path === p);
  const ok = (p) => by(p).filter((r) => r.ok === 'true');
  const wall = (p) => { const xs = by(p); if (!xs.length) return null; const blocks = [...new Set(xs.map((r) => r.block))]; let t = 0; for (const b of blocks) { const xb = xs.filter((r) => r.block === b); t += Math.max(...xb.map((r) => +r.end_epoch_ms)) - Math.min(...xb.map((r) => +r.start_epoch_ms)); } return t; };
  const entry = {};
  for (const p of ['direto', 'otk']) {
    const w = wall(p);
    entry[p] = { requests: by(p).length, failed: by(p).length - ok(p).length, errors: [...new Set(by(p).filter((r) => r.ok !== 'true').map((r) => r.error))],
      total_ms: stats(ok(p).map((r) => +r.total_ms)), ttfb_ms: stats(ok(p).map((r) => +r.ttfb_ms)), throughput_rps: w ? +((ok(p).length / w) * 1000).toFixed(1) : null };
  }
  const otk = ok('otk');
  entry.otk.final_lag_ms = stats(otk.map((r) => +r.final_lag_ms).filter((x) => Number.isFinite(x)));
  entry.otk.receipt_lag_ms = stats(otk.map((r) => +r.receipt_lag_ms).filter((x) => Number.isFinite(x)));
  entry.otk.notSettled = otk.filter((r) => r.op_reservation !== 'settled').length;
  const lag = (k) => stats(otk.map((r) => { const s = settle.get(r.op_id); return s ? s[k] - +r.end_epoch_ms : NaN; }).filter((x) => Number.isFinite(x)));
  entry.otk.debit_lag_ms = lag('debit'); entry.otk.receipt_done_lag_ms = lag('receipt'); entry.otk.redis_done_lag_ms = lag('redis');
  entry.overhead_ms = {
    total_p50: entry.otk.total_ms.p50 !== undefined ? +(entry.otk.total_ms.p50 - entry.direto.total_ms.p50).toFixed(2) : null,
    total_p95: entry.otk.total_ms.p95 !== undefined ? +(entry.otk.total_ms.p95 - entry.direto.total_ms.p95).toFixed(2) : null,
    ttfb_p50: entry.otk.ttfb_ms.p50 !== undefined ? +(entry.otk.ttfb_ms.p50 - entry.direto.ttfb_ms.p50).toFixed(2) : null,
  };
  summary.cells[c] = entry;
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

// chart: p50 and p95 of total time, direct vs OTK, one row per cell (SVG, no dependencies)
const W = 900; const rowH = 18; const H = 60 + cells.length * rowH; const maxV = Math.max(...cells.map((c) => summary.cells[c].otk.total_ms.p95 ?? 0), 1);
const x = (v) => 260 + (v / maxV) * (W - 300);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="11"><rect width="100%" height="100%" fill="#fff"/>`;
svg += `<text x="10" y="18" font-size="13">Tempo total por célula (ms): barra = p50, traço = p95. Cinza = direto, azul = OTK. Fonte: raw.csv</text>`;
cells.forEach((c, i) => {
  const y = 40 + i * rowH; const e = summary.cells[c];
  svg += `<text x="10" y="${y + 12}">${c}</text>`;
  for (const [p, color, dy] of [['direto', '#999', 0], ['otk', '#2a6fdb', 8]]) {
    const s = e[p].total_ms; if (!s.n) continue;
    svg += `<rect x="260" y="${y + dy}" width="${(x(s.p50) - 260).toFixed(1)}" height="7" fill="${color}"/><line x1="${x(s.p95).toFixed(1)}" x2="${x(s.p95).toFixed(1)}" y1="${y + dy}" y2="${y + dy + 7}" stroke="${color}" stroke-width="2"/>`;
  }
});
svg += `<text x="260" y="${H - 6}">0</text><text x="${W - 60}" y="${H - 6}">${maxV.toFixed(0)} ms</text></svg>`;
fs.writeFileSync(path.join(dir, 'overhead.svg'), svg);

const fmt = (s) => (s && s.n ? `${s.p50} / ${s.p95} (n=${s.n})` : '—');
let md = `# Resultados A — custo adicional do OTK (gerado por \`tools/bench/ad_report.mjs\`)\n\n`;
md += `Fonte única: \`raw.csv\` (${rows.length} linhas: ${warm} de aquecimento excluídas das estatísticas, ${measured.length} medidas, ${summary.failedMeasured} falhas). Commit \`${manifest.commit}\`, árvore \`${manifest.tree}\`, alterações não commitadas: ${manifest.dirty}. Plano sha256 \`${manifest.planSha256}\`.\n\n`;
md += `Máquina: ${manifest.cpu}, ${manifest.memGB} GB (livre no início: ${manifest.freeMemGBAtStart} GB), ${manifest.os}, Node ${manifest.node}, Docker ${manifest.docker}; PostgreSQL: ${manifest.postgres}. Contêineres em execução: ${(manifest.containersRunning || []).length}. Desvio de relógio host×PostgreSQL corrigido: ${manifest.pgClockSkewMs} ms (sonda ${manifest.pgClockProbeRttMs} ms).\n\n`;
md += `Canário de credencial: controle positivo detectado = ${manifest.canary?.positiveControlSeen}; presente no ambiente do OTK = ${manifest.canary?.inChildEnv}; visto pelo upstream durante a medição = ${manifest.canary?.seenByUpstreamDuringRun}.\n\n`;
md += `## Tempo total e TTFB (ms, p50 / p95)\n\n| Célula | direto total | OTK total | sobrecusto p50 | sobrecusto p95 | direto TTFB | OTK TTFB | falhas d/o |\n|---|---|---|---|---|---|---|---|\n`;
for (const c of cells) { const e = summary.cells[c]; md += `| ${c} | ${fmt(e.direto.total_ms)} | ${fmt(e.otk.total_ms)} | ${e.overhead_ms.total_p50} | ${e.overhead_ms.total_p95} | ${fmt(e.direto.ttfb_ms)} | ${fmt(e.otk.ttfb_ms)} | ${e.direto.failed}/${e.otk.failed} |\n`; }
md += `\n## Vazão (req/s, por caminho) e persistência do OTK (ms em relação ao fim da resposta no cliente, p50 / p95)\n\n| Célula | vazão direto | vazão OTK | liquidação (débito no ledger) | recibo v3 (outbox) | projeção Redis (outbox) | última atualização da linha | não liquidadas |\n|---|---|---|---|---|---|---|---|\n`;
for (const c of cells) { const e = summary.cells[c]; md += `| ${c} | ${e.direto.throughput_rps} | ${e.otk.throughput_rps} | ${fmt(e.otk.debit_lag_ms)} | ${fmt(e.otk.receipt_done_lag_ms)} | ${fmt(e.otk.redis_done_lag_ms)} | ${fmt(e.otk.final_lag_ms)} | ${e.otk.notSettled} |\n`; }
md += `\nLiquidação: instante do débito no ledger (mesma transação que grava o estado final). Recibo e projeção: conclusão dos efeitos do outbox (trabalho assíncrono, fora da resposta). Última atualização: \`updated_at\` da operação, que também muda com a contabilidade dos efeitos — não é o instante da liquidação.\n`;
md += `\nSobrecusto = diferença de percentis entre caminhos (não pareada por requisição). Atraso negativo de estado final = gravado antes do último byte chegar ao cliente. Gráfico: \`overhead.svg\`. Recursos por bloco: \`resources.csv\`.\n`;
fs.writeFileSync(outMd, md);
console.log(JSON.stringify({ cells: cells.length, measured: measured.length, failed: summary.failedMeasured }));
