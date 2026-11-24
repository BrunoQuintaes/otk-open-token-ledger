/**
 * Changelog Dashboard Handler (NEW-6.02)
 *
 * Serves two endpoints:
 *   GET /changelog        — HTML page with styled release notes
 *   GET /v1/changelog     — JSON API: list of parsed changelog entries
 *
 * Source: reads CHANGELOG.md from the repo root (process.cwd()).
 * Format: Conventional changelog (## [version] - date / ### section / - item).
 *
 * @module dashboard/changelog
 * @since Wave 6 (NEW-6.02)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../api/errors.js';

export interface ChangelogEntry {
  version: string;
  date: string | null;
  sections: Record<string, string[]>; // section name → list of items
  rawText: string;
}

const CHANGELOG_PATH = join(process.cwd(), 'CHANGELOG.md');

/** Parse CHANGELOG.md into structured entries. */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  // Split on ## headings that look like versions: ## [x.y.z] or ## x.y.z
  const versionBlocks = raw.split(/^(?=## )/m).filter(Boolean);

  for (const block of versionBlocks) {
    const firstLine = block.split('\n')[0].trim();
    // Match: ## [1.2.3] - 2026-01-01  or  ## 1.2.3
    const match = firstLine.match(/^## \[?([^\]\s]+)\]?\s*(?:-\s*(.+))?$/);
    if (!match) continue;

    const version = match[1];
    const date = match[2]?.trim() ?? null;

    // Parse ### subsections
    const sections: Record<string, string[]> = {};
    const sectionBlocks = block.split(/^(?=### )/m).slice(1); // skip first (version line)

    for (const sb of sectionBlocks) {
      const lines = sb.split('\n');
      const sectionName = lines[0].replace(/^### /, '').trim();
      const items = lines.slice(1)
        .map(l => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);
      if (items.length > 0) {
        sections[sectionName] = items;
      }
    }

    entries.push({ version, date, sections, rawText: block.trim() });
  }

  return entries;
}

/** Load and parse changelog, with graceful fallback if file missing. */
function loadChangelog(filePath?: string): ChangelogEntry[] {
  const target = filePath ?? CHANGELOG_PATH;
  if (!existsSync(target)) return [];
  try {
    const raw = readFileSync(target, 'utf8');
    return parseChangelog(raw);
  } catch {
    return [];
  }
}

/** Render entries as an HTML page. */
function renderHtml(entries: ChangelogEntry[]): string {
  const renderSection = (name: string, items: string[]): string => `
    <div class="section">
      <h3>${escHtml(name)}</h3>
      <ul>${items.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>
    </div>`;

  const renderEntry = (e: ChangelogEntry): string => `
    <div class="entry">
      <h2 class="version">
        <span class="tag">${escHtml(e.version)}</span>
        ${e.date ? `<span class="date">${escHtml(e.date)}</span>` : ''}
      </h2>
      ${Object.keys(e.sections).length === 0
        ? '<p class="empty">No categorized changes.</p>'
        : Object.entries(e.sections).map(([n, items]) => renderSection(n, items)).join('')
      }
    </div>`;

  const body = entries.length === 0
    ? '<p>No changelog entries found.</p>'
    : entries.map(renderEntry).join('<hr>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OTK — Changelog</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { border-bottom: 2px solid #e8e8e8; padding-bottom: 8px; }
    .entry { margin: 32px 0; }
    .version { display: flex; align-items: center; gap: 12px; font-size: 1.3rem; }
    .tag { background: #0069d9; color: #fff; padding: 2px 10px; border-radius: 4px; font-size: 0.95rem; }
    .date { color: #666; font-size: 0.9rem; font-weight: normal; }
    .section h3 { color: #444; font-size: 1rem; margin: 12px 0 4px; }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 4px 0; font-size: 0.93rem; }
    hr { border: none; border-top: 1px solid #eee; margin: 32px 0; }
    .empty { color: #999; font-style: italic; }
    nav { margin-bottom: 24px; }
    nav a { color: #0069d9; text-decoration: none; margin-right: 16px; }
    nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <nav><a href="/">← Dashboard</a><a href="/status">Status</a></nav>
  <h1>Release Changelog</h1>
  ${body}
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Handle GET /changelog — HTML */
export function handleChangelogHtml(_req: IncomingMessage, res: ServerResponse): void {
  const entries = loadChangelog();
  const html = renderHtml(entries);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** Handle GET /v1/changelog — JSON */
export function handleChangelogJson(_req: IncomingMessage, res: ServerResponse): void {
  const entries = loadChangelog();
  sendJson(res, 200, { entries, count: entries.length });
}
