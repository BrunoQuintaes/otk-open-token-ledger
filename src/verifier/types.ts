/**
 * Verificador offline de recibos OTK — tipos públicos (VERIFICADOR_MVP, C160, 23/11/2026).
 *
 * Sem dependência de Node: este módulo e todo src/verifier/ rodam no navegador (bundle esbuild)
 * e no Node (comando `otk verify`). Leitura de arquivos fica só no comando; o núcleo recebe bytes.
 *
 * Determinismo: o relatório não tem relógio, caminho absoluto nem ordem de chegada. Mesma entrada
 * (nomes + bytes) e mesmas opções → mesmos bytes de `serializeReport` → mesmo sha256.
 *
 * (English) Public types of the offline verifier. No Node dependency; the report has no clock or absolute
 * path, so the same input and options give the same report bytes and SHA-256.
 *
 * @module src/verifier/types
 */

/** Um arquivo de entrada. `name` é o caminho relativo com "/" (o comando usa o caminho relativo à
 * pasta-mãe do argumento, como o `webkitRelativePath` do navegador; arquivo solto = só o nome). */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Verdict colour of an item: green (ok), yellow (attention) or red (failed).
 */
export type Verdict = 'verde' | 'amarelo' | 'vermelho';

/** Códigos estáveis. Os de VerifyFailure (src/types/d1d8/receipt.ts) mantêm o mesmo nome. */
export type VerdictCode =
  // verde
  | 'ok'
  // da criptografia existente (VerifyFailure)
  | 'bad_signature' | 'unauthorized_signer' | 'revoked_key' | 'digest_mismatch' | 'wrong_domain'
  | 'binding_mismatch' | 'unsupported_version' | 'malformed'
  // do verificador
  | 'retired_key_before_date'
  | 'keyring_not_anchored'
  | 'keyring_fingerprint_mismatch'
  | 'keyring_missing'
  | 'keyring_invalid'
  | 'keyring_unknown_format'
  | 'declared_digest_mismatch'
  | 'conflict'
  | 'duplicate'
  | 'codec_error'
  | 'invalid_json'
  | 'truncated_line'
  | 'unrecognized_record'
  | 'legacy_format'
  | 'legacy_unsupported'
  | 'conference_without_receipt'
  | 'development_profile'
  | 'usage_incomplete'
  | 'source_not_observed'
  | 'no_receipts'
  | 'not_in_totals';

/**
 * What a report item refers to.
 */
export type ItemKind = 'receipt' | 'conference' | 'legacy_receipt' | 'record' | 'file' | 'keyring' | 'bundle';

/** Formato detectado de cada arquivo de entrada. */
export type InputFormat =
  | 'jsonl_store'            // linhas {kind:'receipt'|'conference', digest, envelope, receipt|report}
  | 'conference_export_v1'   // GET /v1/operations/{id}/conference (otk.conference_export.v1)
  | 'loose_json'             // {receipt, envelope} / {report, envelope} / legado, ou array deles
  | 'keyring_ignored'        // um chaveiro público que veio junto com os recibos (não é usado como raiz)
  | 'export_manifest'        // MANIFEST do `otk receipts export` (só contagem e sha256; não é recibo)
  | 'not_json'               // arquivo .json/.jsonl que não é JSON nem JSONL
  | 'ignored';               // extensão que não é .json nem .jsonl

/**
 * A non-fatal warning attached to an item.
 */
export interface Warning {
  code: VerdictCode;
  verdict: Verdict;
  textPt: string;
}

/**
 * One verified item (receipt, conference, legacy receipt, record, file, key ring or bundle) with its verdict.
 */
export interface ReportItem {
  /** "tenantId/operationId" quando conhecido; senão "<arquivo>#<linha>". */
  id: string;
  kind: ItemKind;
  /** Origem: arquivo e linha (1-based; 0 = arquivo inteiro). */
  source: { file: string; line: number };
  verdict: Verdict;
  code: VerdictCode;
  /** O que aconteceu. */
  reasonPt: string;
  /** O que isso significa. */
  meaningPt: string;
  /** O que isso NÃO garante. */
  notGuaranteedPt: string;
  /** Detalhe técnico (mensagem da verificação), ou null. */
  detail: string | null;
  signer: string | null;
  keyId: string | null;
  signedAt: string | null;
  digestRecomputed: string | null;
  digestDeclared: string | null;
  warnings: Warning[];
  /** Campos do recibo usados no resumo (só para kind 'receipt' decodificado), senão null. */
  facts: ReceiptFacts | null;
  /** false quando --since/--until deixa o item fora do período (não entra no resumo). */
  inPeriod: boolean;
  /** true quando entra nas somas (recibo verde/amarelo, no período, não duplicado, sem conflito). */
  counted: boolean;
}

