/**
 * Núcleo do verificador: bytes de entrada + chaveiro público → VerificationReport determinístico.
 *
 * Reutiliza sem cópia: createReceiptCrypto (instância só de verificação), createKeyRing,
 * digestReceiptV3/digestConferenceV1, decodeReceiptV3/decodeConference e big (codec, para os bigint
 * do disco) e verifyLegacy. O campo `verification` das exportações do operador é ignorado.
 * Sem relógio, sem rede, sem Node.
 */
import { ethers } from 'ethers';
import { createReceiptCrypto, digestConferenceV1, digestReceiptV3, envelopeDigest } from '../receipt/v3/receiptCrypto.js';
import { createKeyRing, type KeyRing } from '../receipt/v3/keyRing.js';
import { big, CodecError, decodeConference, decodeReceiptV3 } from '../operations/codec.js';
import type { ConferenceReport, PrivateReceiptV3, SignedEnvelope, VerifyResult } from '../types/d1d8/index.js';
import type { CanonicalReceiptV1 } from '../receipt/canonicalReceiptV1.js';
import { isValidFingerprint, normalizeFingerprint, parsePublicKeyRing, sha256Hex, KEYRING_SCHEMA, BRIDGE_KEYRING_SCHEMA } from './keyring.js';
import { NAO_GARANTE, TEXTOS } from './textos.js';
import type {
  GroupSummary, InputFile, InputFormat, InputSummary, ItemKind, KeyringSummary, ReceiptFacts, ReportItem, ReportSummary,
  Tally, Verdict, VerdictCode, VerificationReport, VerifyOptions, Warning,
} from './types.js';

export const VERIFIER_VERSION = '0.1.0';

export class VerifierUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'VerifierUsageError'; }
}

