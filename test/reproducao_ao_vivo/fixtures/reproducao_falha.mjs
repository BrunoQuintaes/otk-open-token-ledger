/**
 * Test stand-in for `reproducao/reproduzir_tudo.mjs` that fails on purpose: prints one OK item, one FALHOU item
 * and the failing final line in the same format as the real script, then exits with code 1.
 * Used by the failure tests of the live reproduction (`--reproducao <this file>`). Reads nothing, writes nothing.
 *
 * @module test/reproducao_ao_vivo/fixtures/reproducao_falha
 */
console.log('Reprodução sem rede. Pasta de saída: (dublê de teste)\n');
console.log('OK      A. Item de exemplo que passa — dublê');
console.log('FALHOU  B. Item de exemplo que falha de propósito — erro: dublê de teste');
console.log('\nALGO FALHOU: 1 de 2 itens. Detalhes em (dublê de teste)');
process.exit(1);
