/**
 * H2-EVAL / R13 — CLI do corpus novo. OFFLINE; escreve só no diretório de saída novo (recusa se existir).
 *   tsx scripts/h2eval/corpus/build.ts --out <dir novo> [--seed N] [--repo <clone da H1>] [--h1-campaign-corpus <jsonl>] [--s2 15] [--s3 30]
 *                                     [--prefix-chars N] [--forbidden-seeds arquivo.json] [--no-repo-scan]
 * Semente: padrão 20261110 (R09 R2 §1), o Bruno pode passar outra; semente já usada é recusada (exit 3) e, no congelamento, a varredura
 * somente leitura dos refs (`seed_verification.json`) tem de dar "NOT_FOUND_IN_SCANNED_REFS". Colisão exata de texto contra a H1 e a
 * CAL-ANTH (`text_collision_report.json`) PARA a geração (exit 4): nada é ajustado. Nada aqui lê chave, rede ou relógio.
 * Saídas: s1_prompts.jsonl, dialogs.jsonl, manifest.json, seed_verification.json, text_collision_report.json,
 *         s1_operations.<modelo>.jsonl, content/<sha256> (ContentStore).
 *
 * In English: command-line entry point that freezes a new evaluation corpus (S1 prompts and multi-turn dialogs) into a
 * new output folder. It refuses an existing folder (exit 1), a seed already used (exit 3, via `seedGuard` and the
 * read-only git scan in `seedVerify`) and an exact text collision with earlier corpora (exit 4, via `collision` and
 * `refCorpora`; only the two reports are written then). Token counts use `js-tiktoken` when it is installed; without it
 * the manifest records `'UNKNOWN'`, never zero. Spawned by `freezeCorpus` in `scripts/h2eval/cli/freeze.ts`.
 * It reads no keys, no network and no clock. Note: the SHA-256 of every generator source file (this folder plus
 * `cache/dialogs.ts` and `cache/contentStore.ts`) is recorded in the manifest as provenance, so editing those files
 * changes that list (not `corpusSha256`).
 *
 * @module scripts/h2eval/corpus/build
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentStore, contentOfS1 } from '../cache/contentStore.js';
import { contentOf } from '../cache/dialogs.js';
import { collisionReport, type MyText } from './collision.js';
import type { SplitPlan } from './manifest.js'; // C154
import { buildCorpus, type Counters } from './manifest.js';
import { loadDefaultReferences } from './refCorpora.js';
import { DEFAULT_DESIGNS, s1PlanFor, type ModelId } from './s1Plan.js';
import { assertFreshSeed, DEFAULT_SEED, SeedRejectedError } from './seedGuard.js';
import { verifySeedUnused } from './seedVerify.js';
import { canonicalJson } from './util.js';

const arg = (n: string): string | null => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const flag = (n: string): boolean => process.argv.includes(`--${n}`);
const outArg = arg('out');
if (!outArg) { console.error('uso: build.ts --out <dir novo> [--seed N] [--repo <clone>] [--h1-campaign-corpus <jsonl>] [--s2 N] [--s3 N] [--prefix-chars N] [--groups-per-cell N] [--split-plan f.json] [--repeats-per-cell N] [--forbidden-seeds f.json] [--no-repo-scan]'); process.exit(2); }
const out = path.resolve(outArg);
if (fs.existsSync(out)) { console.error(`já existe: ${out} (não sobrescrevo)`); process.exit(1); }
const seed = arg('seed') ? Number(arg('seed')) : DEFAULT_SEED;
const repo = arg('repo') ?? 'C:/dev/otk-i10-20261104';
const extra: number[] = arg('forbidden-seeds') ? (JSON.parse(fs.readFileSync(path.resolve(arg('forbidden-seeds')!), 'utf8')) as number[]) : [];

try { assertFreshSeed(seed, extra); } catch (e) { if (e instanceof SeedRejectedError) { console.error(`SEMENTE RECUSADA [${e.code}]: ${e.message}`); process.exit(3); } throw e; }

// 1) varredura de semente nos refs (somente leitura)
const seedVer = flag('no-repo-scan')
  ? { schema: 'otk.h2eval.seed_verification.v1' as const, candidateSeed: String(seed), repo, method: 'NOT_SCANNED (--no-repo-scan)', refs: [], candidateFoundInAnyRef: false, allRefsScanned: false, verdict: 'INCOMPLETE_SCAN' as const, limits: ['varredura não executada: nenhuma prova de semente nunca usada'] }
  : verifySeedUnused(seed, repo);
if (seedVer.verdict === 'FOUND') { console.error(`SEMENTE RECUSADA: ${seed} aparece em ${seedVer.refs.filter((r) => r.filesContainingSeed > 0).map((r) => r.ref).join(', ')}`); process.exit(3); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const generatorFiles = [...fs.readdirSync(HERE).filter((f) => f.endsWith('.ts')).map((f) => path.join(HERE, f)), path.join(HERE, '..', 'cache', 'dialogs.ts'), path.join(HERE, '..', 'cache', 'contentStore.ts')]
  .sort().map((f) => ({ path: path.relative(path.join(HERE, '..', '..', '..'), f).split(path.sep).join('/'), sha256: createHash('sha256').update(fs.readFileSync(f)).digest('hex') }));

// 2) contadores locais (estimativa; opcional). Sem js-tiktoken => 'UNKNOWN' no manifesto, nunca 0.
let counters: Counters = {}; let tokenizerVersion: string | null = null;
try {
  const req = createRequire(import.meta.url);
  const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
  const mk = (n: string) => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
  counters = { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
  let d = path.dirname(req.resolve('js-tiktoken'));
  for (let i = 0; i < 6 && !tokenizerVersion; i++) { try { const pj = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as { name?: string; version?: string }; if (pj.name === 'js-tiktoken') tokenizerVersion = pj.version ?? null; } catch { /* sobe */ } d = path.dirname(d); }
} catch { /* sem contador */ }

