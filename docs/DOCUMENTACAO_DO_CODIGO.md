# Documentação do código e prova de que só os comentários mudaram

*English version below.*

## O que é

Este ramo é a mesma lógica da versão avaliada na dissertação, com comentários no padrão de cada linguagem:
- **Cabeçalho em todo arquivo:** um bloco `/** … @module caminho */` que diz o que o arquivo faz, onde entra no fluxo e o que lê de configuração.
- **TSDoc no que é exportado:** comentário em toda função, classe, tipo e constante exportados, com `@param`, `@returns` e `@throws`.
- **Cabeçalho nos testes:** cada arquivo de teste diz o que testa, quais casos cobre, do que precisa e como rodar só ele.

- **Versão avaliada:** a tag `versao-avaliada`, commit `9cad91f`. O `src/` dela é idêntico byte a byte ao do commit `7606bc9b` citado na dissertação, fora a pasta nova `src/verifier/` (o verificador de recibos, feito depois) (ver `PROVENIENCIA.json`).
- **Este ramo:** nos arquivos de código da versão avaliada, tem a mesma lógica, só com comentários, e a prova está abaixo e, completa, em [PROVA_SO_COMENTARIOS.json](PROVA_SO_COMENTARIOS.json). Além disso, o commit `b2f51c5`, citado nesse arquivo como `head`, corresponde ao `06531cd` do `main` por conta da cópia dos commits, e por isso a prova foi refeita no `main`, com o mesmo resultado, que são 914 de 914 arquivos só com comentários e o mesmo hash agregado.
- **Comentários antigos:** foram mantidos, com o mesmo sentido. O texto deles mudou nestes casos:
  - o `@module` passou a ser o caminho do arquivo;
  - comentários de uma linha viraram blocos, com o mesmo texto e os `@param`/`@returns` que faltavam;
  - marcas antigas (`@param`, `@returns`, `@throws`, `@updated`) foram reescritas no formato TSDoc, às vezes com mais detalhe ou com a unidade da grandeza;
  - o nome próprio do autor virou "o autor".

  Nenhuma dessas mudanças altera o código (ver a prova).

  Esses comentários trazem códigos do processo de desenvolvimento (por exemplo, H1, S08, D1–D8). O que cada um quer dizer está em [GLOSSARIO_DE_CODIGOS.md](GLOSSARIO_DE_CODIGOS.md).

## A prova, em números

| Medida | Versão avaliada | Este ramo |
|---|---|---|
| Arquivos de código com comentários novos (`src/`, `scripts/`, `test/`) | — | 914 |
| Código compilado pelo esbuild, sem comentários: hash agregado | `bc48d612…80e2` (902 arquivos) | `bc48d612…80e2` (igual) |
| Lista de tokens do TypeScript, arquivo a arquivo | — | igual em todos |
| Espaço entre tokens (onde havia ou não havia) | — | igual em todos |
| `tsc --removeComments` (src e test): arquivos gerados e diferenças | 730 | 730, `diff -r` vazio |
| `tsc --removeComments` (scripts): arquivos gerados e diferenças | 339 | 339, `diff -r` vazio |
| `npm run testes-banca` | 3.587 testes: 3.579 passam, 0 falham, 5 pulados, 3 "todo" | 3.587 testes: em cada uma das duas rodadas completas, 1 teste sensível a tempo falhou com a máquina carregada (um diferente em cada rodada) e passou rodado sozinho; os outros 3.578 passam |
| `npm run reproduzir-tudo` | 13 de 13 | 13 de 13 (duas rodadas) |

Quanto ao teste de tempo do verificador, que confere 1.000 recibos em menos de 5 s, ele foi rodado alternadamente quatro vezes em cada versão, na mesma máquina, e deu de 4,4 a 5,7 s na versão avaliada e de 4,4 a 5,2 s neste ramo. Por conta disso, o limite depende da máquina, e não dos comentários.

Os commits de comentários não mudaram nada em `reproducao/`, `web/`, `chaveiro/`, `config/`, `package.json`, `package-lock.json` e `tsconfig.json`, nem nenhum arquivo JSON de dados. Já fora deles, o `main` ganhou o modo ao vivo (`reproducao/ao_vivo/`, `test/reproducao_ao_vivo/` e os atalhos `reproduzir-ao-vivo` e `test:ao-vivo` no `package.json`), que é código novo e por conta disso não faz parte desta prova.

Ficaram sem comentário novo, de propósito:
- os dois arquivos `.d.ts` de `src/types`, que já tinham cabeçalho;
- `test/unit/w7_stripe_billing.test.ts`, que é vazio na versão avaliada;
- `test/h2eval/econ/paridade_h_kit_v3_1.mjs`, cópia exata de um kit externo cujo sha256 é conferido por um teste.

