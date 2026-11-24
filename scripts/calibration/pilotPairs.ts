/**
 * OVERNIGHT 20261005 / Phase 8 — (local count, provider count) pairs from the historical real pilot PILOTO_V3
 * (24 real calls on 2026-10-03/04: Anthropic claude-haiku-4-5-20251001, OpenAI gpt-4o-mini, Gemini
 * gemini-3.5-flash-lite; 8 calls each). Reads only the committed run records (calls.jsonl + manifest.json);
 * makes no call and needs no key.
 *
 * The run records keep provider usage but not the texts. The prompts were deterministic (runPilotV3.ts:
 * ASK, the disconnect prompt and syntheticText(n)); they are rebuilt here and each one is checked against the
 * promptSha256 the manifest recorded, so a reconstruction error stops the extraction instead of producing pairs.
 * Output text was NOT recorded (only its sha256 and length): output pairs cannot be built, only input pairs.
 *
 * Target = provider input total as the conference compares it: Anthropic input_tokens + cache_creation + cache_read;
 * OpenAI prompt_tokens (cached tokens are inside it); Gemini promptTokenCount (cache inside it). A record without
 * client-side usage (OpenAI after the deliberate disconnect) is excluded with its reason.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageApi } from '../../src/types/d1d8/index.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { localCountsOf, type Split } from './messageCorpus.js';
import type { CalibrationPair } from './fitProfile.js';

export const PILOT_PAIRS_VERSION = 'otk.calibration_pairs.pilot_v3.v1';

export interface PilotSource { dir: string; provider: string; api: UsageApi; model: string }
export const PILOT_SOURCES: PilotSource[] = [
  { dir: 'live', provider: 'anthropic', api: 'anthropic.messages', model: 'claude-haiku-4-5-20251001' },
  { dir: 'live_openai', provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini' },
  { dir: 'live_gemini35', provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-3.5-flash-lite' },
];

// ── prompts exactly as scripts/pilot/anthropic/runPilotV3.ts built them (checked against the manifests' sha256) ──
const ASK = 'Responda apenas com a palavra ok.';
const DISCONNECT = 'Escreva os números de 1 a 40 por extenso, separados por vírgula.';
function syntheticText(sentences: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sentences; i++) parts.push(`Frase ${i}: o medidor registra ${i * 7} unidades no lote ${100 + i}, sem dados pessoais.`);
  return parts.join(' ');
}
export function pilotPrompt(label: string): string | null {
  if (label === 'minimal' || label === 'stream' || label === 'besu') return ASK;
  if (label === 'disconnect') return DISCONNECT;
  const m = /^sample-(curto|medio)-(stream|nostream)$/.exec(label);
  if (m) return `Resuma em uma frase curta o texto a seguir.\n\n${syntheticText(m[1] === 'curto' ? 3 : 60)}`;
  return null;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function pilotSplit(provider: string, promptSha: string): Split {
  const h = parseInt(sha(`${PILOT_PAIRS_VERSION}:${provider}:${promptSha}`).slice(0, 8), 16) % 100;
  return h < 60 ? 'train' : h < 80 ? 'validation' : 'holdout';
}

function providerInputTotal(provider: string, u: Record<string, unknown> | null): number | null {
  if (!u) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  if (provider === 'anthropic') {
    const a = n(u['input_tokens']); const w = n(u['cache_creation_input_tokens'] ?? 0); const r = n(u['cache_read_input_tokens'] ?? 0);
    return a === null || w === null || r === null ? null : a + w + r;
  }
  if (provider === 'openai') return n(u['prompt_tokens']);
  if (provider === 'gemini') return n(u['promptTokenCount']);
  return null;
}

export interface PilotRow {
  runId: string; label: string; provider: string; api: UsageApi; model: string; returnedModel: string | null; stream: boolean;
  promptSha256: string; group: string; split: Split; local: number; target: number;
}
export interface PilotExtraction {
  version: string;
  rows: PilotRow[];
  excluded: Array<{ runId: string; label: string; provider: string; reason: string }>;
  counterVersion: string | null;
}

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** Extracts input pairs from a PILOTO_V3 directory (read-only). */
export function extractPilotPairs(pilotDir: string): PilotExtraction {
  const rows: PilotRow[] = [];
  const excluded: PilotExtraction['excluded'] = [];
  let counterVersion: string | null = null;
  for (const src of PILOT_SOURCES) {
    const files = walk(join(pilotDir, src.dir));
    const shaByLabel = new Map<string, string>();
    for (const mf of files.filter((f) => f.endsWith('_manifest.json'))) {
      const m = JSON.parse(readFileSync(mf, 'utf8')) as { plannedCalls?: Array<{ label: string; promptSha256: string }> };
      for (const c of m.plannedCalls ?? []) shaByLabel.set(c.label, c.promptSha256);
    }
    const support = resolveModelSupport(src.provider, src.api, src.model);
    for (const cf of files.filter((f) => f.endsWith('_calls.jsonl')).sort()) {
      for (const line of readFileSync(cf, 'utf8').split('\n').filter((l) => l.trim())) {
        const r = JSON.parse(line) as { runId: string; label: string; stream: boolean; httpStatus: number; returnedModel?: string; clientUsage: Record<string, unknown> | null };
        const prompt = pilotPrompt(r.label);
        if (prompt === null) { excluded.push({ runId: r.runId, label: r.label, provider: src.provider, reason: 'unknown_label' }); continue; }
        const expectedSha = shaByLabel.get(r.label);
        if (!expectedSha) throw new Error(`${src.dir}/${r.label}: manifest has no promptSha256`);
        if (sha(prompt) !== expectedSha) throw new Error(`${src.dir}/${r.label}: rebuilt prompt sha256 differs from the manifest`);
        if (r.httpStatus !== 200) { excluded.push({ runId: r.runId, label: r.label, provider: src.provider, reason: `http_${r.httpStatus}` }); continue; }
        const target = providerInputTotal(src.provider, r.clientUsage);
        if (target === null) { excluded.push({ runId: r.runId, label: r.label, provider: src.provider, reason: 'no_client_usage_recorded' }); continue; }
        const body = src.api === 'gemini.generate_content'
          ? { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
          : { model: src.model, max_tokens: 64, messages: [{ role: 'user', content: prompt }] };
        const local = localCountsOf(support, body, null);
        counterVersion = local.counterVersion;
        if (local.input === null) { excluded.push({ runId: r.runId, label: r.label, provider: src.provider, reason: 'local_input_uncovered' }); continue; }
        rows.push({ runId: r.runId, label: r.label, provider: src.provider, api: src.api, model: src.model, returnedModel: r.returnedModel ?? null,
          stream: r.stream, promptSha256: expectedSha, group: `${src.provider}:${expectedSha.slice(0, 16)}`, split: pilotSplit(src.provider, expectedSha), local: local.input, target });
      }
    }
  }
  return { version: PILOT_PAIRS_VERSION, rows, excluded, counterVersion };
}

export function pilotRowsToPairs(rows: PilotRow[]): CalibrationPair[] {
  return rows.map((r) => ({ id: `${r.runId}:${r.label}`, group: r.group, split: r.split, category: 'input', local: r.local, target: r.target }));
}
