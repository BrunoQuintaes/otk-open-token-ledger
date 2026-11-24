/**
 * H2-EVAL / R13 — leitura SOMENTE LEITURA dos corpora de referência (H1 e CAL-ANTH) para a verificação de colisão de texto.
 * `git show <ref>:<caminho>` (sem checkout); o arquivo local da campanha H1 (R03) entra por caminho. Sem rede.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { sha256Hex } from './util.js';
import type { RefCorpus } from './collision.js';

const parse = (jsonl: string): Array<{ id: string; text: string }> => jsonl.split('\n').filter(Boolean).map((l, i) => { const o = JSON.parse(l) as { id?: string; text?: string }; return { id: o.id ?? String(i), text: String(o.text ?? '') }; });

export function loadFromGit(repo: string, ref: string, path: string, name: string, expectedCount: number | null): RefCorpus {
  const r = spawnSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`não consegui ler ${ref}:${path}`);
  return { name, source: `git:${ref}:${path}`, fileSha256: sha256Hex((r.stdout as Buffer).toString('utf8')), expectedCount, texts: parse((r.stdout as Buffer).toString('utf8')) };
}

export function loadFromFile(path: string, name: string, expectedCount: number | null): RefCorpus {
  const s = fs.readFileSync(path, 'utf8');
  return { name, source: `file:${path.split(String.fromCharCode(92)).join('/')}`, fileSha256: sha256Hex(s), expectedCount, texts: parse(s) };
}

/** Corpora exigidos pelo R09 R2 §1 (contagens esperadas: CAL-01 288, CAL-02 dev 720, CAL-02 holdout 192) mais os da H1. */
export function loadDefaultReferences(repo: string, h1CampaignCorpusFile: string | null): { refs: RefCorpus[]; notCompared: string[] } {
  const refs: RefCorpus[] = []; const notCompared: string[] = [];
  const CAL2 = 'origin/experiment/otk-cal-anth-02-20261015';
  const tryLoad = (name: string, f: () => RefCorpus): void => { try { refs.push(f()); } catch (e) { notCompared.push(`${name}: ${String((e as Error).message).slice(0, 120)}`); } };
  tryLoad('H1 desenvolvimento (seed 20260930)', () => loadFromGit(repo, '7606bc9b', 'test/fixtures/d1d8/b/calibration_corpus_v1.jsonl', 'H1_DEV_20260930', null));
  if (h1CampaignCorpusFile) tryLoad('H1 campanha (seed 20261007)', () => loadFromFile(h1CampaignCorpusFile, 'H1_CAMPAIGN_20261007', 216)); else notCompared.push('H1 campanha (seed 20261007): arquivo não informado');
  tryLoad('CAL-ANTH-01', () => loadFromGit(repo, 'b55c34298fa7e24ec936396117ce1c7e58f61805', 'docs/_ops/experiments/OTK_CAL_ANTH_01/corpus.jsonl', 'CAL_ANTH_01', 288));
  tryLoad('CAL-ANTH-02 dev', () => loadFromGit(repo, CAL2, 'docs/_ops/experiments/OTK_CAL_ANTH_02/dev_corpus.jsonl', 'CAL_ANTH_02_DEV', 720));
  tryLoad('CAL-ANTH-02 holdout', () => loadFromGit(repo, CAL2, 'docs/_ops/experiments/OTK_CAL_ANTH_02/holdout_corpus.jsonl', 'CAL_ANTH_02_HOLDOUT', 192));
  return { refs, notCompared };
}
