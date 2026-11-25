/**
 * Textos para leigos em português: para cada código, o que aconteceu, o que significa e o que NÃO
 * garante. Nenhum código cru aparece sozinho na tela (critério de aceite do desenho §3(e)).
 *
 * (English) Portuguese texts shown to non-specialists for each verdict code. The strings are user-facing
 * content and are part of the report bytes; changing them changes report hashes.
 *
 * @module src/verifier/textos
 */
import type { Verdict, VerdictCode } from './types.js';

/**
 * Texts of one verdict code: verdict colour, what happened, what it means, what it does not guarantee, short label.
 */
export interface CodeText { verdict: Verdict; reason: string; meaning: string; notGuaranteed: string; short: string }

const NAO_GARANTE_BASE = 'Não garante que o provedor cobrou esse valor, que o contador do OTK estava certo, nem que o operador não poderia ter assinado outro recibo no lugar deste.';

/**
 * Texts per verdict code.
 */
export const TEXTOS: Record<VerdictCode, CodeText> = {
  ok: {
    verdict: 'verde',
    short: 'Íntegro e assinado por chave ativa',
    reason: 'Recibo íntegro e assinado por uma chave ativa do operador, num chaveiro que você conferiu pela impressão digital.',
    meaning: 'Ninguém alterou nenhum número deste recibo (tokens, CU, cliente, operação, configuração) desde que o OTK o assinou.',
    notGuaranteed: NAO_GARANTE_BASE,
  },
  bad_signature: {
    verdict: 'vermelho',
    short: 'A assinatura não confere',
    reason: 'A assinatura não confere.',
    meaning: 'O recibo ou o envelope da assinatura foram mexidos depois de assinados (por exemplo, a data da assinatura), ou a assinatura é de outra chave que se fez passar pela chave do operador.',
    notGuaranteed: 'Não diz qual campo foi mexido nem quem mexeu. Não use os números deste recibo.',
  },
  unauthorized_signer: {
    verdict: 'amarelo',
    short: 'Chave fora do chaveiro',
    reason: 'A chave que assinou não está no chaveiro que você carregou.',
    meaning: 'Pode ser um chaveiro desatualizado (chave nova do operador) ou uma chave de outra pessoa. Confira com o operador e carregue o chaveiro atual.',
    notGuaranteed: 'Não garante que o recibo seja do operador. Também não prova que foi alterado.',
  },
  revoked_key: {
    verdict: 'vermelho',
    short: 'Chave revogada',
    reason: 'Assinado por uma chave revogada, ou por uma chave aposentada com data posterior à aposentadoria.',
    meaning: 'O operador declarou que essa chave não vale mais (por exemplo, porque vazou). Qualquer pessoa com a chave pode ter produzido este recibo.',
    notGuaranteed: 'Não diz se o recibo é verdadeiro ou falso: diz que a assinatura não serve como prova.',
  },
  digest_mismatch: {
    verdict: 'vermelho',
    short: 'Recibo alterado depois de assinado',
    reason: 'Este recibo foi alterado depois de assinado.',
    meaning: 'Algum campo (tokens, CU, cliente, operação, vínculo do compromisso público, configuração, origem) não é o que foi assinado.',
    notGuaranteed: 'Não diz qual campo mudou nem quem mudou. Não use os números deste recibo.',
  },
  wrong_domain: {
    verdict: 'vermelho',
    short: 'Assinatura de outro tipo de documento',
    reason: 'A assinatura é de outro tipo de documento do OTK, não de um recibo (ou não deste tipo de documento).',
    meaning: 'Alguém tentou aproveitar uma assinatura verdadeira de outro documento para fazer este parecer assinado.',
    notGuaranteed: 'Não use os números deste item.',
  },
  binding_mismatch: {
    verdict: 'vermelho',
    short: 'Vínculo trocado',
    reason: 'Este relatório de conferência está ligado a outro recibo, cliente ou operação.',
    meaning: 'Um relatório verdadeiro foi colocado junto de um recibo que não é o dele.',
    notGuaranteed: 'Não diz nada sobre o recibo em si; veja o veredito do recibo na sua própria linha.',
  },
  unsupported_version: {
    verdict: 'amarelo',
    short: 'Versão não suportada',
    reason: 'O documento usa uma versão de formato que este verificador não conhece.',
    meaning: 'Pode ser um formato mais novo ou mais antigo. Use a versão do verificador indicada pelo operador.',
    notGuaranteed: 'Não foi possível conferir a assinatura: nada se conclui sobre a integridade.',
  },
  malformed: {
    verdict: 'vermelho',
    short: 'Documento malformado',
    reason: 'O documento não segue as regras do formato (campo obrigatório ausente, data fora do padrão, campo proibido preenchido).',
    meaning: 'Um recibo produzido pelo OTK nunca sai assim: ele foi montado ou mexido fora do OTK.',
    notGuaranteed: 'Não use os números deste item.',
  },
  retired_key_before_date: {
    verdict: 'amarelo',
    short: 'Chave aposentada (data anterior)',
    reason: 'Assinado por uma chave já aposentada, com data anterior à aposentadoria.',
    meaning: 'A assinatura confere. Mas a data é declarada por quem assina: quem ainda tiver essa chave pode escrever uma data antiga.',
    notGuaranteed: 'Não garante a data real da assinatura.',
  },
  keyring_not_anchored: {
    verdict: 'amarelo',
    short: 'Chaveiro não ancorado',
    reason: 'A assinatura confere com o chaveiro que você carregou, mas você não digitou a impressão digital do chaveiro.',
    meaning: 'Sem a impressão digital vinda de outro canal (contrato, site do operador), quem entregou os recibos poderia ter entregue também um chaveiro falso.',
    notGuaranteed: 'Não garante que o chaveiro seja o do operador. Digite a impressão digital publicada pelo operador para poder chegar a verde.',
  },
  keyring_fingerprint_mismatch: {
    verdict: 'vermelho',
    short: 'Impressão digital não confere',
    reason: 'A impressão digital que você digitou não é a do chaveiro carregado.',
    meaning: 'O chaveiro não é o que o operador publicou (ou a impressão digital foi digitada errada). Nenhum recibo pode chegar a verde com este chaveiro.',
    notGuaranteed: 'Não diz se os recibos foram alterados; diz que a raiz de confiança não é a esperada.',
  },
  keyring_missing: {
    verdict: 'amarelo',
    short: 'Sem chaveiro',
    reason: 'Nenhum chaveiro público foi carregado.',
    meaning: 'Sem chaveiro não dá para saber quem assinou; todos os recibos ficam no máximo amarelos.',
    notGuaranteed: 'Não garante nada sobre quem assinou.',
  },
  keyring_invalid: {
    verdict: 'vermelho',
    short: 'Chaveiro inválido',
    reason: 'O arquivo tem o formato de um chaveiro do OTK, mas o conteúdo não segue as regras do chaveiro (campo a mais, endereço ou estado inválido, chave repetida).',
    meaning: 'Um chaveiro produzido pelo OTK nunca sai assim: ele foi mexido ou montado fora do OTK. Os recibos foram conferidos como se não houvesse chaveiro.',
    notGuaranteed: 'Não garante nada sobre quem assinou.',
  },
  keyring_unknown_format: {
    verdict: 'amarelo',
    short: 'Formato de chaveiro não reconhecido',
    reason: 'Formato de chaveiro não reconhecido: o arquivo escolhido como chaveiro não é o chaveiro público do OTK nem o anel público do bot.',
    meaning: 'Provavelmente foi escolhido o arquivo errado. Isso não indica que alguém mexeu no arquivo. Os recibos foram conferidos como se não houvesse chaveiro; escolha o chaveiro que o operador entregou.',
    notGuaranteed: 'Não garante nada sobre quem assinou, nem diz se o arquivo é verdadeiro ou falso.',
  },
  declared_digest_mismatch: {
    verdict: 'vermelho',
    short: 'Resumo declarado diferente',
    reason: 'O resumo (digest) escrito ao lado do recibo não é o resumo recalculado do próprio recibo.',
    meaning: 'O arquivo foi mexido: o recibo, ou o resumo guardado com ele.',
    notGuaranteed: 'Não use os números deste item.',
  },
  conflict: {
    verdict: 'vermelho',
    short: 'Dois recibos para a mesma operação',
    reason: 'A mesma operação (cliente + operação) aparece com dois recibos diferentes.',
    meaning: 'Só pode existir um recibo por operação. Um dos dois é falso ou foi trocado.',
    notGuaranteed: 'Não diz qual dos dois é o verdadeiro.',
  },
  duplicate: {
    verdict: 'verde',
    short: 'Cópia de recibo já listado',
    reason: 'Este recibo é cópia idêntica de outro já listado.',
    meaning: 'Não é problema; ele não é somado duas vezes.',
    notGuaranteed: NAO_GARANTE_BASE,
  },
  codec_error: {
    verdict: 'vermelho',
    short: 'Número escrito fora do padrão',
    reason: 'Um número do recibo está escrito fora do padrão (por exemplo "1e3", vazio ou com casas decimais).',
    meaning: 'O OTK sempre grava inteiros como texto decimal. Este recibo foi escrito ou mexido fora do OTK.',
    notGuaranteed: 'Não use os números deste item.',
  },
  invalid_json: {
    verdict: 'vermelho',
    short: 'Linha ilegível',
    reason: 'Uma linha do arquivo não é JSON válido.',
    meaning: 'O arquivo foi danificado ou mexido; pode haver recibo escondido ou perdido nessa linha.',
    notGuaranteed: 'Não diz o que havia nessa linha.',
  },
  truncated_line: {
    verdict: 'amarelo',
    short: 'Última linha cortada',
    reason: 'A última linha do arquivo está cortada (sem fim de linha e ilegível).',
    meaning: 'Costuma acontecer quando o servidor para no meio de uma gravação. Pode haver um recibo perdido nessa linha.',
    notGuaranteed: 'Não diz o que havia nessa linha.',
  },
  unrecognized_record: {
    verdict: 'amarelo',
    short: 'Item não reconhecido',
    reason: 'Este item não é um recibo, relatório de conferência nem exportação do OTK.',
    meaning: 'O verificador não sabe conferir este item e o deixou de fora.',
    notGuaranteed: 'Não diz nada sobre este item.',
  },
  legacy_format: {
    verdict: 'amarelo',
    short: 'Formato antigo',
    reason: 'Recibo no formato antigo (OTK_RECEIPT_V1); a assinatura confere com o algoritmo original.',
    meaning: 'O formato antigo não traz data de assinatura nem tantos campos quanto o v3.',
    notGuaranteed: 'Não garante quando foi assinado. ' + NAO_GARANTE_BASE,
  },
  legacy_unsupported: {
    verdict: 'amarelo',
    short: 'Formato antigo não suportado',
    reason: 'Recibo num formato antigo que esta versão do verificador ainda não confere.',
    meaning: 'Nada se conclui sobre este recibo.',
    notGuaranteed: 'Não diz se foi alterado.',
  },
  conference_without_receipt: {
    verdict: 'amarelo',
    short: 'Conferência sem o recibo',
    reason: 'Há um relatório de conferência, mas o recibo dele não veio junto.',
    meaning: 'Sem o recibo, não dá para conferir o vínculo entre os dois.',
    notGuaranteed: 'Não diz se o relatório é verdadeiro.',
  },
  development_profile: {
    verdict: 'amarelo',
    short: 'Perfil de desenvolvimento',
    reason: 'O recibo foi produzido com o perfil de desenvolvimento (pesos de teste).',
    meaning: 'Os CU deste recibo não valem para cobrança.',
    notGuaranteed: 'Não garante que os CU sejam os de produção.',
  },
  usage_incomplete: {
    verdict: 'amarelo',
    short: 'Uso incompleto',
    reason: 'O uso registrado está incompleto ou ausente (resposta cortada, cancelamento).',
    meaning: 'Os números podem ser menores que o uso real.',
    notGuaranteed: 'Não garante o total de tokens.',
  },
  source_not_observed: {
    verdict: 'amarelo',
    short: 'Uso declarado, não observado',
    reason: 'O uso foi declarado pelo cliente ou importado, não observado pelo OTK.',
    meaning: 'A assinatura garante que o número não mudou, mas o OTK não o mediu.',
    notGuaranteed: 'Não garante que o número declarado seja verdadeiro.',
  },
  not_in_totals: {
    verdict: 'verde',
    short: 'Não entra nas somas',
    reason: 'Não entra nas somas: a assinatura deste recibo não foi conferida.',
    meaning: 'Só recibos com assinatura conferida entram nos totais de tokens e CU e na conciliação. Este aparece na lista, mas seus números ficam de fora.',
    notGuaranteed: 'Não diz se os números deste recibo são verdadeiros ou falsos.',
  },
  no_receipts: {
    verdict: 'amarelo',
    short: 'Nenhum recibo encontrado',
    reason: 'Nenhum recibo foi encontrado nos arquivos carregados.',
    meaning: 'Confira se carregou a pasta certa (arquivos .json ou .jsonl).',
    notGuaranteed: 'Não diz nada sobre recibos que não vieram.',
  },
};

