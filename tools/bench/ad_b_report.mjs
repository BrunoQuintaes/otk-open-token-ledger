#!/usr/bin/env node
/**
 * FECHAMENTO_GEMINI_AD / B — report derived from b_results.json (+ cold rerun JSONL). No number typed by hand.
 *   node tools/bench/ad_b_report.mjs <b_results.json> <cold.jsonl|-> <out-md>
 */
import fs from 'node:fs';

const [resFile, coldFile, outMd] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(resFile, 'utf8'));
const q = (s, p) => { const pos = (s.length - 1) * p; const lo = Math.floor(pos); const hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
const st = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return { n: 0 }; const m = s.reduce((a, b) => a + b, 0) / s.length; return { n: s.length, p50: +q(s, 0.5).toFixed(1), p95: +q(s, 0.95).toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1), mean: +m.toFixed(1) }; };
const fmt = (s) => (s && s.n ? `${s.p50} / ${s.p95} (n=${s.n}; min ${s.min}, máx ${s.max})` : '—');
let cold = null;
if (coldFile && coldFile !== '-' && fs.existsSync(coldFile)) {
  const rows = fs.readFileSync(coldFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const ok = rows.filter((x) => x.exit === 0 && x.inner && x.inner.verified === true);
  cold = { runs: rows.length, ok: ok.length, wall: st(ok.map((x) => x.processWallMs)), load: st(ok.map((x) => x.inner.loadMs)), prove: st(ok.map((x) => x.inner.proveMs)), verify: st(ok.map((x) => x.inner.verifyMs)) };
}
const firstCold = r.cold.raw.filter((c) => c.exit === 0).length;
let md = `# Resultados B — prova, verificação e gas (gerado por \`tools/bench/ad_b_report.mjs\`)\n\n`;
md += `Fonte: \`b_results.json\` (commit \`${r.commit}\`, árvore \`${r.tree}\`, arquivos não commitados no momento: ${r.dirty}; ${r.ranAt})${cold ? ' e `cold_rerun.jsonl`' : ''}. Máquina: ${r.machine.cpu}, ${r.machine.memGB} GB, ${r.machine.os}, Node ${r.machine.node}. Circuito \`${r.circuit.circuitId}\` (zkey ${r.circuit.zkey.slice(0, 12)}…, ${r.circuit.setup}), snarkjs ${r.circuit.snarkjs}. Rede: projeto \`${r.network.project}\`, chainId ${r.network.chainId}, ${r.network.validators} validadores, ${r.network.consensus}, ${r.network.image}; blocos ${r.network.startBlock}–${r.network.endBlock}; ${r.network.evm}.\n\n`;
md += `## Tempo (ms; p50 / p95)\n\n| Etapa | Processo persistente (quente) | Processo novo por prova (frio) |\n|---|---|---|\n`;
md += `| carga dos artefatos (com conferência de hash) | ${r.warm.artifactLoadMs} (uma vez) | ${cold ? fmt(cold.load) : '—'} |\n`;
md += `| testemunha (wtns.calculate) | ${fmt(r.warm.witnessMs)} | (incluída na prova) |\n`;
md += `| prova Groth16 | ${fmt(r.warm.proveMs)} | ${cold ? fmt(cold.prove) + ' (testemunha + prova)' : '—'} |\n`;
md += `| verificação off-chain | ${fmt(r.warm.verifyMs)} | ${cold ? fmt(cold.verify) : '—'} |\n`;
md += `| processo inteiro (node + tsx + carga + prova + verificação) | — | ${cold ? fmt(cold.wall) : '—'} |\n\n`;
md += `Quente: ${r.warm.excludedWarmup} provas de aquecimento excluídas; todas as ${r.warm.raw.length} provas verificadas: ${r.warm.allVerified}. Frio: primeira tentativa ${firstCold}/${r.cold.raw.length} válidas (falha do script de bancada — domínio com schemaVersion errado, recusado pela verificação de vinculação do produto; tempos descartados)${cold ? `; reexecução ${cold.ok}/${cold.runs} válidas` : ''}.\n\n`;
md += `## Gas (rede local nova)\n\n| Medida | Origem | Valor |\n|---|---|---|\n`;
md += `| \`verifyProof\` isolado | ESTIMATIVA (\`eth_estimateGas\` de chamada view; inclui 21 000 intrínsecos + calldata) | ${fmt(r.gas.verifyProof_estimateGas)} |\n`;
md += `| \`submitReceipt\` completo, todas | REAL (gasUsed do recibo minerado) | ${fmt(r.gas.submit_gasUsed_receipt_all)} |\n`;
md += `| \`submitReceipt\`, primeira inscrição | REAL | ${r.gas.submit_gasUsed_receipt_first} |\n`;
md += `| \`submitReceipt\`, seguintes | REAL | ${fmt(r.gas.submit_gasUsed_receipt_subsequent)} |\n`;
const c0 = r.gas.raw[0];
md += `| calldata da transação | contagem de bytes | ${c0.calldataBytes} bytes (${c0.calldataZeroBytes} zero, ${c0.calldataNonzeroBytes} não zero); custo de calldata DERIVADO (4/16 por byte) ${c0.calldataGas_4_16_derived} |\n`;
md += `| tempo envio → recibo | MEDIDO (relógio) | ${fmt(r.gas.sendToReceiptMs)} |\n\n`;
md += `Cada amostra é uma operação distinta (anti-replay); reenvio da primeira autorização recusado: ${c0.replayRefused}. Estimativa da transação completa antes do envio: ${c0.submit_estimateGas} (≠ gasUsed real ${c0.submit_gasUsed_receipt}).\n\n`;
md += `## Limites\n\n${r.limitations.map((l) => `- ${l}`).join('\n')}\n- O tempo envio→recibo é dominado pelo período de bloco de 2 s do IBFT; não foi derivado do gas.\n- Não há comparação v1/v2: circuito, contrato e chaves diferentes; a redução histórica de 19,2% não é reutilizada.\n`;
fs.writeFileSync(outMd, md);
console.log('ok');
