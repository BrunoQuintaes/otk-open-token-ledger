/**
 * Slow test stand-in for `reproducao/reproduzir_tudo.mjs`: prints the same 13 item lines (A: 2, B: 2, C: 4, D: 5)
 * and the final `TUDO OK` line, in the same format as the real script, with a pause before each item, then exits
 * with 0. Used to watch the page move each item from "para rodar" to "rodando" to "conferido", and to follow it
 * by scrolling. Reads nothing, writes nothing.
 *
 * Optional argument: `--atraso-ms <n>`, the pause before each item in milliseconds (default 700).
 *
 * @module test/reproducao_ao_vivo/fixtures/reproducao_lenta
 */
const DEFAULT_DELAY_MS = 700;
const flagIndex = process.argv.indexOf('--atraso-ms');
const delayMs = flagIndex > 0 ? Number(process.argv[flagIndex + 1]) : DEFAULT_DELAY_MS;
const ITEMS = [
  ['A', 'ZIP do pacote da banca (dublê)'], ['A', 'Pacote (dublê)'],
  ['B', 'Tabela .tex (dublê)'], ['B', 'Tabela JSON (dublê)'],
  ['C', 'Linhas (dublê)'], ['C', '.tex (dublê)'], ['C', 'JSON (dublê)'], ['C', 'Registro antes (dublê)'],
  ['D', 'Recibos (dublê)'], ['D', 'Com impressão (dublê)'], ['D', 'Sem impressão (dublê)'], ['D', 'Chaveiro (dublê)'], ['D', 'Página (dublê)'],
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log('Reprodução sem rede. Pasta de saída: (dublê de teste)\n');
for (const [part, name] of ITEMS) {
  await pause(delayMs);
  console.log(`OK      ${part}. ${name} — dublê`);
}
console.log(`\nTUDO OK: ${ITEMS.length} de ${ITEMS.length} itens. Detalhes em (dublê de teste)`);