/** Limites honestos (desenho §3(f)); vão no relatório, na página e na saída do comando. */
export const NAO_GARANTE: string[] = [
  'Não prova que o provedor contou certo: o recibo é do operador OTK, não do provedor. A conferência com o provedor é a conciliação.',
  'Não prova que o contador do OTK estava certo; só que os números não mudaram depois de assinados.',
  'O operador que tem a chave pode reassinar um recibo diferente, ou deixar de emitir um recibo. A assinatura impede alteração por terceiros, não pelo operador.',
  'A data da assinatura é declarada por quem assina; uma chave aposentada ainda pode escrever datas antigas.',
  'O verificador confere os recibos que recebeu; não sabe se faltam recibos.',
  'O chaveiro é a raiz de confiança. A impressão digital tem de vir de outro canal (contrato, site do operador), não junto com os recibos.',
  'O campo "verification" da exportação do operador é a opinião do operador sobre si mesmo e é ignorado; tudo é recalculado aqui.',
];

/**
 * Labels of each verdict colour for the command line and for Portuguese text.
 */
export const VERDICT_LABEL: Record<Verdict, { cli: string; pt: string }> = {
  verde: { cli: '[OK]', pt: 'Verde' },
  amarelo: { cli: '[ATENÇÃO]', pt: 'Amarelo' },
  vermelho: { cli: '[FALHOU]', pt: 'Vermelho' },
};
