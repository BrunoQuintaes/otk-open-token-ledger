/**
 * Explicit model alias table for reconciliation (no fuzzy matching, no guessing).
 *
 * A provider statement may name a model differently from what OTK recorded: a dated snapshot
 * ('gpt-4o-mini-2024-07-18' vs 'gpt-4o-mini'), a resource prefix ('models/gemini-3.5-flash-lite')
 * or a display name inside a SKU/line description ('Claude Haiku 4.5'). Only the entries below are
 * joined; an id that is neither canonical nor listed is UNKNOWN. Every entry says where it comes from.
 *
 * @module reconciliation/aliases
 */
import type { ReconProvider } from './types.js';

export interface ModelAliasEntry {
  provider: ReconProvider;
  alias: string;
  canonical: string;
  kind: 'dated_snapshot' | 'resource_prefix' | 'display_name';
  source: string;
}

export interface AliasTable {
  id: string;
  /** Canonical model ids per provider (lowercase). */
  canonical: Record<ReconProvider, string[]>;
  entries: ModelAliasEntry[];
}

export const RECON_ALIAS_TABLE_V1: AliasTable = Object.freeze({
  id: 'otk.reconciliation_aliases.v1@2026-10-06',
  canonical: {
    anthropic: ['claude-haiku-4-5'],
    openai: ['gpt-4o-mini'],
    gemini: ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
  },
  entries: [
    { provider: 'anthropic', alias: 'claude-haiku-4-5-20251001', canonical: 'claude-haiku-4-5', kind: 'dated_snapshot', source: 'returned by the Anthropic API in the PILOTO_V3 real calls (2026-10-03); same alias in scripts/pilot/price_table_pilot_v3_20261003.json' },
    { provider: 'openai', alias: 'gpt-4o-mini-2024-07-18', canonical: 'gpt-4o-mini', kind: 'dated_snapshot', source: 'returned by the OpenAI API in the PILOTO_V3 real calls (2026-10-03); same alias in scripts/pilot/price_table_pilot_v3_20261003.json' },
    { provider: 'anthropic', alias: 'claude haiku 4.5', canonical: 'claude-haiku-4-5', kind: 'display_name', source: 'UNVERIFIED_ASSUMPTION: display name style seen in the cost_report example description ("Claude Opus 5 Usage - Input Tokens", platform.claude.com, accessed 2026-10-06); the Haiku 4.5 string itself was not observed' },
    { provider: 'gemini', alias: 'gemini 3.5 flash-lite', canonical: 'gemini-3.5-flash-lite', kind: 'display_name', source: 'UNVERIFIED_ASSUMPTION: Cloud Billing SKU description wording for the Gemini API was not verified in official docs' },
    { provider: 'gemini', alias: 'gemini 3.5 flash lite', canonical: 'gemini-3.5-flash-lite', kind: 'display_name', source: 'UNVERIFIED_ASSUMPTION: Cloud Billing SKU description wording for the Gemini API was not verified in official docs' },
    { provider: 'gemini', alias: 'gemini 2.5 flash-lite', canonical: 'gemini-2.5-flash-lite', kind: 'display_name', source: 'UNVERIFIED_ASSUMPTION: Cloud Billing SKU description wording for the Gemini API was not verified in official docs' },
    { provider: 'gemini', alias: 'gemini 2.5 flash lite', canonical: 'gemini-2.5-flash-lite', kind: 'display_name', source: 'UNVERIFIED_ASSUMPTION: Cloud Billing SKU description wording for the Gemini API was not verified in official docs' },
  ],
}) as AliasTable;

export interface CanonicalModel {
  canonical: string | null;
  /** true when the canonical id was reached through an alias entry or prefix rule. */
  viaAlias: boolean;
  rule: string | null;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve a model string to the canonical id. Gemini's documented resource form 'models/<id>' is
 * stripped (resource_prefix). Extra aliases (e.g. from price tables) may be passed in.
 */
export function canonicalModel(provider: ReconProvider, raw: string | null, table: AliasTable = RECON_ALIAS_TABLE_V1, extra: Record<string, string> = {}): CanonicalModel {
  if (raw === null || raw.trim() === '') return { canonical: null, viaAlias: false, rule: null };
  let m = norm(raw);
  let viaAlias = false;
  let rule: string | null = null;
  if (provider === 'gemini' && m.startsWith('models/')) { m = m.slice('models/'.length); viaAlias = true; rule = 'resource_prefix:models/'; }
  const canon = table.canonical[provider] ?? [];
  if (canon.includes(m)) return { canonical: m, viaAlias, rule };
  const e = table.entries.find((x) => x.provider === provider && x.alias === m);
  if (e) return { canonical: e.canonical, viaAlias: true, rule: `${e.kind}:${e.alias}->${e.canonical}` };
  const x = extra[m];
  if (x !== undefined && canon.includes(x)) return { canonical: x, viaAlias: true, rule: `price_table_alias:${m}->${x}` };
  return { canonical: null, viaAlias: false, rule: null };
}

/** Find a display-name alias contained in a free-text description (longest alias first). */
export function modelFromDescription(provider: ReconProvider, text: string | null, table: AliasTable = RECON_ALIAS_TABLE_V1): CanonicalModel {
  if (!text) return { canonical: null, viaAlias: false, rule: null };
  const t = norm(text);
  const candidates = table.entries
    .filter((e) => e.provider === provider && e.kind === 'display_name')
    .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  for (const e of candidates) {
    const re = new RegExp(`(^|[^a-z0-9.])${e.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9.])`);
    if (re.test(t)) return { canonical: e.canonical, viaAlias: true, rule: `display_name:${e.alias}->${e.canonical}` };
  }
  // canonical ids written verbatim inside the description
  for (const c of [...(table.canonical[provider] ?? [])].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^a-z0-9.-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9.-])`);
    if (re.test(t)) return { canonical: c, viaAlias: false, rule: null };
  }
  return { canonical: null, viaAlias: false, rule: null };
}
