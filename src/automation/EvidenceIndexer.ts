/**
 * EvidenceIndexer — automated evidence collection and indexing pipeline (P5.1)
 *
 * Scans docs/_ops/ for evidence directories (EVDs) and builds a structured
 * index at docs/_ops/INDEX.json. The index enables ACE3 and audit tools to
 * quickly locate EVDs without scanning the directory tree.
 *
 * Index schema:
 *   {
 *     generatedAt: ISO string,
 *     totalEvds: number,
 *     evds: EvidenceEntry[]
 *   }
 *
 * EvidenceEntry:
 *   {
 *     path: relative path from repo root (e.g. "docs/_ops/wave5/W5_PACK01_20260403/"),
 *     phase: detected phase prefix (e.g. "wave5", "u6", "revalidation"),
 *     name: directory basename,
 *     files: string[],   // list of files inside (not recursive)
 *     hasGateR0: boolean,
 *     hasTests: boolean,
 *     hasDesign: boolean
 *   }
 *
 * @module automation/EvidenceIndexer
 * @since Wave 6 (P5.1)
 */

import { readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface EvidenceEntry {
  path: string;
  phase: string;
  name: string;
  files: string[];
  hasGateR0: boolean;
  hasTests: boolean;
  hasDesign: boolean;
}

export interface EvidenceIndex {
  generatedAt: string;
  totalEvds: number;
  evds: EvidenceEntry[];
}

const OPS_DIR_NAME = join('docs', '_ops');
const INDEX_FILE_NAME = 'INDEX.json';

/** Detect which phase a directory belongs to from its path components. */
function detectPhase(relPath: string): string {
  const parts = relPath.split(sep);
  // First segment after docs/_ops/ is the phase
  if (parts.length >= 3) return parts[2];
  return 'unknown';
}

/** Scan a single EVD directory and produce an entry. */
function scanEvd(absPath: string, repoRoot: string): EvidenceEntry {
  const relPath = relative(repoRoot, absPath) + sep;
  const name = absPath.split(sep).pop() ?? absPath;
  const phase = detectPhase(relPath);

  let files: string[] = [];
  try {
    files = readdirSync(absPath).filter(f => {
      try { return statSync(join(absPath, f)).isFile(); } catch { return false; }
    });
  } catch { /* unreadable */ }

  return {
    path: relPath,
    phase,
    name,
    files,
    hasGateR0: files.some(f => f.includes('gate_r0') || f === '06_gate_r0.txt'),
    hasTests:  files.some(f => f.includes('test') || f === '05_tests.txt'),
    hasDesign: files.some(f => f.includes('design') || f === '01_design.md'),
  };
}

/** Recursively find all EVD directories under opsDir (non-recursive: just 2 levels). */
function findEvds(opsDir: string): string[] {
  const evds: string[] = [];
  if (!existsSync(opsDir)) return evds;

  let phases: string[] = [];
  try { phases = readdirSync(opsDir); } catch { return evds; }

  for (const phase of phases) {
    const phaseDir = join(opsDir, phase);
    let stat;
    try { stat = statSync(phaseDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (phase === 'patterns') continue; // skip pattern log dir

    // Each subdir of the phase is an EVD
    let evdNames: string[] = [];
    try { evdNames = readdirSync(phaseDir); } catch { continue; }

    for (const evdName of evdNames) {
      const evdPath = join(phaseDir, evdName);
      let evdStat;
      try { evdStat = statSync(evdPath); } catch { continue; }
      if (!evdStat.isDirectory()) continue;
      // Must look like an EVD (has at least one file or is named with timestamp)
      evds.push(evdPath);
    }
  }

  return evds;
}

/** Build and return the evidence index without writing to disk. */
export function buildIndex(repoRoot: string): EvidenceIndex {
  const opsDir = join(repoRoot, OPS_DIR_NAME);
  const evdPaths = findEvds(opsDir);
  const evds = evdPaths.map(p => scanEvd(p, repoRoot));

  // Sort by path for deterministic output
  evds.sort((a, b) => a.path.localeCompare(b.path));

  return {
    generatedAt: new Date().toISOString(),
    totalEvds: evds.length,
    evds,
  };
}

/** Build index and write it to docs/_ops/INDEX.json. */
export function runIndexer(repoRoot: string = process.cwd()): EvidenceIndex {
  const index = buildIndex(repoRoot);
  const outPath = join(repoRoot, OPS_DIR_NAME, INDEX_FILE_NAME);
  writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf8');
  return index;
}