## Conferir você mesmo

### Para ver quais arquivos ganharam comentários

Onde rodar: no PowerShell, dentro de `C:\otk` (o começo da linha deve mostrar `PS C:\otk>`), depois de `npm ci`.

```powershell
git diff --stat versao-avaliada HEAD -- src scripts test
```

Mac/Linux: o mesmo comando.

Mostra quantas linhas entraram em cada arquivo. Elas são comentários: o `tsc` com `--removeComments`, rodado nas duas versões, gera arquivos idênticos.

O que deve aparecer: uma lista de arquivos de `src/`, `scripts/` e `test/` e, no fim, `… files changed, … insertions(+), … deletions(-)`.

### Para conferir os comentários com o lint

Onde rodar: no PowerShell, dentro de `C:\otk` (o começo da linha deve mostrar `PS C:\otk>`).

```powershell
npm install --no-save eslint@10.15.0 typescript-eslint@8.74.0 eslint-plugin-jsdoc@65.5.5
npx eslint --config eslint.docs.config.mjs src
```

O primeiro comando instala, só para esta conferência e sem mudar o `package.json`, as ferramentas de lint. O segundo confere os comentários de `src/`. Por enquanto, essa conferência não roda automaticamente no GitHub: é só local. O primeiro comando usa a internet e acrescenta ferramentas ao `node_modules`, e por isso, para voltar à instalação exata antes das seções 6 a 9 do README, rode `npm ci` de novo.

O que deve aparecer: nenhuma linha de erro.

Sem imagem nesta seção: a saída depende da pasta e da máquina de quem roda. O texto esperado está em "O que deve aparecer", e os números medidos estão na tabela acima e em `PROVA_SO_COMENTARIOS.json`.

---

# Code documentation and proof that only comments changed

## What this is

This branch has the same logic as the version evaluated in the dissertation, plus comments in each language's standard format:
- **A header in every file:** a `/** … @module path */` block that says what the file does, where it sits in the flow and which configuration it reads.
- **TSDoc on exports:** a doc comment on every exported function, class, type and constant, with `@param`, `@returns` and `@throws`.
- **A header in every test file:** what it tests, which cases it covers, what it needs and how to run just that file.

- **Evaluated version:** the `versao-avaliada` tag, commit `9cad91f`. Its `src/` is byte-identical to that of commit `7606bc9b` cited in the dissertation, apart from the new `src/verifier/` folder (the receipt verifier, made later) (see `PROVENIENCIA.json`).
- **This branch:** in the code files of the evaluated version, the same logic, with comments only. The proof is in the table above and, in full, in [PROVA_SO_COMENTARIOS.json](PROVA_SO_COMENTARIOS.json). The commit `b2f51c5` cited there as `head` corresponds to `06531cd` on `main`, through the copy of the commits, and the proof was redone on `main` with the same result: 914 of 914 files with comments only and the same aggregate hash.
- **Older comments:** kept, with the same meaning. Their text changed in these cases:
  - `@module` now holds the file path;
  - one-line comments became blocks, with the same text plus the missing `@param`/`@returns`;
  - older tags (`@param`, `@returns`, `@throws`, `@updated`) were rewritten in TSDoc form, sometimes with more detail or with the unit of the quantity;
  - the author's first name became "the author".

  None of these changes alters the code (see the proof).

  These comments contain codes from the development process (for example H1, S08, D1–D8). Their meanings are in [GLOSSARIO_DE_CODIGOS.md](GLOSSARIO_DE_CODIGOS.md).

## The proof

The table above shows, for `src/`, `scripts/` and `test/`:
- the esbuild output without comments has the same aggregate hash;
- the TypeScript token lists are identical file by file;
- whitespace between tokens is present or absent in exactly the same places;
- `tsc --removeComments` produces byte-identical files (`diff -r` is empty);
- the test suite and the reproduction give the same numbers.

The comment commits changed nothing in `reproducao/`, `web/`, `chaveiro/`, `config/`, `package.json`, `package-lock.json`, `tsconfig.json` or any data JSON file. Apart from them, `main` gained the live mode (`reproducao/ao_vivo/`, `test/reproducao_ao_vivo/` and the `reproduzir-ao-vivo` and `test:ao-vivo` shortcuts in `package.json`), which is new code and not part of this proof.

## Check it yourself

Same commands as in the Portuguese section above:
- `git diff --stat versao-avaliada HEAD -- src scripts test` lists the lines added to each file;
- the two lint commands check the comments in `src/` (expected output: no error lines); the first uses the internet and adds tools to `node_modules`, so run `npm ci` again to go back to the exact installation.
