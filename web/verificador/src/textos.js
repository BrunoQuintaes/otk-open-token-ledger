// Textos da página em português simples (VERIFICADOR_WEB, C160).
// Os três textos de cada veredito (o que aconteceu / significa / não garante) vêm do núcleo,
// para a página e o comando dizerem a mesma coisa. Os textos abaixo são só reserva: aparecem
// quando um item do relatório chega sem texto, e nunca deixam um código cru sozinho na tela.

export const ROTULO = {
  verde: { icone: '✔', palavra: 'OK', longo: 'Confere' },
  amarelo: { icone: '⚠', palavra: 'Atenção', longo: 'Confere com ressalva' },
  vermelho: { icone: '✖', palavra: 'Falhou', longo: 'Não confere' },
};

const NAO_GARANTE_PADRAO =
  'Não garante que o provedor cobrou esse valor, que o contador do OTK estava certo, nem que o operador não poderia ter assinado outro recibo no lugar.';

// Reserva por código. Chave = código do núcleo (VerifyFailure ou aviso).
export const RESERVA = {
  ok: {
    reasonPt: 'Recibo íntegro e assinado por uma chave ativa do operador.',
    meaningPt: 'Ninguém alterou nenhum número deste recibo desde que o OTK o assinou.',
  },
  digest_mismatch: {
    reasonPt: 'Este recibo foi alterado depois de assinado.',
    meaningPt: 'Algum campo (tokens, CU, cliente, operação, configuração…) não é o que foi assinado.',
  },
  bad_signature: {
    reasonPt: 'A assinatura não confere.',
    meaningPt: 'O recibo ou o envelope foram mexidos, ou a assinatura é de outra chave.',
  },
  revoked_key: {
    reasonPt: 'Assinado por uma chave revogada (ou por chave aposentada depois da data de aposentadoria).',
    meaningPt: 'O operador retirou a confiança desta chave; o que ela assina não vale como prova.',
  },
  wrong_domain: {
    reasonPt: 'A assinatura é de outro tipo de documento, não de um recibo.',
    meaningPt: 'Alguém pode ter reaproveitado uma assinatura válida de outro papel.',
  },
  binding_mismatch: {
    reasonPt: 'Este documento está ligado a outro recibo, não a este.',
    meaningPt: 'A conferência ou a atribuição foi movida de um recibo para outro.',
  },
  malformed: {
    reasonPt: 'O arquivo está com formato inválido ou incompleto.',
    meaningPt: 'Não foi possível ler o recibo inteiro; ele não pode ser conferido.',
  },
  unauthorized_signer: {
    reasonPt: 'A chave que assinou não está no chaveiro que você carregou.',
    meaningPt: 'Pode ser chaveiro desatualizado. Confira com o operador antes de confiar.',
  },
  unsupported_version: {
    reasonPt: 'Versão de formato que este verificador não conhece.',
    meaningPt: 'O recibo pode estar certo, mas esta versão do verificador não sabe conferi-lo.',
  },
  retired_key: {
    reasonPt: 'Assinado por chave já aposentada, com data anterior à aposentadoria. A data é declarada por quem assina.',
    meaningPt: 'A assinatura vale, mas a data não é prova independente.',
  },
  keyring_not_anchored: {
    reasonPt: 'O chaveiro não foi conferido por uma impressão digital vinda de outro canal.',
    meaningPt: 'As assinaturas conferem com o chaveiro carregado, mas não há prova de que o chaveiro é o verdadeiro do operador.',
  },
  keyring_unknown_format: {
    reasonPt: 'Formato de chaveiro não reconhecido.',
    meaningPt: 'O arquivo escolhido como chaveiro não é o chaveiro do OTK nem o anel do bot. Isso não indica que foi mexido; escolha o chaveiro que o operador entregou.',
  },
  legacy_format: {
    reasonPt: 'Recibo em formato antigo.',
    meaningPt: 'Foi conferido pelo algoritmo antigo, que cobre menos campos.',
  },
  development_profile: {
    reasonPt: 'Recibo gerado em perfil de desenvolvimento.',
    meaningPt: 'Os números não vêm da configuração de produção.',
  },
  usage_incomplete: {
    reasonPt: 'O uso de tokens está incompleto ou estimado.',
    meaningPt: 'Os números podem ser menores ou diferentes do uso real.',
  },
  client_declared: {
    reasonPt: 'O uso foi declarado pelo cliente, não observado pelo OTK.',
    meaningPt: 'O OTK assinou o que recebeu, sem medir por conta própria.',
  },
  conflict: {
    reasonPt: 'A mesma operação aparece com dois resumos diferentes.',
    meaningPt: 'Existem duas versões do mesmo recibo; ao menos uma não é a assinada.',
  },
  truncated_line: {
    reasonPt: 'Linha cortada ou ilegível no arquivo de recibos.',
    meaningPt: 'Parte do arquivo não pôde ser lida; ela foi relatada, não ignorada.',
  },
};

