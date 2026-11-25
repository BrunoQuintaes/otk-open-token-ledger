# Reprodução ao vivo (`npm run reproduzir-ao-vivo`)

Roda a mesma reprodução de `npm run reproduzir-tudo`, sem internet e sem chave, e abre sozinha, no navegador padrão, uma página local que mostra tudo numa aba só, com um índice fixo no topo:

1. **Refazendo agora**: os 13 itens A a D, que começam como *para rodar* e passam a *conferido* (verde) ou *falhou* (vermelho) à medida que terminam, e o veredito final.
2. **O caminho do OTK em 7 de outubro de 2026**: replay, chamada por chamada, das 662 chamadas reais, mostradas de novo a partir dos registros do pacote da banca. Das 662, 658 têm a assinatura do recibo conferida e 4 ficaram sem a checagem: 3 barradas pela cota do próprio OTK (HTTP 429), que não chegaram ao provedor, e 1 recusada pela OpenAI (HTTP 400).
3. **O caminho de cada envio em 23 de novembro de 2026 (programa de coleta, sem o proxy)**: replay dos 1.720 envios, mostrados de novo a partir dos diários encadeados em `reproducao/cmp8/dados`.
4. **Conferindo os recibos**: o verificador roda sobre os recibos de exemplo e a página mostra os cartões, a tabela por recibo e o sha256 do relatório; abaixo, a página original do verificador, servida sem mudar nenhum byte, para a conferência manual.
5. **Testes automáticos (opcional)**: um botão roda `reproducao/testes_banca.mjs` (de 2 a 6 minutos) e mostra o resultado. O botão só fica disponível quando a reprodução e os recibos terminam (antes disso o servidor recusa o pedido), para os testes não carregarem o computador durante a reprodução; depois que o comando sai, ele fica desligado com o aviso "o comando terminou; rode de novo para usar os testes".

Nas partes 2 e 3, a coluna da contagem do OTK mostra o número sem a correção por modelo (na Anthropic e no Google é só uma estimativa); a comparação com a correção aplicada é a do item C da parte 1.

Ao abrir, tudo aparece como **para rodar**, em cinza: os 13 itens da parte 1 (A: 2, B: 2, C: 4, D: 5), os dois dias com os contadores em 0, os recibos e os testes. Quando a reprodução começa, o próximo item da lista passa para **rodando** (amarelo) e, na hora em que o passo termina, para **conferido** (verde) ou **falhou** (vermelho); um item que não chega a rodar fica **não rodou**. Se o comando parar no meio (Ctrl+C ou erro), o que estava rodando fica **interrompido**, e nada fica "rodando" para sempre. A parte 5 continua **para rodar** até alguém clicar no botão, e isso não é falha. Os replays dos dois dias só começam depois da parte 1, um depois do outro, e os contadores sobem a partir de 0. O índice do topo mostra o estado de cada parte com as mesmas cores. Nada vem de rodada anterior: a página não usa armazenamento do navegador nem cookies, toda resposta do servidor vai com `Cache-Control: no-store`, e cada rodada tem servidor e porta novos.

Enquanto roda, a página **rola sozinha**, de forma suave, até o item ou a parte que está rodando, destacado com um contorno azul. Ela mira o item que está rodando: se ele sair da tela, acima ou abaixo (a parte 1 tem duas colunas, e o próximo item pode estar mais acima, na coluna ao lado), ela rola até ele; não volta para uma parte que já terminou e não rola quando o item já está na tela. Se a pessoa rolar à mão (roda do mouse, toque, teclado ou barra de rolagem), a rolagem automática pausa e aparece o botão **Voltar ao vivo**, que volta à parte atual e retoma. Com "reduzir movimento" ligado no sistema, a rolagem é instantânea.

Os números da página são calculados na hora, a partir dos arquivos do repositório. Na parte 3, o uso declarado vem do uso bruto do provedor gravado em `TENTATIVAS_CMP8.jsonl`, pela mesma regra da parte C, porque no diário do Google o uso lido ficou como desconhecido (UNKNOWN).

Nada sai do computador: o servidor escuta só em `127.0.0.1`, a página não carrega nada de fora e os programas rodam com a trava `reproducao/ferramentas/sem_rede.mjs`. A política de segurança da página (CSP) libera o script e o estilo embutidos só pelo sha256 de cada bloco, calculado pelo servidor ao subir, e não aceita nenhum outro código embutido. A página funciona aberta por `127.0.0.1` ou por `localhost`, com a porta que o terminal mostrou.

## Para rodar

**Onde rodar:** no PowerShell, dentro da pasta do repositório (a mesma do `npm run reproduzir-tudo`), depois do `npm ci`. No Mac, no Terminal, na mesma pasta.

```
npm run reproduzir-ao-vivo
```

O terminal mostra a mesma saída do `reproduzir-tudo` e, nas linhas que começam com `[ao vivo]`, o endereço da página, os contadores dos dois dias, a conferência dos recibos e, se rodarem, os testes. Quem não puder abrir o navegador vê os mesmos resultados no terminal; só o replay chamada a chamada das partes 2 e 3 fica apenas na página. Se o navegador não abrir sozinho, o comando escreve `abra este endereço no navegador:` com o endereço.

No fim, a página fica no ar por **120 segundos** depois dos recibos (ou enquanto os testes estiverem rodando) e o comando sai com o **mesmo código de saída** da reprodução (0 quando tudo deu OK), também quando a conferência dos recibos falha. Ctrl+C encerra antes: depois do fim da reprodução, o código continua o dela; antes, é 130.

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

Roda, sem rede, os testes de `test/reproducao_ao_vivo/`: os números dos dois dias, o servidor (só `127.0.0.1`), o comando com `--sem-navegador` comparado ao `reproduzir-tudo`, a página num Edge ou Chrome sem janela (Playwright, com o navegador já instalado, sem baixar nada) e os casos de falha. Leva de 1 a 6 minutos (mais numa máquina ocupada), porque refaz a reprodução três vezes (o comando completo, a reprodução simples para comparar e a página completa). Se não houver Edge nem Chrome, os testes da página são pulados, com o motivo. Esses testes não entram na contagem do `npm run testes-banca`.

No `npm run testes-banca`, se a única falha for um teste de tempo da lista fixa `SPEED_TESTS` de `reproducao/testes_banca.mjs` (hoje só *desempenho: 1.000 recibos verificados em menos de 5 s*), o fim mostra `TESTES OK, com aviso: ...` e o código de saída é 0, porque esse teste mede a velocidade do computador, não se o código está certo. Qualquer outra falha continua dando `HOUVE FALHA` e código 1.

## Arquivos

- `reproduzir_ao_vivo.mjs`: o comando.
- `servidor.mjs`: o servidor local e os eventos (Server-Sent Events).
- `dados_dias.mjs`: lê e resume os registros dos dois dias.
- `etapas.mjs`: roda o verificador e os testes automáticos.
- `pagina.html`: a página, num arquivo só, com CSS e JS embutidos.
