# Verificador de recibos OTK: como usar a página

A página `verificador-otk.html` confere, no seu computador e sem internet, se os recibos do OTK foram alterados depois de assinados. Ela não envia nada para fora.

**Código sha256 desta página:** `2bef5dd84fcf7289ae5e76cf74e329eb6bda55f479415b898da364786efdc2fc`

Antes de abrir, confira que o arquivo é este:
- Windows (PowerShell): `Get-FileHash verificador-otk.html` (a coluna Hash tem de ser igual ao código acima, sem diferença de maiúsculas)
- Mac ou Linux: `shasum -a 256 verificador-otk.html`

## Antes de começar: o que você precisa

### 1. Os recibos do OTK: o que são e onde acho
- São os **recibos do OTK**: um por chamada de IA, assinado pelo próprio OTK no momento da chamada (formato `otk.receipt.v3`).
- **Não são** as faturas nem os relatórios de uso que se baixam nas páginas da OpenAI, Anthropic ou Google. Esses servem para conferir os totais com o provedor (a conciliação), que é outra coisa e fica para uma próxima versão da página.
- **Onde ficam:** o OTK guarda os recibos no banco de dados dele (PostgreSQL), não numa pasta. Para ter a pasta, quem opera o OTK exporta:
  `otk receipts export --since AAAA-MM-DD --until AAAA-MM-DD --out <pasta> --pg-env <NOME_DA_VARIAVEL> [--tenant <cliente>]`
  A pasta de destino é a que a pessoa escolher em `--out` (por exemplo, `recibos_novembro`). Dentro dela ficam `recibos_<início>_<fim>.jsonl` e um `MANIFEST_….json` com a contagem e o sha256 do arquivo (o manifesto não é recibo; a página o reconhece). Em `--pg-env` vai só o **nome** da variável que guarda o endereço do banco, nunca o endereço.
- Sem esse comando, cada recibo pode ser baixado um a um pela rota `GET /v1/operations/{id}/conference` (permissão `receipts:read`), que gera um `.json` por operação.
- Se você recebeu os arquivos do operador (um `.jsonl`, como `recibos_2026-11-01_2026-11-30.jsonl`, ou vários `.json`), é só arrastar a pasta inteira na área "Recibos" da página.

### 2. O chaveiro público: o que é e como consigo
- É a lista das chaves de assinatura de quem opera o OTK. Para cada chave: um identificador, o endereço público e se ela está ativa, aposentada (com data) ou revogada. **Não tem nada secreto** e serve só para conferir quem assinou.
- **Como conseguir:** quem opera gera com `otk keyring export --history historico_chaves.json --out chaveiro.json`, que também mostra a impressão digital (sha256) do arquivo. Chaves antigas (aposentadas ou revogadas) entram no mesmo arquivo, a partir do histórico de chaves que o operador mantém (o `historico_chaves.json` do `--history`). Se faltar uma chave antiga, os recibos dela aparecem em amarelo ("chave que não está no chaveiro") e não entram nas somas. Uma chave que está no chaveiro como revogada, ou aposentada antes da data do recibo, dá vermelho mesmo que o recibo declare outro identificador de chave.
- **Anel do bot:** a página também aceita o anel público do bot (por exemplo `otk_keyring_b5f.json`), com as mesmas chaves. Ela o lê por conversão, sem perder nenhuma chave, e avisa isso no resultado. A impressão digital é sempre a do arquivo carregado: a do anel do bot não é a mesma do chaveiro convertido com `otk keyring convert`. Um arquivo que não é chaveiro do OTK nem anel do bot aparece em amarelo, "Formato de chaveiro não reconhecido": provavelmente foi escolhido o arquivo errado.
- **Impressão digital:** é o "número de conferência" do chaveiro. O operador deve publicar esse número num lugar que ele não consiga trocar depois junto com o arquivo (contrato, site, e-mail assinado). Colando na página, ela confere que o chaveiro é o mesmo; sem ela, o melhor veredito é amarelo ("chaveiro não confirmado").
- **Cuidado com o fim de linha.** A impressão digital é calculada sobre os bytes exatos do arquivo. Se o `chaveiro.json` passar por um programa que troca o fim de linha (por exemplo, o Git no Windows com conversão automática, um editor que salva com CRLF, ou um e-mail que reformata o anexo), a impressão digital muda e o verificador mostra vermelho "impressão digital não confere". Os recibos não foram alterados nesse caso: peça ao operador o arquivo original (de preferência compactado em .zip) e confira de novo.

