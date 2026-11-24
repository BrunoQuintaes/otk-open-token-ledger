/**
 * C157 §9.2 / E2E-01 — closed list of synthetic PILOT prompts for `plan --pilot-prompts <json>`.
 * The list (otk.n5.pilot_prompts.v1|v2|v3, MET-01) is NOT an S1 corpus: it has no splits, no groups and no holdout. This module (a) validates the list
 * (shape, ≤ 10 prompts, text only, max_tokens, and the hashes RECOMPUTED), (b) builds the neutral content (system + user message) and (c) materialises a
 * minimal "pilot corpus" (manifest.json + content/<sha256>) so that the existing runner, which reads content by hash from the corpus dir, runs the pilot unchanged.
 * Hashes recomputed (never trusted):
 *   per prompt  promptSha256      = sha256(JSON.stringify({system, user}))
 *   v1/v2       listaSha256       = sha256(JSON.stringify([[id, promptSha256, maxTokens], ...]))
 *   v3          listaPromptsSha256 = sha256(JSON.stringify([[id, promptSha256], ...]))  (prompts only)
 *               listas.<model>.listaComMaxTokensSha256 = sha256(JSON.stringify([[id, promptSha256, maxTokens<Model>], ...]))  (one per model)
 * v3 carries a max_tokens PER MODEL (maxTokensSonnet / maxTokensOpus), chosen by the coordination (C157 §9.2 design decision): the plan takes the value of the model being planned.
 * Pure apart from `materializePilotCorpus` (writes only inside the dir it is given). Nothing here does network and nothing reads a secret.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createContentStore, contentHash, type ResolvedContentLike } from '../cache/contentStore.js';
import { canonicalJson } from '../corpus/util.js';
import { CliError, EXIT } from './common.js';

export const PILOT_LIST_SCHEMAS = ['otk.n5.pilot_prompts.v1', 'otk.n5.pilot_prompts.v2', 'otk.n5.pilot_prompts.v3'] as const;
export const PILOT_MAX_PROMPTS = 10;
export const PILOT_MANIFEST_KIND = 'PILOT_CLOSED_LIST';
export type PilotModel = 'claude-sonnet-5-5' | 'claude-opus-5-5';
const V3_FIELD: Record<PilotModel, { field: 'maxTokensSonnet' | 'maxTokensOpus'; key: 'sonnet' | 'opus' }> = { 'claude-sonnet-5-5': { field: 'maxTokensSonnet', key: 'sonnet' }, 'claude-opus-5-5': { field: 'maxTokensOpus', key: 'opus' } };

/** `maxTokens` is the single ceiling of a v1/v2 list; `maxTokensByModel` is set for a v3 list (one ceiling per pilot model). */
export interface PilotPrompt { id: string; tipo: string; system: string; user: string; maxTokens?: number; maxTokensByModel?: Record<PilotModel, number>; promptSha256: string }
export interface PilotList {
  file: string; fileSha256: string; schema: string;
  /** v1/v2: the list hash (with max_tokens). v3: the prompts-only hash (listaPromptsSha256). */
  listaSha256: string;
  /** v3 only: hash of [id, promptSha256, max_tokens of THAT model] per model */
  perModelListSha256?: Record<PilotModel, string>;
  prompts: PilotPrompt[];
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const bad = (m: string): CliError => new CliError(EXIT.PLAN_INVALID, 'PILOT_LIST_INVALID', m);
const mismatch = (m: string): CliError => new CliError(EXIT.PLAN_INVALID, 'PILOT_LIST_HASH_MISMATCH', m);
const okTokens = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 128_000;

/** The max_tokens of a prompt for the model being planned (v3: that model's value; v1/v2: the single value). */
export function maxTokensOf(p: PilotPrompt, model: string): number {
  if (p.maxTokensByModel) { const v = p.maxTokensByModel[model as PilotModel]; if (v === undefined) throw bad(`${p.id}: no max_tokens for ${model} in this list`); return v; }
  if (p.maxTokens === undefined) throw bad(`${p.id}: no max_tokens`);
  return p.maxTokens;
}

/** Loads and validates the closed list. `expectedListSha256` (optional): a hash the caller was told to expect (GO / protocol); it must equal the list hash OR (v3) a per-model list hash. */
export function loadPilotList(file: string, expectedListSha256?: string): PilotList {
  if (!existsSync(file)) throw new CliError(EXIT.USAGE, 'PILOT_LIST_MISSING', file);
  const buf = readFileSync(file);
  let j: Record<string, unknown>;
  try { j = JSON.parse(buf.toString('utf8')) as Record<string, unknown>; } catch { throw bad('not JSON'); }
  const schema = j['schema'];
  if (typeof schema !== 'string' || !(PILOT_LIST_SCHEMAS as readonly string[]).includes(schema)) throw bad(`schema must be one of ${PILOT_LIST_SCHEMAS.join(', ')}`);
  const v3 = schema === 'otk.n5.pilot_prompts.v3';
  const declaredMain = v3 ? j['listaPromptsSha256'] : j['listaSha256'];
  if (typeof declaredMain !== 'string' || !HEX64.test(declaredMain)) throw bad(`${v3 ? 'listaPromptsSha256' : 'listaSha256'} must be hex64`);
  const raws = j['prompts'];
  if (!Array.isArray(raws) || raws.length < 1 || raws.length > PILOT_MAX_PROMPTS) throw bad(`prompts must be 1..${PILOT_MAX_PROMPTS} (C157 §9.2: closed list of at most 10 per model)`);
  const prompts: PilotPrompt[] = []; const seen = new Set<string>();
  for (const raw of raws as Array<Record<string, unknown>>) {
    const id = raw['id']; const system = raw['system']; const user = raw['user']; const declared = raw['promptSha256']; const tipo = raw['tipo'];
    if (typeof id !== 'string' || !/^P\d{2}$/.test(id) || seen.has(id)) throw bad(`prompt id ${String(id)}: must be unique P<nn>`);
    seen.add(id);
    if (typeof system !== 'string' || typeof user !== 'string' || user.length === 0 || typeof tipo !== 'string') throw bad(`${id}: system/user/tipo must be strings (text only)`);
    const recomputed = sha(JSON.stringify({ system, user }));
    if (declared !== recomputed) throw mismatch(`${id}: promptSha256 declared ${String(declared)} != recomputed ${recomputed}`);
    if (v3) {
      const byModel = {} as Record<PilotModel, number>;
      for (const m of Object.keys(V3_FIELD) as PilotModel[]) { const n = raw[V3_FIELD[m].field]; if (!okTokens(n)) throw bad(`${id}: ${V3_FIELD[m].field} must be an integer in 1..128000`); byModel[m] = n; }
      prompts.push({ id, tipo, system, user, maxTokensByModel: byModel, promptSha256: recomputed });
    } else {
      const maxTokens = raw['maxTokens']; if (!okTokens(maxTokens)) throw bad(`${id}: maxTokens must be an integer in 1..128000`);
      prompts.push({ id, tipo, system, user, maxTokens, promptSha256: recomputed });
    }
  }
  let listaSha256: string; let perModelListSha256: Record<PilotModel, string> | undefined;
  if (v3) {
    listaSha256 = sha(JSON.stringify(prompts.map((p) => [p.id, p.promptSha256])));
    if (listaSha256 !== declaredMain) throw mismatch(`listaPromptsSha256 declared ${declaredMain} != recomputed ${listaSha256}`);
    const listas = (j['listas'] ?? {}) as Record<string, { listaComMaxTokensSha256?: string; somaMaxTokens?: number }>;
    perModelListSha256 = {} as Record<PilotModel, string>;
    for (const m of Object.keys(V3_FIELD) as PilotModel[]) {
      const calc = sha(JSON.stringify(prompts.map((p) => [p.id, p.promptSha256, p.maxTokensByModel![m]])));
      const decl = listas[V3_FIELD[m].key];
      if (!decl || decl.listaComMaxTokensSha256 !== calc) throw mismatch(`listas.${V3_FIELD[m].key}.listaComMaxTokensSha256 declared ${String(decl?.listaComMaxTokensSha256)} != recomputed ${calc}`);
      const soma = prompts.reduce((a, p) => a + p.maxTokensByModel![m], 0);
      if (decl.somaMaxTokens !== soma) throw mismatch(`listas.${V3_FIELD[m].key}.somaMaxTokens declared ${String(decl.somaMaxTokens)} != recomputed ${soma}`);
      perModelListSha256[m] = calc;
    }
  } else {
    listaSha256 = sha(JSON.stringify(prompts.map((p) => [p.id, p.promptSha256, p.maxTokens])));
    if (listaSha256 !== declaredMain) throw mismatch(`listaSha256 declared ${declaredMain} != recomputed ${listaSha256}`);
  }
  if (expectedListSha256 !== undefined) {
    if (!HEX64.test(expectedListSha256)) throw new CliError(EXIT.USAGE, 'BAD_PILOT_LIST_SHA', 'hex64 expected');
    const accepted = [listaSha256, ...Object.values(perModelListSha256 ?? {})];
    if (!accepted.includes(expectedListSha256)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PILOT_LIST_NOT_THE_EXPECTED_ONE', `expected ${expectedListSha256}, the file carries ${accepted.join(' | ')}`);
  }
  return { file, fileSha256: sha(buf), schema, listaSha256, perModelListSha256, prompts };
}

/** system + user as neutral content. The content hash is the executor's own (contentHash); the list's promptSha256 is kept in the manifest. */
export function contentOfPilot(p: PilotPrompt): ResolvedContentLike {
  const messages: ResolvedContentLike['messages'] = [
    ...(p.system.length > 0 ? [{ role: 'system' as const, parts: [{ type: 'text' as const, text: p.system }] }] : []),
    { role: 'user' as const, parts: [{ type: 'text' as const, text: p.user }] },
  ];
  return { promptSha256: contentHash({ messages, prefixMessages: 'NOT_APPLICABLE' }), messages, prefixMessages: 'NOT_APPLICABLE' };
}

export interface PilotManifest { kind: typeof PILOT_MANIFEST_KIND; corpusSha256: string; seed: 0; modelDesigns: Record<string, never>; pilotList: { fileName: string; fileSha256: string; schema: string; listaSha256: string; perModelListSha256?: Record<PilotModel, string>; prompts: Array<{ id: string; tipo: string; maxTokens?: number; maxTokensByModel?: Record<PilotModel, number>; listPromptSha256: string; contentSha256: string }> } }

/** Writes <dir>/manifest.json and <dir>/content/<sha256>. Idempotent; a different manifest already present is refused (never overwritten). */
export function materializePilotCorpus(list: PilotList, dir: string): { manifestPath: string; manifestSha256: string } {
  const store = createContentStore(dir);
  const rows = list.prompts.map((p) => { const c = contentOfPilot(p); const contentSha256 = store.put({ messages: c.messages, prefixMessages: c.prefixMessages }); return { id: p.id, tipo: p.tipo, ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}), ...(p.maxTokensByModel ? { maxTokensByModel: p.maxTokensByModel } : {}), listPromptSha256: p.promptSha256, contentSha256 }; });
  const manifest: PilotManifest = { kind: PILOT_MANIFEST_KIND, corpusSha256: list.listaSha256, seed: 0, modelDesigns: {}, pilotList: { fileName: path.basename(list.file), fileSha256: list.fileSha256, schema: list.schema, listaSha256: list.listaSha256, ...(list.perModelListSha256 ? { perModelListSha256: list.perModelListSha256 } : {}), prompts: rows } };
  const manifestPath = path.join(dir, 'manifest.json'); const body = canonicalJson(manifest) + '\n';
  if (existsSync(manifestPath)) { if (readFileSync(manifestPath, 'utf8') !== body) throw new CliError(EXIT.REFUSED_BY_POLICY, 'PILOT_CORPUS_CONFLICT', `${manifestPath} exists with a different content: use a new directory`); }
  else writeFileSync(manifestPath, body, { flag: 'wx' });
  return { manifestPath, manifestSha256: sha(readFileSync(manifestPath)) };
}