/**
 * Facts read from a receipt (tenant, operation, provider, models, token counts, CU) for display and totals.
 */
export interface ReceiptFacts {
  tenantId: string;
  operationId: string;
  admittedAt: string | null;
  provider: string;
  modelRequested: string | null;
  modelReturned: string | null;
  source: string;
  completeness: string | null;
  /** Contagens por categoria como texto decimal; null = desconhecido (nunca vira 0). */
  tokens: Array<{ name: string; count: string | null }>;
  /** CU exato como fração {units, scale} em texto; null quando não computado. */
  cu: { units: string; scale: string } | null;
  cuStatus: string | null;
}

/**
 * One key of the public key ring.
 */
export interface PublicKeyEntry {
  keyId: string;
  address: string;
  status: 'active' | 'retired' | 'revoked';
  retiredAt?: string;
}

/** Formato do arquivo de chaveiro público. Só endereços e estado; nunca chave privada. */
export interface PublicKeyRingFile {
  schema: 'otk.keyring.public.v1';
  /** Nome do operador (rótulo livre, opcional). */
  operator?: string;
  keys: PublicKeyEntry[];
}

/**
 * How the key ring was loaded and whether its fingerprint is anchored.
 */
export interface KeyringSummary {
  name: string | null;
  /** sha256 dos bytes exatos do arquivo (hex minúsculo, sem 0x) = impressão digital. */
  fingerprint: string | null;
  /** Impressão digital digitada pelo usuário, normalizada, ou null. */
  fingerprintExpected: string | null;
  /** 'anchored' = digitada e confere; 'not_anchored' = não digitada; 'mismatch' = não confere; 'missing'/'invalid';
   * 'unknown_format' = o arquivo não é chaveiro público do OTK nem anel do bot (não é sinal de adulteração). */
  anchor: 'anchored' | 'not_anchored' | 'mismatch' | 'missing' | 'invalid' | 'unknown_format';
  keys: PublicKeyEntry[];
  error: string | null;
  /** Só presente quando o arquivo carregado é o anel público do bot, lido por conversão sem perda. */
  convertedFrom?: 'otk.bridge.keyring_file.v1';
}

/**
 * Summary of the input files.
 */
export interface InputSummary {
  name: string;
  sha256: string;
  size: number;
  format: InputFormat;
  records: number;
}

/**
 * Count of items per verdict colour.
 */
export interface Tally { verde: number; amarelo: number; vermelho: number }

/**
 * Verdict counts and token/CU sums of one group (month, day or provider/model) of receipts.
 */
export interface GroupSummary extends Tally {
  key: string;
  /** Recibos que entraram nas somas. */
  counted: number;
  /** Somas por categoria (texto decimal) dos valores conhecidos; unknown = recibos com a categoria em null.
   * sum é null quando nenhum recibo tem valor conhecido (desconhecido nunca vira 0). */
  tokens: Array<{ name: string; sum: string | null; unknown: number }>;
  /** Soma exata de CU em texto decimal (escala comum), e quantos recibos sem CU computado. */
  /** sum é null quando nenhum recibo somado tem CU computado. */
  cu: { sum: string | null; unknown: number };
}

/**
 * Totals of the whole report.
 */
export interface ReportSummary {
  total: Tally;
  receipts: Tally;
  byMonth: GroupSummary[];
  byDay: GroupSummary[];
  byProviderModel: GroupSummary[];
  /** Somas só dos recibos verdes e amarelos; os vermelhos ficam listados à parte. */
  counted: GroupSummary;
  redItems: string[];
}

/**
 * Verification report `otk.verification_report.v1`.
 */
export interface VerificationReport {
  schema: 'otk.verification_report.v1';
  verifierVersion: string;
  options: { fingerprint: string | null; since: string | null; until: string | null };
  keyring: KeyringSummary;
  inputs: InputSummary[];
  /** Veredito geral = o pior dos itens. */
  overall: Verdict;
  /** 0 tudo verde, 10 há amarelo, 20 há vermelho (2 = erro de uso, só no comando). */
  exitCode: 0 | 10 | 20;
  items: ReportItem[];
  summary: ReportSummary;
  notGuaranteedPt: string[];
}

/**
 * Options of {@link verifyBundle}.
 */
export interface VerifyOptions {
  /** Impressão digital do chaveiro digitada pelo usuário (sha256 hex; aceita 0x, espaços, ':' e maiúsculas). */
  fingerprint?: string | null;
  /** Período por timing.admittedAt (YYYY-MM-DD, inclusivo). */
  since?: string | null;
  until?: string | null;
}
