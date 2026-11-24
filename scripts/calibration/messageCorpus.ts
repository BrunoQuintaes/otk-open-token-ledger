/**
 * OVERNIGHT 20261005 / Phase 8 — request-shaped calibration corpus (multi-message) built from the synthetic text
 * corpus v1 (corpus.ts). No personal or third-party content: every text comes from the seeded generator.
 *
 * Each group of corpus v1 (one base text + near-duplicate variants) yields:
 *   - one single-message request per document (user message = the document);
 *   - one conversation (optional system text + 2–4 alternating user/assistant messages) built ONLY from texts of
 *     that same group.
 * The split is decided by the GROUP id (splitOf of corpus.ts: sha256(version:group) mod 100 → <60 train, <80
 * validation, else holdout), so no text, variant or conversation of a group crosses splits (no leakage).
 *
 * Counting goes through the runtime counter itself (createLocalCounter with the catalog's ModelSupport), so the
 * local numbers are exactly what the conference would see for the same request body.
 */
import { createHash } from 'node:crypto';
import type { ModelSupport, UsageApi } from '../../src/types/d1d8/index.js';
import { createLocalCounter } from '../../src/tokenization/localCounter.js';
import { countWith, loadEncoding } from '../../src/tokenization/tokenizerIdentity.js';
import { CORPUS_VERSION, splitOf, type CorpusDoc } from './corpus.js';

export const MESSAGE_CORPUS_VERSION = 'otk.calibration_corpus.messages.v1';
export type Split = 'train' | 'validation' | 'holdout';

export interface MessageDoc {
  id: string;
  group: string;
  family: string;
  split: Split;
  kind: 'single' | 'conversation';
  system: string | null;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Text used as the visible output of the simulated response (another text of the same group). */
  outputText: string;
}

export const toSplit = (group: string): Split => { const s = splitOf(group); return s === 'test' ? 'holdout' : s; };

function h(s: string): number {
  return parseInt(createHash('sha256').update(`${MESSAGE_CORPUS_VERSION}:${s}`, 'utf8').digest('hex').slice(0, 8), 16);
}

export function buildMessageCorpus(docs: CorpusDoc[]): MessageDoc[] {
  const byGroup = new Map<string, CorpusDoc[]>();
  for (const d of docs) byGroup.set(d.group, [...(byGroup.get(d.group) ?? []), d]);
  const out: MessageDoc[] = [];
  for (const [group, ds] of [...byGroup.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...ds].sort((a, b) => a.variant - b.variant);
    const split = toSplit(group);
    sorted.forEach((d, i) => {
      out.push({ id: `${d.id}-single`, group, family: d.family, split, kind: 'single', system: null,
        messages: [{ role: 'user', text: d.text }], outputText: sorted[(i + 1) % sorted.length]!.text });
    });
    const k = 2 + (h(group) % 3);
    const texts = sorted.map((d) => d.text);
    const messages = Array.from({ length: k }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', text: texts[i % texts.length]! }));
    out.push({ id: `${group}-conv`, group, family: sorted[0]!.family, split, kind: 'conversation',
      system: h(`${group}:sys`) % 2 === 0 ? texts[texts.length - 1]! : null, messages, outputText: texts[0]! });
  }
  return out;
}

/** Request body in the wire format of each API (text parts only). */
export function toRequestBody(api: UsageApi, model: string, d: MessageDoc): Record<string, unknown> {
  switch (api) {
    case 'anthropic.messages':
      return { model, max_tokens: 64, ...(d.system !== null ? { system: d.system } : {}), messages: d.messages.map((m) => ({ role: m.role, content: m.text })) };
    case 'gemini.generate_content':
      return {
        ...(d.system !== null ? { systemInstruction: { parts: [{ text: d.system }] } } : {}),
        contents: d.messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
      };
    case 'openai.chat_completions':
      return { model, max_tokens: 64, messages: [...(d.system !== null ? [{ role: 'system', content: d.system }] : []), ...d.messages.map((m) => ({ role: m.role, content: m.text }))] };
    default:
      throw new Error(`api ${api} not rendered by the message corpus`);
  }
}

/** Raw local counts of the runtime counter for a request body and an output text (null = category uncovered). */
export function localCountsOf(support: ModelSupport, body: unknown, outputText: string | null): { input: number | null; output: number | null; counterVersion: string } {
  const counter = createLocalCounter(support, { maxTextBytes: 1 << 22 });
  counter.observeInput({ api: support.api, body });
  if (outputText !== null) counter.observeOutputText(outputText);
  const r = counter.finish();
  const get = (c: 'input' | 'output') => (r.covered.includes(c) ? Number(r.counts.find((x) => x.category === c)?.count ?? NaN) : null);
  return { input: get('input'), output: outputText === null ? null : get('output'), counterVersion: r.counterVersion };
}

/**
 * SYNTHETIC target rule v1 (tests only; NOT any provider's rule): input = Σ o200k_base(text part) + 3 per message
 * (system counted as a message) + 3; output = o200k_base(output text). It stands in for "a different tokenizer
 * plus an envelope" so the fitting and the runtime path can be exercised without provider calls.
 */
export const SYNTHETIC_RULE_V1 = 'otk.synthetic_target.o200k_plus_3_per_message_plus_3@1';
export function syntheticTarget(d: MessageDoc): { input: number; output: number } {
  const enc = loadEncoding('o200k_base').encoder;
  const parts = [...(d.system !== null ? [d.system] : []), ...d.messages.map((m) => m.text)];
  return { input: parts.reduce((s, t) => s + countWith(enc, t), 0) + 3 * parts.length + 3, output: countWith(enc, d.outputText) };
}

export const MESSAGE_CORPUS_SPLIT_RULE = `group split of ${CORPUS_VERSION}: sha256(version:group) mod 100 → <60 train, <80 validation, else holdout`;