const b0 = buildCorpus({ seed, s2Dialogs: arg('s2') ? Number(arg('s2')) : undefined, s3Dialogs: arg('s3') ? Number(arg('s3')) : undefined, prefixChars: arg('prefix-chars') ? Number(arg('prefix-chars')) : undefined, extraForbiddenSeeds: extra }, { counters, generatorFiles, tokenizerVersion, seedVerification: seedVer });

// 3) colisão de texto contra os corpora já usados (byte a byte)
const h1Camp = arg('h1-campaign-corpus') ?? 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/R03/corpus/corpus_seed20261007_g9_v2.jsonl';
const { refs, notCompared } = loadDefaultReferences(repo, fs.existsSync(h1Camp) ? h1Camp : null);
const mine: MyText[] = [
  ...b0.s1.prompts.map((p) => ({ id: p.promptId, kind: 's1' as const, text: p.text })),
  ...b0.dialogs.flatMap((d) => [{ id: `${d.dialogId}/system`, kind: 'dialog_system' as const, text: d.prefix }, ...d.turns.map((t, i) => ({ id: `${d.dialogId}/turn${i + 1}`, kind: 'dialog_turn' as const, text: t.user }))]),
];
const collision = { ...collisionReport(mine, refs), notCompared };

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'seed_verification.json'), JSON.stringify(seedVer, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'text_collision_report.json'), JSON.stringify(collision, null, 1) + '\n');
if (collision.verdict === 'EXACT_COLLISION') { console.error(`COLISÃO EXATA de texto (${collision.exactCollisions.length}); nada gerado além dos relatórios`); process.exit(4); }

// C154: --groups-per-cell exposes the existing BuildOptions.groupsPerCell (default 8 => 4/2/2 groups per cell); e.g. 12 => 6/3/3, a bigger holdout with the same cells/variants/repeats.
// C154: --split-plan <json> (composicao explicita) e --repeats-per-cell N
const b = buildCorpus({ seed, s2Dialogs: arg('s2') ? Number(arg('s2')) : undefined, s3Dialogs: arg('s3') ? Number(arg('s3')) : undefined, prefixChars: arg('prefix-chars') ? Number(arg('prefix-chars')) : undefined, groupsPerCell: arg('groups-per-cell') ? Number(arg('groups-per-cell')) : undefined, ...(arg('repeats-per-cell') ? { repeatsPerCell: Number(arg('repeats-per-cell')) } : {}), ...(arg('split-plan') ? { splitPlan: JSON.parse(fs.readFileSync(arg('split-plan')!, 'utf8')) as SplitPlan } : {}), extraForbiddenSeeds: extra }, { counters, generatorFiles, tokenizerVersion, seedVerification: seedVer, collision });
fs.writeFileSync(path.join(out, 's1_prompts.jsonl'), b.s1Jsonl); fs.writeFileSync(path.join(out, 'dialogs.jsonl'), b.dialogsJsonl);
for (const m of Object.keys(DEFAULT_DESIGNS) as ModelId[]) { const design = (b.manifest['modelDesigns'] as Record<string, { design: 'FULL' | 'B_REDUZIDO' }>)[m]!.design; fs.writeFileSync(path.join(out, `s1_operations.${m}.jsonl`), s1PlanFor(b.s1, design).map((o) => canonicalJson(o)).join('\n') + '\n'); }
const store = createContentStore(out); let stored = 0;
for (const p of b.s1.prompts) { store.put(contentOfS1(p)); stored += 1; }
for (const d of b.dialogs) for (const k of [1, 2, 3] as const) { store.put(contentOf(d, k)); stored += 1; }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(b.manifest, null, 1) + '\n');
console.log(JSON.stringify({ ok: true, out, seed, corpusSha256: (b.manifest as { corpusSha256: string }).corpusSha256, counts: (b.manifest as { counts: unknown }).counts, seedVerdict: seedVer.verdict, collisionVerdict: collision.verdict, contentFiles: stored }));
