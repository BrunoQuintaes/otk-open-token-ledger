# Como conferir os recibos do OTK (para quem não é técnico)

O OTK entrega a cada cliente **recibos assinados** de uso de IA. Este verificador confere, **no seu computador e sem internet**, se os recibos não foram alterados depois de assinados e se foram assinados por uma chave do operador.

Você precisa de três coisas, que o operador entrega:

1. **A pasta de recibos**: arquivos `.jsonl` ou `.json`.
2. **O chaveiro público**: um arquivo `chaveiro.json`. Ele só traz endereços públicos, nunca uma senha ou chave privada.
3. **A impressão digital do chaveiro**: um texto de 64 letras e números (por exemplo `ef9d1aeb…bba24`). Ela tem de chegar por **outro caminho** (contrato assinado, site do operador), nunca junto com os recibos.

## Caminho A: pela página (mais fácil)

1. Abra o arquivo `verificador-otk.html` com dois cliques. Ele abre no navegador (testado no Edge; Chrome deve funcionar igual; Firefox e Safari ainda não foram testados). Pode desligar a internet antes: a página funciona igual.
2. Se for a primeira vez, abra o bloco **"Antes de começar: o que você precisa"** no topo. Depois arraste a **pasta de recibos** inteira para a área "Recibos" (ou use os botões "Escolher pasta" ou "Escolher arquivos").
3. Arraste o arquivo `chaveiro.json` para a área "Chaveiro" (ou use "Escolher chaveiro").
4. Cole a **impressão digital** no campo "Impressão digital do chaveiro".
5. Veja os três cartões no topo:
   - **OK · Verde**: recibo íntegro, assinado por chave ativa, com chaveiro conferido.
   - **Atenção · Amarelo**: falta alguma garantia (por exemplo, você não colou a impressão digital, ou a chave já foi aposentada). Leia o motivo. Quando a assinatura não pôde ser conferida (chave que não está no chaveiro, versão de formato desconhecida, formato antigo), o recibo aparece com o aviso "não entra nas somas" e os números dele ficam fora dos totais e da conciliação.
   - **Falhou · Vermelho**: o recibo foi alterado, a assinatura não confere ou a chave foi revogada. Não use os números dele.
6. Clique numa linha da tabela para ver, em português, **o que aconteceu**, **o que isso significa** e **o que isso não garante**.
7. Para guardar: clique em "Baixar relatório (JSON)" ou "Baixar planilha (CSV)", ou em "Imprimir ou salvar em PDF".

Deu certo quando: os cartões mostram números e, sem a impressão digital, nenhum recibo aparece verde (aparece amarelo, com o aviso "chaveiro não confirmado (não ancorado)"). Isso é o esperado.

## Caminho B: pelo terminal (para quem já usa a linha de comando)

Abra o PowerShell (menu Iniciar → digite PowerShell → Enter), entre na pasta do OTK com `cd <pasta do OTK>` e cole esta linha:

```
npm run otk -- verify <pasta-de-recibos> --keyring chaveiro.json --fingerprint <impressão digital>
```

Cada recibo aparece como `[OK]`, `[ATENÇÃO]` ou `[FALHOU]`, com o motivo, seguido de um resumo e do quadro "O que isto NÃO garante". O código de saída é 0 (tudo verde), 10 (há amarelo), 20 (há vermelho) ou 2 (comando digitado errado). Com `--json` sai o relatório completo; o sha256 dele é o mesmo que a página mostra para os mesmos arquivos.

Para conferir a impressão digital (o sha256, um resumo de 64 caracteres que muda se qualquer letra do arquivo mudar) sem o verificador: no Windows, `Get-FileHash chaveiro.json` (PowerShell); no Linux/Mac, `sha256sum chaveiro.json`. O resultado tem de ser igual ao que o operador publicou.

**Cuidado com o fim de linha.** A impressão digital é calculada sobre os bytes exatos do arquivo. Se o `chaveiro.json` passar por um programa que troca o fim de linha (por exemplo, o Git no Windows com conversão automática, um editor que salva com CRLF, ou um e-mail que reformata o anexo), a impressão digital muda e o verificador mostra vermelho "impressão digital não confere". Os recibos não foram alterados nesse caso: peça ao operador o arquivo original (de preferência compactado em .zip) e confira de novo.

## O que isto NÃO garante

