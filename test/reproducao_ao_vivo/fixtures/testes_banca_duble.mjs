/**
 * Test stand-in for `reproducao/testes_banca.mjs`: prints a few progress lines and the `Resultado:` summary line
 * in the same format as the real suite, in well under a second, and exits with 0, as the real suite does when everything passes.
 * Used by the tests of the page button and of `--com-testes` (`--testes-script <this file>`).
 *
 * @module test/reproducao_ao_vivo/fixtures/testes_banca_duble
 */
console.log('Rodando 2 arquivos de teste, sem rede (dublê de teste)...\n');
console.log('Bateria principal terminada; agora o teste de tempo do verificador, sozinho...');
console.log('\nResultado: 3 testes — 3 passaram, 0 falharam, 0 cancelados, 0 pulados, 0 "todo".');
console.log('Saída completa em (dublê de teste)');
console.log('\nTESTES OK');
