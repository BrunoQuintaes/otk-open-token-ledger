/**
 * Fast test stand-in for `reproducao/reproduzir_tudo.mjs` that succeeds: prints two OK items and the final
 * `TUDO OK` line in the same format as the real script, then exits with code 0.
 * Used where a test needs the rest of the live flow (receipts, tests button) without the full reproduction.
 *
 * @module test/reproducao_ao_vivo/fixtures/reproducao_ok
 */
console.log('Reprodução sem rede. Pasta de saída: (dublê de teste)\n');
console.log('OK      A. Item de exemplo — dublê');
console.log('OK      D. Outro item de exemplo — dublê');
console.log('\nTUDO OK: 2 de 2 itens. Detalhes em (dublê de teste)');
