/**
 * Test stand-in for `reproducao/testes_banca.mjs` in the case where only the speed test went over its limit: prints
 * the `Resultado:` line with 1 failure and the `TESTES OK, com aviso: ...` verdict, in the same format as the real
 * suite, and exits with 0 (as the real suite does in that case). Used to check that the page shows the warning.
 *
 * @module test/reproducao_ao_vivo/fixtures/testes_banca_duble_aviso
 */
console.log('Rodando 2 arquivos de teste, sem rede (dublê de teste)...\n');
console.log('✖ desempenho: 1.000 recibos verificados em menos de 5 s (8439.8654ms)');
console.log('\nResultado: 3 testes — 2 passaram, 1 falharam, 0 cancelados, 0 pulados, 0 "todo".');
console.log('Saída completa em (dublê de teste)');
console.log('\nTESTES OK, com aviso: o teste de tempo "desempenho: 1.000 recibos verificados em menos de 5 s" passou do limite (8,4 s; limite 5 s). Ele mede velocidade, não correção; com o computador ocupado isso acontece. Feche outros programas e rode de novo se quiser vê-lo passar.');