const SEVERITY: Record<Verdict, number> = { verde: 0, amarelo: 1, vermelho: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (SEVERITY[b] > SEVERITY[a] ? b : a);
const OBSERVED_SOURCES = new Set(['otk_proxy_observed', 'otk_api_server_computed']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Finding { code: VerdictCode; detail: string | null }

interface Work {
  kind: ItemKind;
  file: string;
  line: number;
  findings: Finding[];
  id: string | null;
  signer: string | null;
  keyId: string | null;
  signedAt: string | null;
  digestRecomputed: string | null;
  digestDeclared: string | null;
  facts: ReceiptFacts | null;
  receipt: PrivateReceiptV3 | null;
  duplicate: boolean;
  /** true só quando a assinatura foi conferida e confere (verifyReceipt ok). Só então o recibo pode entrar nas somas. */
  sigOk: boolean;
  // conferência pendente (verificada depois que todos os recibos foram lidos)
  pendingConference?: { report: ConferenceReport; envelope: SignedEnvelope };
}

type RawRecord =
  | { t: 'receipt'; raw: unknown; envelope: unknown; digest: unknown }
  | { t: 'conference'; raw: unknown; envelope: unknown; digest: unknown }
  | { t: 'legacy'; format: unknown; payload: unknown; signature: unknown }
  | { t: 'unrecognized'; detail: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Classifica um objeto JSON (linha do store, exportação ou arquivo solto). */
function classifyRecord(v: unknown): RawRecord[] {
  if (!isObj(v)) return [{ t: 'unrecognized', detail: 'não é um objeto JSON' }];
  if (v['schema'] === 'otk.conference_export.v1') {
    const out: RawRecord[] = [];
    const r = v['receipt'];
    if (isObj(r)) out.push({ t: 'receipt', raw: r['payload'], envelope: r['envelope'], digest: r['digest'] });
    else out.push({ t: 'unrecognized', detail: 'exportação sem recibo' });
    const c = v['conference'];
    if (isObj(c) && c['payload'] !== undefined) out.push({ t: 'conference', raw: c['payload'], envelope: c['envelope'], digest: c['digest'] });
    // v['verification'] é a opinião do operador: ignorado de propósito
    return out;
  }
  if (v['kind'] === 'receipt') return [{ t: 'receipt', raw: v['receipt'], envelope: v['envelope'], digest: v['digest'] }];
  if (v['kind'] === 'conference') return [{ t: 'conference', raw: v['report'], envelope: v['envelope'], digest: v['digest'] }];
  if (v['receipt'] !== undefined && v['envelope'] !== undefined) return [{ t: 'receipt', raw: v['receipt'], envelope: v['envelope'], digest: v['digest'] }];
  if (v['report'] !== undefined && v['envelope'] !== undefined) return [{ t: 'conference', raw: v['report'], envelope: v['envelope'], digest: v['digest'] }];
  if (typeof v['format'] === 'string' && v['payload'] !== undefined && v['signature'] !== undefined) {
    return [{ t: 'legacy', format: v['format'], payload: v['payload'], signature: v['signature'] }];
  }
  return [{ t: 'unrecognized', detail: 'formato de item desconhecido' }];
}

const V1_BIGINT_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'latency_ms', 'cost_unit', 'timestamp', 'nonce', 'epoch'] as const;

function reviveV1(p: unknown): CanonicalReceiptV1 {
  if (!isObj(p)) throw new CodecError('legacy.payload: expected object');
  const out: Record<string, unknown> = { ...p };
  for (const f of V1_BIGINT_FIELDS) out[f] = big(p[f], `legacy.payload.${f}`);
  return out as unknown as CanonicalReceiptV1;
}

function sumDecimal(units: bigint, scale: bigint): string {
  // scale é potência de dez (common.ts); representação decimal exata
  const digits = scale.toString(10).length - 1;
  const neg = units < 0n;
  const mag = neg ? -units : units;
  const ip = mag / scale;
  const fp = mag % scale;
  const s = digits > 0 ? `${ip}.${fp.toString(10).padStart(digits, '0')}` : `${ip}`;
  return neg ? `-${s}` : s;
}

const isPow10 = (s: bigint): boolean => s > 0n && /^10*$/.test(s.toString(10));

function factsOf(r: PrivateReceiptV3): ReceiptFacts {
  const u = r.usage as unknown as Record<string, unknown> | null;
  const cats = Array.isArray(u?.['categories']) ? (u!['categories'] as Array<{ name?: unknown; count?: unknown }>) : [];
  const cu = r.cu as unknown as { status?: unknown; cu?: { units: bigint; scale: bigint } | null } | null;
  const t = r.timing as unknown as { admittedAt?: unknown } | null;
  return {
    tenantId: String(r.key?.tenantId ?? ''),
    operationId: String(r.key?.operationId ?? ''),
    admittedAt: typeof t?.admittedAt === 'string' ? t.admittedAt : null,
    provider: String(r.provider ?? ''),
    modelRequested: typeof u?.['modelRequested'] === 'string' ? (u['modelRequested'] as string) : null,
    modelReturned: typeof u?.['modelReturned'] === 'string' ? (u['modelReturned'] as string) : null,
    source: String(r.source ?? ''),
    completeness: typeof u?.['completeness'] === 'string' ? (u['completeness'] as string) : null,
    tokens: cats.map((c) => ({ name: String(c.name ?? '?'), count: typeof c.count === 'bigint' ? c.count.toString(10) : null })),
    cu: cu?.cu && typeof cu.cu.units === 'bigint' && typeof cu.cu.scale === 'bigint' ? { units: cu.cu.units.toString(10), scale: cu.cu.scale.toString(10) } : null,
    cuStatus: typeof cu?.status === 'string' ? cu.status : null,
  };
}

function failureFinding(v: VerifyResult): Finding | null {
  if (v.ok) return null;
  return { code: v.reason, detail: v.detail ?? null };
}

function newWork(kind: ItemKind, file: string, line: number): Work {
  return {
    kind, file, line, findings: [], id: null, signer: null, keyId: null, signedAt: null,
    digestRecomputed: null, digestDeclared: null, facts: null, receipt: null, duplicate: false, sigOk: false,
  };
}

function strOrNull(v: unknown): string | null { return typeof v === 'string' ? v : null; }

function decodeText(bytes: Uint8Array): string | null {
  try {
    let s = ethers.toUtf8String(bytes);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  } catch { return null; }
}

function emptyGroup(key: string): GroupSummary {
  return { key, verde: 0, amarelo: 0, vermelho: 0, counted: 0, tokens: [], cu: { sum: '0' as string | null, unknown: 0 } };
}

function buildGroups(items: ReportItem[], keyOf: (f: ReceiptFacts) => string): GroupSummary[] {
  const m = new Map<string, ReportItem[]>();
  for (const it of items) {
    if (it.kind !== 'receipt' || !it.facts || !it.inPeriod) continue;
    const k = keyOf(it.facts);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return [...m.keys()].sort().map((k) => aggregate(k, m.get(k)!));
}

function aggregate(key: string, items: ReportItem[]): GroupSummary {
  const g = emptyGroup(key);
  const tok = new Map<string, { sum: bigint; unknown: number }>();
  let maxScale = 1n;
  const cus: Array<{ units: bigint; scale: bigint }> = [];
  for (const it of items) {
    g[it.verdict]++;
    if (!it.counted || !it.facts) continue;
    g.counted++;
    for (const t of it.facts.tokens) {
      const cur = tok.get(t.name) ?? { sum: 0n, unknown: 0 };
      if (t.count === null) cur.unknown++; else cur.sum += BigInt(t.count);
      tok.set(t.name, cur);
    }
    const c = it.facts.cu;
    if (c && isPow10(BigInt(c.scale))) {
      const s = BigInt(c.scale);
      cus.push({ units: BigInt(c.units), scale: s });
      if (s > maxScale) maxScale = s;
    } else g.cu.unknown++;
  }
  let total = 0n;
  for (const c of cus) total += c.units * (maxScale / c.scale);
  g.cu.sum = g.counted > 0 && g.cu.unknown === g.counted ? null : sumDecimal(total, maxScale);
  g.tokens = [...tok.keys()].sort().map((name) => {
    const t = tok.get(name)!;
    // nenhum valor conhecido: a soma é desconhecida (null), nunca 0
    return { name, sum: t.unknown === g.counted ? null : t.sum.toString(10), unknown: t.unknown };
  });
  return g;
}

function tally(items: ReportItem[]): Tally {
  const t: Tally = { verde: 0, amarelo: 0, vermelho: 0 };
  for (const it of items) t[it.verdict]++;
  return t;
}

/**
 * Verifica um conjunto de arquivos contra um chaveiro público.
 * @param input arquivos (nome relativo com "/" + bytes); a ordem de chegada não importa.
 * @param keyRing arquivo do chaveiro público (otk.keyring.public.v1 ou o anel do bot otk.bridge.keyring_file.v1), ou null.
 * @throws VerifierUsageError para opção inválida (impressão digital ou data fora do formato).
 */
export function verifyBundle(input: readonly InputFile[], keyRing: InputFile | null, opts: VerifyOptions = {}): VerificationReport {
  return verifyBundleDetailed(input, keyRing, opts).report;
}

/**
 * Igual a verifyBundle, e devolve também o recibo decodificado de cada item de recibo (índice em
 * report.items). Uso: a conciliação aproveita só os recibos verdes e amarelos (item.counted).
 */
export function verifyBundleDetailed(input: readonly InputFile[], keyRing: InputFile | null, opts: VerifyOptions = {}): { report: VerificationReport; receipts: Map<number, PrivateReceiptV3> } {
  const fpExpected = normalizeFingerprint(opts.fingerprint ?? null);
  if (fpExpected !== null && !isValidFingerprint(fpExpected)) throw new VerifierUsageError('impressão digital deve ter 64 caracteres hexadecimais (sha256)');
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  if (since !== null && !DAY.test(since)) throw new VerifierUsageError('--since deve ser AAAA-MM-DD');
  if (until !== null && !DAY.test(until)) throw new VerifierUsageError('--until deve ser AAAA-MM-DD');

  // ---- chaveiro
  let ring: KeyRing = createKeyRing([]);
  const ks: KeyringSummary = { name: keyRing?.name ?? null, fingerprint: null, fingerprintExpected: fpExpected, anchor: 'missing', keys: [], error: null };
  const bundleWork: Work[] = [];
  if (keyRing) {
    const p = parsePublicKeyRing(keyRing.bytes);
    ks.fingerprint = p.fingerprint;
    if (p.ok) {
      ring = p.ring;
      ks.keys = p.file.keys;
      ks.anchor = fpExpected === null ? 'not_anchored' : fpExpected === p.fingerprint ? 'anchored' : 'mismatch';
      if (p.format === BRIDGE_KEYRING_SCHEMA) ks.convertedFrom = BRIDGE_KEYRING_SCHEMA;
    } else {
      ks.anchor = p.unknownFormat ? 'unknown_format' : 'invalid';
      ks.error = p.error;
      const w = newWork('keyring', keyRing.name, 0);
      w.findings.push({ code: p.unknownFormat ? 'keyring_unknown_format' : 'keyring_invalid', detail: p.error });
      bundleWork.push(w);
    }
    if (ks.anchor === 'mismatch') {
      const w = newWork('keyring', keyRing.name, 0);
      w.findings.push({ code: 'keyring_fingerprint_mismatch', detail: `esperada ${fpExpected}, calculada ${p.fingerprint}` });
      bundleWork.push(w);
    }
  }
  const rc = createReceiptCrypto({ keyRing: ring });
  /**
   * unauthorized_signer da verificação existente decide pelo keyId declarado. Aqui a decisão é pelo
   * ENDEREÇO recuperado da própria assinatura (B2 do X1): chave revogada ou aposentada-depois não
   * escapa trocando o keyId, e uma assinatura alheia usando o keyId de uma chave do chaveiro é forjada.
   */
  const refineUnauthorized = (env: SignedEnvelope, ff: Finding): Finding => {
    let recovered: string | null = null;
    try { recovered = ethers.verifyMessage(ethers.getBytes(envelopeDigest(env)), env.signature); } catch { recovered = null; }
    if (!recovered) return { code: 'bad_signature', detail: 'assinatura ilegível' };
    const byAddr = ring.byAddress(recovered);
    const signedAt = isObj(env) && typeof env.signedAt === 'string' ? env.signedAt : '';
    if (byAddr) {
      if (byAddr.status === 'revoked') return { code: 'revoked_key', detail: `assinado pela chave revogada ${byAddr.keyId} declarando keyId ${String(env.keyId)}` };
      if (byAddr.status === 'retired' && !(signedAt !== '' && signedAt <= byAddr.retiredAt!)) {
        return { code: 'revoked_key', detail: `assinado pela chave ${byAddr.keyId} (aposentada em ${byAddr.retiredAt}) com data ${signedAt || '?'} declarando keyId ${String(env.keyId)}` };
      }
      return { code: 'bad_signature', detail: `assinado pela chave ${byAddr.keyId}, mas o envelope declara keyId ${String(env.keyId)} e signer ${String(env.signer)}` };
    }
    if (ring.get(String(env.keyId))) return { code: 'bad_signature', detail: `keyId ${String(env.keyId)} é do chaveiro, mas quem assinou foi ${recovered}` };
    return { code: ff.code, detail: `${ff.detail ?? ''}; endereço que assinou ${recovered}`.replace(/^; /, '') };
  };
  const anchorFinding = (): Finding | null => {
    switch (ks.anchor) {
      case 'anchored': return null;
      case 'not_anchored': return { code: 'keyring_not_anchored', detail: null };
      case 'mismatch': return { code: 'keyring_not_anchored', detail: 'a impressão digital digitada não confere com o chaveiro' };
      default: return { code: 'keyring_missing', detail: null };
    }
  };

  // ---- leitura das entradas (ordem por nome; empate pelos bytes)
  const files = [...input].map((f) => ({ name: f.name.replace(/\\/g, '/'), bytes: f.bytes, sha: sha256Hex(f.bytes) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  const inputs: InputSummary[] = [];
  const works: Work[] = [];

  for (const f of files) {
    const summary: InputSummary = { name: f.name, sha256: f.sha, size: f.bytes.length, format: 'ignored', records: 0 };
    inputs.push(summary);
    if (!/\.(json|jsonl)$/i.test(f.name)) continue;
    const text = decodeText(f.bytes);
    const recs: Array<{ line: number; rec: RawRecord }> = [];
    let format: InputFormat = 'not_json';
    if (text === null) {
      const w = newWork('file', f.name, 0);
      w.findings.push({ code: 'invalid_json', detail: 'o arquivo não é texto UTF-8' });
      works.push(w);
    } else {
      let whole: unknown; let wholeOk = false;
      try { whole = JSON.parse(text); wholeOk = true; } catch { /* tenta JSONL */ }
      if (wholeOk) {
        if (isObj(whole) && (whole['schema'] === KEYRING_SCHEMA || whole['schema'] === BRIDGE_KEYRING_SCHEMA)) { format = 'keyring_ignored'; }
        else if (isObj(whole) && whole['schema'] === 'otk.receipts_export_manifest.v1') { format = 'export_manifest'; }
        else if (isObj(whole) && whole['schema'] === 'otk.conference_export.v1') { format = 'conference_export_v1'; for (const rec of classifyRecord(whole)) recs.push({ line: 0, rec }); }
        else if (Array.isArray(whole)) { format = 'loose_json'; whole.forEach((el, i) => { for (const rec of classifyRecord(el)) recs.push({ line: i + 1, rec }); }); }
        else { format = isObj(whole) && typeof whole['kind'] === 'string' ? 'jsonl_store' : 'loose_json'; for (const rec of classifyRecord(whole)) recs.push({ line: 1, rec }); }
      } else {
        const lines = text.split('\n');
        let lastNonEmpty = -1;
        for (let i = 0; i < lines.length; i++) if (lines[i]!.trim()) lastNonEmpty = i;
        const endsWithNewline = text.endsWith('\n');
        let parsedAny = false;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i]!.replace(/\r$/, '');
          if (!ln.trim()) continue;
          let v: unknown;
          try { v = JSON.parse(ln); } catch {
            const w = newWork('record', f.name, i + 1);
            const torn = i === lastNonEmpty && !endsWithNewline;
            w.findings.push({ code: torn ? 'truncated_line' : 'invalid_json', detail: `linha ${i + 1}` });
            works.push(w);
            continue;
          }
          parsedAny = true;
          for (const rec of classifyRecord(v)) recs.push({ line: i + 1, rec });
        }
        format = parsedAny ? 'jsonl_store' : 'not_json';
      }
    }
    summary.format = format;
    summary.records = recs.length;

    for (const { line, rec } of recs) {
      if (rec.t === 'unrecognized') {
        const w = newWork('record', f.name, line);
        w.findings.push({ code: 'unrecognized_record', detail: rec.detail });
        works.push(w);
        continue;
      }
      if (rec.t === 'legacy') {
        const w = newWork('legacy_receipt', f.name, line);
        if (rec.format !== 'otk_receipt_v1') {
          w.findings.push({ code: 'legacy_unsupported', detail: `formato ${String(rec.format)}` });
        } else {
          try {
            const payload = reviveV1(rec.payload);
            const v = rc.verifyLegacy('otk_receipt_v1', payload, rec.signature);
            const ff = failureFinding(v);
            if (ff) w.findings.push(ff);
            else {
              w.signer = v.ok ? v.signer : null; w.keyId = v.ok ? v.keyId : null;
              w.findings.push({ code: 'legacy_format', detail: null });
              const a = anchorFinding(); if (a) w.findings.push(a);
            }
            if (ff?.code === 'unauthorized_signer') { const a = anchorFinding(); if (a) w.findings.push(a); }
          } catch (e) {
            w.findings.push({ code: e instanceof CodecError ? 'codec_error' : 'malformed', detail: e instanceof Error ? e.message : String(e) });
          }
        }
        works.push(w);
        continue;
      }
      const isReceipt = rec.t === 'receipt';
      const w = newWork(isReceipt ? 'receipt' : 'conference', f.name, line);
      w.digestDeclared = strOrNull(rec.digest);
      const env = rec.envelope as SignedEnvelope;
      if (isObj(env)) { w.signer = strOrNull(env['signer']); w.keyId = strOrNull(env['keyId']); w.signedAt = strOrNull(env['signedAt']); }
      // id pela chave declarada, mesmo que a leitura falhe adiante
      const rawKey = isObj(rec.raw) && isObj(rec.raw['key']) ? rec.raw['key'] : null;
      if (rawKey && typeof rawKey['tenantId'] === 'string' && typeof rawKey['operationId'] === 'string') w.id = `${rawKey['tenantId']}/${rawKey['operationId']}`;
      let decodedR: PrivateReceiptV3 | null = null;
      let decodedC: ConferenceReport | null = null;
      try {
        if (isReceipt) decodedR = decodeReceiptV3(rec.raw); else decodedC = decodeConference(rec.raw);
      } catch (e) {
        w.findings.push({ code: e instanceof CodecError ? 'codec_error' : 'malformed', detail: e instanceof Error ? e.message : String(e) });
        works.push(w);
        continue;
      }
      if (decodedR) {
        w.receipt = decodedR;
        const key = (decodedR as { key?: { tenantId?: unknown; operationId?: unknown } }).key;
        if (key && typeof key.tenantId === 'string' && typeof key.operationId === 'string') w.id = `${key.tenantId}/${key.operationId}`;
        try { w.digestRecomputed = digestReceiptV3(decodedR); } catch { w.digestRecomputed = null; }
        const v = rc.verifyReceipt(decodedR, env);
        let ff = failureFinding(v);
        if (ff?.code === 'unauthorized_signer') ff = refineUnauthorized(env, ff);
        if (ff) w.findings.push(ff);
        if (v.ok) {
          w.sigOk = true;
          w.signer = v.signer; w.keyId = v.keyId;
          if (ring.get(v.keyId)?.status === 'retired') w.findings.push({ code: 'retired_key_before_date', detail: `aposentada em ${ring.get(v.keyId)!.retiredAt}` });
        }
        if (v.ok || ff?.code === 'unauthorized_signer') { const a = anchorFinding(); if (a) w.findings.push(a); }
        if (!v.ok && ff && TEXTOS[ff.code].verdict !== 'vermelho') w.findings.push({ code: 'not_in_totals', detail: null });
        if (w.digestDeclared !== null && w.digestRecomputed !== null && w.digestDeclared.toLowerCase() !== w.digestRecomputed.toLowerCase()) {
          w.findings.push({ code: 'declared_digest_mismatch', detail: `declarado ${w.digestDeclared}` });
        }
        // avisos de conteúdo (campos assinados)
        try {
          w.facts = factsOf(decodedR);
          const cfg = decodedR.config as unknown as { developmentProfile?: unknown } | null;
          if (cfg?.developmentProfile === true) w.findings.push({ code: 'development_profile', detail: null });
          if (w.facts.completeness !== 'complete') w.findings.push({ code: 'usage_incomplete', detail: `completeness ${String(w.facts.completeness)}` });
          if (!OBSERVED_SOURCES.has(w.facts.source)) w.findings.push({ code: 'source_not_observed', detail: `source ${w.facts.source}` });
        } catch { w.facts = null; }
      } else if (decodedC) {
        const key = (decodedC as { key?: { tenantId?: unknown; operationId?: unknown } }).key;
        if (key && typeof key.tenantId === 'string' && typeof key.operationId === 'string') w.id = `${key.tenantId}/${key.operationId}`;
        try { w.digestRecomputed = digestConferenceV1(decodedC); } catch { w.digestRecomputed = null; }
        w.pendingConference = { report: decodedC, envelope: env };
      }
      works.push(w);
    }
  }

  // ---- conflitos e duplicatas entre recibos (mesma chave)
  const byKey = new Map<string, Work[]>();
  for (const w of works) if (w.kind === 'receipt' && w.id && w.digestRecomputed) {
    if (!byKey.has(w.id)) byKey.set(w.id, []);
    byKey.get(w.id)!.push(w);
  }
  for (const [, ws] of byKey) {
    const digests = new Set(ws.map((w) => w.digestRecomputed!.toLowerCase()));
    if (digests.size > 1) {
      for (const w of ws) w.findings.push({ code: 'conflict', detail: `${digests.size} resumos diferentes para a mesma operação` });
    } else {
      for (const w of ws.slice(1)) { w.duplicate = true; w.findings.push({ code: 'duplicate', detail: `cópia de ${ws[0]!.file}#${ws[0]!.line}` }); }
    }
  }

  // ---- conferências: vínculo com o recibo do mesmo conjunto
  for (const w of works) {
    if (!w.pendingConference) continue;
    const { report, envelope } = w.pendingConference;
    const ws = w.id ? byKey.get(w.id) : undefined;
    const target = ws && ws.length > 0 && !ws[0]!.findings.some((f) => f.code === 'conflict') ? ws[0]!.receipt : null;
    if (!target) {
      // sem o recibo do mesmo par (cliente, operação), procura o recibo cujo resumo a conferência cita
      const named = String((report as { receiptDigest?: unknown }).receiptDigest ?? '').toLowerCase();
      const other = works.find((x) => x.kind === 'receipt' && x.digestRecomputed?.toLowerCase() === named && x.receipt);
      if (other) {
        const v = rc.verifyConference(report, envelope, other.receipt!);
        const ff = failureFinding(v);
        w.findings.push(ff ?? { code: 'binding_mismatch', detail: 'conferência citando recibo de outra operação' });
      } else {
        w.findings.push({ code: 'conference_without_receipt', detail: null });
      }
    } else {
      const v = rc.verifyConference(report, envelope, target);
      let ff = failureFinding(v);
      if (ff?.code === 'unauthorized_signer') ff = refineUnauthorized(envelope, ff);
      if (ff) w.findings.push(ff);
      if (v.ok) { w.signer = v.signer; w.keyId = v.keyId; if (ring.get(v.keyId)?.status === 'retired') w.findings.push({ code: 'retired_key_before_date', detail: null }); }
      if (v.ok || ff?.code === 'unauthorized_signer') { const a = anchorFinding(); if (a) w.findings.push(a); }
    }
    if (w.digestDeclared !== null && w.digestRecomputed !== null && w.digestDeclared.toLowerCase() !== w.digestRecomputed.toLowerCase()) {
      w.findings.push({ code: 'declared_digest_mismatch', detail: `declarado ${w.digestDeclared}` });
    }
    delete w.pendingConference;
  }

  const receiptCount = works.filter((w) => w.kind === 'receipt' || w.kind === 'legacy_receipt').length;
  if (receiptCount === 0) { const w = newWork('bundle', '', 0); w.findings.push({ code: 'no_receipts', detail: null }); bundleWork.push(w); }

  // ---- itens finais
  const allWork = [...bundleWork, ...works];
  const items: ReportItem[] = allWork.map((w) => finalize(w, since, until));
  const receipts = new Map<number, PrivateReceiptV3>();
  allWork.forEach((w, i) => { if (w.kind === 'receipt' && w.receipt) receipts.set(i, w.receipt); });
  let overall: Verdict = 'verde';
  for (const it of items) overall = worst(overall, it.verdict);

  const receiptItems = items.filter((i) => i.kind === 'receipt' || i.kind === 'legacy_receipt');
  const summary: ReportSummary = {
    total: tally(items),
    receipts: tally(receiptItems),
    byMonth: buildGroups(items, (f) => (f.admittedAt ? f.admittedAt.slice(0, 7) : 'sem data')),
    byDay: buildGroups(items, (f) => (f.admittedAt ? f.admittedAt.slice(0, 10) : 'sem data')),
    byProviderModel: buildGroups(items, (f) => `${f.provider} / ${f.modelReturned ?? f.modelRequested ?? '?'}`),
    counted: aggregate('total', items.filter((i) => i.kind === 'receipt' && i.facts && i.inPeriod)),
    redItems: items.filter((i) => i.verdict === 'vermelho').map((i) => i.id),
  };

  const report: VerificationReport = {
    schema: 'otk.verification_report.v1',
    verifierVersion: VERIFIER_VERSION,
    options: { fingerprint: fpExpected, since, until },
    keyring: ks,
    inputs,
    overall,
    exitCode: overall === 'verde' ? 0 : overall === 'amarelo' ? 10 : 20,
    items,
    summary,
    notGuaranteedPt: [...NAO_GARANTE],
  };
  return { report, receipts };
}

function finalize(w: Work, since: string | null, until: string | null): ReportItem {
  let verdict: Verdict = 'verde';
  for (const f of w.findings) verdict = worst(verdict, TEXTOS[f.code].verdict);
  const primary = w.findings.length === 0 ? { code: 'ok' as VerdictCode, detail: null } : w.findings.find((f) => TEXTOS[f.code].verdict === verdict)!;
  const t = TEXTOS[primary.code];
  const warnings: Warning[] = w.findings.filter((f) => f !== primary).map((f) => ({
    code: f.code, verdict: TEXTOS[f.code].verdict, textPt: TEXTOS[f.code].reason + (f.detail ? ` (${f.detail})` : ''),
  }));
  const day = w.facts?.admittedAt?.slice(0, 10) ?? null;
  const inPeriod = day === null ? true : (since === null || day >= since) && (until === null || day <= until);
  return {
    id: w.id ?? `${w.file}#${w.line}`,
    kind: w.kind,
    source: { file: w.file, line: w.line },
    verdict,
    code: primary.code,
    reasonPt: t.reason,
    meaningPt: t.meaning,
    notGuaranteedPt: t.notGuaranteed,
    detail: primary.detail,
    signer: w.signer,
    keyId: w.keyId,
    signedAt: w.signedAt,
    digestRecomputed: w.digestRecomputed,
    digestDeclared: w.digestDeclared,
    warnings,
    facts: w.facts,
    inPeriod,
    counted: w.kind === 'receipt' && w.sigOk && w.facts !== null && verdict !== 'vermelho' && inPeriod && !w.duplicate,
  };
}