- Não prova que o provedor de IA cobrou esse valor: o recibo é do operador OTK. Para isso existe a conciliação com o relatório do provedor.
- Não prova que o contador do OTK estava certo; só que os números não mudaram depois de assinados.
- Quem tem a chave do operador pode assinar um recibo diferente ou deixar de emitir um recibo.
- A data da assinatura é declarada por quem assina.
- O verificador confere os recibos que recebeu; não sabe se faltam recibos.

## Para o operador

**Tirar os recibos do banco.** Os recibos ficam no PostgreSQL do OTK. Para entregar um período ao cliente, no PowerShell, dentro da pasta do OTK, cole:

```
npm run otk -- receipts export --since 2026-11-01 --until 2026-11-30 --tenant <cliente> --out recibos_novembro --pg-env <NOME_DA_VARIAVEL>
```

`--pg-env` recebe o **nome** da variável de ambiente que guarda a URL do banco (a mesma usada pelo `reconcile.ts`), nunca a URL. O comando grava `recibos_<inicio>_<fim>_<cliente>.jsonl` e um `MANIFEST_….json` com a contagem e o sha256 do arquivo. O período usa a data de admissão do recibo (UTC, dias inclusivos).

**Publicar o chaveiro.** O chaveiro tem de incluir as chaves antigas (aposentadas e revogadas), senão os recibos antigos aparecem como "chave fora do chaveiro". Mantenha um **histórico de chaves** num arquivo versionado junto com a configuração de operação (sugestão: `config/keyring/historico_chaves.json`, fora da pasta de segredos, porque só tem endereços públicos), no formato:

```json
{ "keys": [
  { "keyId": "otk-v3-operator-1", "address": "0x…", "status": "retired", "retiredAt": "2026-11-10T00:00:00.000Z", "nota": "rotação" },
  { "keyId": "otk-v3-operator-2", "address": "0x…", "status": "active" }
] }
```

A cada rotação (nova chave ativa, aposentadoria ou revogação), atualize esse arquivo e gere o chaveiro (PowerShell, dentro da pasta do OTK):

```
npm run otk -- keyring export --history config/keyring/historico_chaves.json --operator "<nome do operador>" --out chaveiro.json
```

O comando imprime a impressão digital. Publique-a por outro canal (contrato, site). Entregue o `chaveiro.json` sem conversão de fim de linha (no Git, marque-o com `-text` no `.gitattributes`; por e-mail, mande compactado), senão a impressão digital do cliente não bate. `--key <keyId>=<endereço>,<estado>[,<retiredAt>]` permite mudar o estado de uma chave na hora sem editar o histórico. Hoje o OTK em execução só conhece a chave ativa (o `keyId` de `OTK_V3_OPERATOR_KEY_ID`); ele não guarda histórico sozinho, por isso o arquivo de histórico é responsabilidade do operador.

**Anel público do bot.** O verificador também aceita, como `--keyring`, o anel público do bot (`otk.bridge.keyring_file.v1`, por exemplo `otk_keyring_b5f.json`): ele tem as mesmas chaves (identificador, endereço, estado e data de aposentadoria) sem o nome do operador, e é lido por conversão sem perder nada. A impressão digital é sempre a do arquivo que foi carregado: para o anel do bot, o sha256 dele (o mesmo que o bot declara). Para entregar um chaveiro no formato do OTK com o nome do operador:

```
npm run otk -- keyring convert otk_keyring_b5f.json --operator "OTK A2 C160" --out chaveiro.json
```

O comando imprime as duas impressões digitais (a do anel de entrada e a do chaveiro convertido). O nome do operador entra no arquivo convertido, então a impressão digital dele muda se o nome mudar. Para o anel B5F com `--operator "OTK A2 C160"` ela é `c9dcbb90ec0b9fd79a1da4764821e11f5a46f9073a3c991f00c1daa000f72fdc`. Um arquivo que não é nenhum dos dois formatos sai como amarelo "formato de chaveiro não reconhecido" (escolha o arquivo certo); isso não indica adulteração.

**Conciliar só com recibos verificados.** `scripts/reconciliation/reconcile.ts` aceita `--otk-receipts=<pasta> --keyring=chaveiro.json --fingerprint=<sha256>`; só entram recibos cuja assinatura foi conferida (verdes e amarelos com assinatura válida); os vermelhos e os amarelos sem assinatura conferida saem listados com o motivo.