export function reservaPara(code) {
  const r = RESERVA[code];
  return {
    reasonPt: r ? r.reasonPt : 'Resultado sem explicação conhecida por esta página.',
    meaningPt: r ? r.meaningPt : 'Peça ao operador ou a um auditor que explique este código.',
    notGuaranteedPt: NAO_GARANTE_PADRAO,
  };
}

// Quadro fixo de limites (desenho §3(f)). Sempre visível e impresso.
export const LIMITES = [
  ['Não prova que o provedor contou certo.', 'O recibo é do operador OTK, não do provedor. Conferir com o provedor é a conciliação, que depende do relatório de uso que o provedor exporta.'],
  ['Não prova que o contador do OTK estava certo.', 'Só mostra que os números não mudaram depois de assinados.'],
  ['O operador que tem a chave pode reassinar.', 'Quem tem a chave pode assinar um recibo diferente, ou não emitir recibo. A assinatura impede alteração por terceiros, não pelo operador. Ajudam: compromisso público, registro na rede, conciliação com o provedor e chave guardada em hardware.'],
  ['A data de assinatura é declarada por quem assina.', 'Uma chave aposentada ainda pode “voltar no tempo”. Só a revogação ou uma âncora externa de tempo resolvem.'],
  ['Não sabe se faltam recibos.', 'O verificador confere os recibos que recebeu. A conciliação com o provedor é que revela falta.'],
  ['O chaveiro é a raiz de confiança.', 'Se o chaveiro vier pelo mesmo canal que os recibos, um operador mal-intencionado entrega os dois. Por isso a impressão digital tem de vir de outro canal (contrato, site, registro).'],
  ['A opinião do operador sobre si mesmo é ignorada.', 'O campo “verification” das exportações do operador não é usado: tudo é recalculado aqui.'],
];

export const UI = {
  titulo: 'Verificador de recibos OTK',
  subtitulo: 'Confira, no seu computador e sem internet, se os recibos de uso de IA foram alterados.',
  offline: 'Esta página não envia nada para a internet: ela está proibida de fazer conexões (veja “Como sei que nada sai daqui?” no fim).',
  passo1: 'Traga os recibos',
  passo1Ajuda: 'Arraste aqui a pasta ou os arquivos de recibos (.jsonl ou .json) que o operador entregou.',
  passo2: 'Traga o chaveiro público',
  passo2Ajuda: 'Arraste o arquivo do chaveiro (lista das chaves públicas do operador). Se o contrato ou o site do operador informa uma impressão digital, cole abaixo.',
  passo3: 'Veja o resultado',
  escolherPasta: 'Escolher pasta',
  escolherArquivos: 'Escolher arquivos',
  escolherChaveiro: 'Escolher chaveiro',
  impressao: 'Impressão digital do chaveiro (opcional)',
  impressaoAjuda: 'Cole como veio, por exemplo 0x3f2a… ou 3f2a…. Sem ela, o melhor resultado possível é “Atenção: chaveiro não ancorado”.',
  conferir: 'Conferir recibos',
  semRecibos: 'Nenhum recibo carregado ainda.',
  semChaveiro: 'Nenhum chaveiro carregado ainda.',
  conferindo: 'Conferindo…',
  baixarJson: 'Baixar relatório (JSON)',
  baixarCsv: 'Baixar planilha (CSV)',
  imprimir: 'Imprimir ou salvar em PDF',
  filtro: 'Filtrar por período',
  de: 'De',
  ate: 'Até',
  limpar: 'Mostrar tudo',
  detalhe: 'Ver detalhe',
  fechar: 'Fechar',
  aconteceu: 'O que aconteceu',
  significa: 'O que isso significa',
  naoGarante: 'O que isso NÃO garante',
  limitesTitulo: 'O que este verificador NÃO garante',
  codigoRelatorio: 'Código de conferência do relatório (sha256)',
  codigoRelatorioAjuda: 'Quem rodar o comando “otk verify --json” com os mesmos arquivos deve obter exatamente este código. Se der igual, vocês viram o mesmo relatório.',
  filtroNota: 'O filtro muda só o que aparece na tela. O relatório e a planilha baixados trazem todos os recibos.',
};
