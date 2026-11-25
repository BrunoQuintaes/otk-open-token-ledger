# Reprodução ao vivo (`npm run reproduzir-ao-vivo`)

Roda a mesma reprodução de `npm run reproduzir-tudo`, sem internet e sem chave, e abre sozinha, no navegador padrão, uma página local que mostra tudo numa aba só, com um índice fixo no topo:

1. **Refazendo agora**: os itens A a D aparecendo à medida que terminam (OK em verde, FALHOU em vermelho) e o veredito final.
2. **O caminho do OTK em 7 de outubro de 2026**: replay, chamada por chamada, das 662 chamadas reais, refeito dos registros do pacote da banca.
3. **O caminho do OTK em 23 de novembro de 2026**: replay dos 1.720 envios, refeito dos diários encadeados em `reproducao/cmp8/dados`.
4. **Conferindo os recibos**: o verificador roda sobre os recibos de exemplo e a página mostra os cartões, a tabela por recibo e o sha256 do relatório; abaixo, a página original do verificador, servida sem mudar nenhum byte, para a conferência manual.
5. **Testes automáticos (opcional)**: um botão roda `reproducao/testes_banca.mjs` (de 2 a 5 minutos) e mostra o resultado.

Ao abrir, tudo aparece como **para rodar**: os 13 itens da parte 1 (A: 2, B: 2, C: 4, D: 5), os dois dias com os contadores em 0, os recibos e os testes. Quando a reprodução começa, cada item passa para **rodando** e, na hora em que o passo termina, para **conferido** (verde) ou **falhou** (vermelho); um item que não chega a rodar fica **não rodou**. Os replays dos dois dias só começam depois da parte 1, um depois do outro, e os contadores sobem a partir de 0. O índice do topo mostra o estado de cada parte com as mesmas cores. Nada vem de rodada anterior: a página não usa armazenamento do navegador nem cookies, toda resposta do servidor vai com `Cache-Control: no-store`, e cada rodada tem servidor e porta novos.

Enquanto roda, a página **rola sozinha**, de forma suave, até o item ou a parte que está rodando, destacado com um contorno azul. Ela só rola para a frente e não rola quando o item já está na tela. Se a pessoa rolar à mão (roda do mouse, toque, teclado ou barra de rolagem), a rolagem automática pausa e aparece o botão **Voltar ao vivo**, que volta à parte atual e retoma. Com "reduzir movimento" ligado no sistema, a rolagem é instantânea.

Os números da página são calculados na hora, a partir dos arquivos do repositório. Na parte 3, o uso declarado vem do uso bruto do provedor gravado em `TENTATIVAS_CMP8.jsonl`, pela mesma regra da parte C, porque no diário do Google o uso lido ficou como desconhecido (UNKNOWN).

Nada sai do computador: o servidor escuta só em `127.0.0.1`, a página não carrega nada de fora e os programas rodam com a trava `reproducao/ferramentas/sem_rede.mjs`. A política de segurança da página (CSP) libera o script e o estilo embutidos só pelo sha256 de cada bloco, calculado pelo servidor ao subir, e não aceita nenhum outro código embutido. A página funciona aberta por `127.0.0.1` ou por `localhost`, com a porta que o terminal mostrou.

## Para rodar

**Onde rodar:** no PowerShell, dentro da pasta do repositório (a mesma do `npm run reproduzir-tudo`), depois do `npm ci`. No Mac, no Terminal, na mesma pasta.

```
npm run reproduzir-ao-vivo
```

O terminal mostra a mesma saída do `reproduzir-tudo` e, nas linhas que começam com `[ao vivo]`, o endereço da página, os contadores dos dois dias, a conferência dos recibos e, se rodarem, os testes. Quem não puder abrir o navegador entende tudo só pelo terminal. Se o navegador não abrir sozinho, o comando escreve `abra este endereço no navegador:` com o endereço.

No fim, a página fica no ar por **120 segundos** (ou enquanto os testes estiverem rodando) e o comando sai com o **mesmo código de saída** da reprodução (0 quando tudo deu OK). Ctrl+C encerra antes.

| Opção | O que faz |
|---|---|
| `-- --sem-navegador` | não abre o navegador; só escreve o endereço (modo dos testes) |
| `-- --com-testes` | roda os testes automáticos logo depois dos recibos, sem precisar do clique |
| `-- --manter-segundos 300` | deixa a página no ar por 300 s depois do fim (0 sai na hora) |
| `-- --esperar-pagina 30` | com `--sem-navegador`, espera até 30 s a página abrir antes de começar, para ela ver tudo desde "para rodar" |
| `-- --out <pasta>` | repassado ao `reproduzir-tudo` (pasta de saída vazia ou nova) |

`--reproducao <arquivo>` e `--testes-script <arquivo>` existem só para os testes, que trocam a reprodução e a bateria por dublês rápidos.

## Para testar

```
npm run test:ao-vivo
```

Roda, sem rede, os testes de `test/reproducao_ao_vivo/`: os números dos dois dias, o servidor (só `127.0.0.1`), o comando com `--sem-navegador` comparado ao `reproduzir-tudo`, a página num Edge ou Chrome sem janela (Playwright, com o navegador já instalado, sem baixar nada) e os casos de falha. Leva de 1 a 4 minutos, porque refaz a reprodução três vezes (o comando completo, a reprodução simples para comparar e a página completa). Se não houver Edge nem Chrome, os testes da página são pulados, com o motivo. Esses testes não entram na contagem do `npm run testes-banca`.

## Arquivos

- `reproduzir_ao_vivo.mjs`: o comando.
- `servidor.mjs`: o servidor local e os eventos (Server-Sent Events).
- `dados_dias.mjs`: lê e resume os registros dos dois dias.
- `etapas.mjs`: roda o verificador e os testes automáticos.
- `pagina.html`: a página, num arquivo só, com CSS e JS embutidos.
