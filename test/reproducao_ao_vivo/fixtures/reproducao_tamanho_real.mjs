/**
 * Test stand-in for `reproducao/reproduzir_tudo.mjs` whose 13 item lines are copied from a real run of
 * `npm run reproduzir-tudo`, so the page lays them out with the real heights (long hashes and details). Prints
 * them with a pause before each one and the final `TUDO OK` line, then exits with 0. Reads nothing, writes nothing.
 * Used to check that the follow-scroll keeps the running item inside the window.
 *
 * Optional argument: `--atraso-ms <n>`, the pause before each item in milliseconds (default 600).
 *
 * @module test/reproducao_ao_vivo/fixtures/reproducao_tamanho_real
 */
const DEFAULT_DELAY_MS = 600;
const flagIndex = process.argv.indexOf('--atraso-ms');
const delayMs = flagIndex > 0 ? Number(process.argv[flagIndex + 1]) : DEFAULT_DELAY_MS;
/** The 13 lines exactly as a real run printed them. */
const REAL_LINES = [
  "OK      A. ZIP do pacote da banca tem o sha256 esperado (3943637b…) — 3943637bef45c2c21a6b143f0cfa8829f22df70b306e85901cbdb23ade738224",
  "OK      A. Pacote: hashes, sanitização, H1 de 7/10 (30 de 30 arquivos) e CAL-ANTH (19 de 20) — ✓ 1. SHA256SUMS confere; ✓ 2. scanner de sanitização (pacote inteiro); ✓ 3. controle negativo do scanner; ✓ 4. reprodução H1; ✓ 5. reprodução CAL-ANTH",
  "OK      B. Tabela dos 8 modelos (CMP8): .tex idêntico byte a byte ao auditado — 5a9d6feac2f9e51c5880141f1e6225d3f836d93f97c4fd4aeb8c58f8c223785d",
  "OK      B. Tabela dos 8 modelos (CMP8): JSON igual ao auditado (tabela_cmp8.json V1_3, sha baed13cf…), fora data e caminhos — esperado baed13cfa673…",
  "OK      C. Estimado × declarado: as 1.720 linhas (texto × modelo) idênticas byte a byte às auditadas — 8608af93a993e1e23e3b1795e6c8335e056d8071950abd388174cb0fd10752f4",
  "OK      C. Estimado × declarado: .tex idêntico byte a byte ao auditado — 4e0d854729616f85778016b9612ba682050f49a8d1fb025b4ce5091c7e7085f2",
  "OK      C. Estimado × declarado: JSON igual ao auditado (tabela_estimado.json V2, sha 685654f6…), fora data e caminhos — esperado 685654f672dd…",
  "OK      C. Registro da contagem gravado ANTES de cada envio (cadeia do journal conferida; contagens iguais às auditadas) — 1720 de 1720 envios com o registro gravado antes; 1505 deles com a contagem do OTK",
  "OK      D. Verificador: os recibos de exemplo no disco são os que o código gera (19 arquivos) — conferidos 19 arquivos, 0 diferentes",
  "OK      D. Verificador: relatório dos recibos de exemplo com a impressão digital igual ao esperado — sha bbcfeed1d0cf…, código de saída 20",
  "OK      D. Verificador: relatório dos recibos de exemplo sem a impressão digital igual ao esperado — sha 91e064cf527c…, código de saída 20",
  "OK      D. Chaveiro do operador: impressão digital igual à publicada na dissertação (c9dcbb90…) — c9dcbb90ec0b9fd79a1da4764821e11f5a46f9073a3c991f00c1daa000f72fdc",
  "OK      D. Página do verificador: sha256 igual ao registrado (2bef5dd8…) — 2bef5dd84fcf7289ae5e76cf74e329eb6bda55f479415b898da364786efdc2fc"
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log('Reprodução sem rede. Pasta de saída: (dublê de teste)\n');
for (const line of REAL_LINES) {
  await pause(delayMs);
  console.log(line);
}
console.log(`\nTUDO OK: ${REAL_LINES.length} de ${REAL_LINES.length} itens. Detalhes em (dublê de teste)`);