## Como abrir
1. Se quiser, desligue o Wi-Fi. A página funciona igual.
2. Dê dois cliques em `verificador-otk.html`. Ela abre no navegador (testada no Edge; deve abrir também no Chrome e no Firefox).

## Os três passos
1. **Traga os recibos:** arraste a pasta (por exemplo `recibos_novembro`) ou os arquivos (`recibos_2026-11-01_2026-11-30.jsonl`, `op-123.json`) para a área "Recibos" do passo 1, ou use "Escolher pasta" / "Escolher arquivos".
2. **Traga o chaveiro público:** arraste `chaveiro.json` para a área "Chaveiro" do passo 2. Se tiver a impressão digital, cole no campo "Impressão digital do chaveiro" (com ou sem `0x`, maiúsculas ou minúsculas).
3. Clique em **Conferir recibos**.

## Como ler o veredito
Cada recibo recebe um selo com ícone, palavra e cor:

| Selo | Quer dizer |
|---|---|
| ✔ **OK** (verde) | O recibo está íntegro e foi assinado por uma chave ativa do chaveiro confirmado. Ninguém mudou os números depois da assinatura. |
| ⚠ **Atenção** (amarelo) | Há uma ressalva: chaveiro não confirmado, chave aposentada, perfil de desenvolvimento, uso incompleto ou declarado pelo cliente, linha cortada; ou a assinatura não pôde ser conferida (chave que não está no chaveiro, formato antigo ou desconhecido), e então o recibo traz o aviso "não entra nas somas". Leia o motivo. |
| ✖ **Falhou** (vermelho) | O recibo não confere: foi alterado depois de assinado, a assinatura não bate, a chave foi revogada, o documento é de outro tipo ou está ligado a outro recibo, ou o arquivo está ilegível. Não use esse recibo como prova. |

- Os **cartões** no alto contam quantos itens deram OK (verde), Atenção (amarelo) e Falhou (vermelho).
- **desconhecido** quer dizer que o número não foi informado ou não pôde ser calculado. Nunca é zero, e não entra nas somas como zero.
- Clique em uma linha (ou em "Ver detalhe") para ver três blocos: **O que aconteceu**, **O que isso significa** e **O que isso NÃO garante**.
- O **filtro por período** usa datas digitadas em dd/mm/aaaa (por exemplo 05/11/2026), em qualquer idioma do navegador, e muda só o que aparece na tela; o relatório e a planilha baixados trazem tudo.
- O **código de conferência do relatório (sha256)** é o mesmo que o comando `otk verify --json` gera com os mesmos arquivos. Se você e um auditor obtêm o mesmo código, viram o mesmo relatório.
- **Baixar relatório (JSON)** grava o relatório idêntico ao do comando; **Baixar planilha (CSV)** abre no Excel; **Imprimir ou salvar em PDF** usa a impressão do navegador.

## O que este verificador NÃO garante
- Não prova que o provedor contou certo (isso é a conciliação com o relatório do provedor).
- Não prova que o contador do OTK estava certo; só que os números não mudaram depois de assinados.
- Quem tem a chave do operador pode assinar outro recibo no lugar, ou não emitir recibo.
- A data de assinatura é declarada por quem assina.
- Não sabe se faltam recibos.
- O chaveiro é a raiz de confiança: a impressão digital tem de vir por outro canal.
- A opinião do operador sobre si mesmo (campo `verification` das exportações) é ignorada.
