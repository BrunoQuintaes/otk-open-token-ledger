#!/usr/bin/env node
/**
 * generate_manifest.js — Canonical JSON manifest per commit (A6.6 + A11.1 + A11.3)
 *
 * Generates a JSON manifest capturing the current repository state:
 *   - commitHash, branch, timestamp
 *   - testCount (from last npm test run or current run)
 *   - phaseStatuses (parsed from CANONICAL_ROADMAP_TABLE.csv)
 *   - touchedFiles (git diff --name-only HEAD~1)
 *
 * A11.3 (manifest archival) is absorbed into this script:
 *   - Output written to docs/_ops/manifests/MANIFEST_<commitHash>.json
 *   - Also writes docs/_ops/manifests/MANIFEST_LATEST.json (symlink-free)
 *
 * Usage: node scripts/ops/generate_manifest.js
 *
 * @since A6.6 + A11.1 + A11.3 — Wave 1 Pack 12
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const MANIFESTS_DIR = path.join(ROOT, 'docs/_ops/manifests');
const ROADMAP_CSV = path.join(ROOT, 'docs/CANONICAL_ROADMAP_TABLE.csv');

// ─── Helpers ───────────────────────────────────────────────────────────

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getCommitHash() {
  return run('git rev-parse --short HEAD') || 'unknown';
}

function getFullCommitHash() {
  return run('git rev-parse HEAD') || 'unknown';
}

function getBranch() {
  return run('git rev-parse --abbrev-ref HEAD') || 'unknown';
}

function getTouchedFiles() {
  const raw = run('git diff --name-only HEAD~1');
  return raw ? raw.split('\n').filter(Boolean) : [];
}

function getTestCount() {
  // Try to read from the last Gate R0 evidence or estimate from package.json test script
  const gateFiles = [];
  try {
    const revalDir = path.join(ROOT, 'docs/_ops/revalidation');
    if (fs.existsSync(revalDir)) {
      const dirs = fs.readdirSync(revalDir)
        .filter(d => d.startsWith('REVALIDATION_'))
        .sort()
        .reverse();
      for (const d of dirs) {
        const testFile = path.join(revalDir, d, '05_tests.txt');
        if (fs.existsSync(testFile)) {
          gateFiles.push(testFile);
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Parse test count from evidence file if available
  for (const f of gateFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const match = content.match(/(\d+)\s+tests?\s+pass/i) ||
                    content.match(/pass\s+(\d+)/i) ||
                    content.match(/(\d+)\s+pass/i);
      if (match) return parseInt(match[1], 10);
    } catch { /* ignore */ }
  }

  return null; // unknown
}

function parsePhaseStatuses() {
  if (!fs.existsSync(ROADMAP_CSV)) return {};

  const content = fs.readFileSync(ROADMAP_CSV, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  if (lines.length < 2) return {};

  // Find header indices
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const phaseIdx = header.indexOf('Phase');
  const statusIdx = header.indexOf('Status');
  const nameIdx = header.indexOf('Name');

  if (phaseIdx === -1 || statusIdx === -1) return {};

  const statuses = {};
  const seenPhases = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const phase = cols[phaseIdx];
    const status = cols[statusIdx];
    if (phase && !seenPhases.has(phase)) {
      seenPhases.add(phase);
      statuses[phase] = status || 'UNKNOWN';
    }
  }

  return statuses;
}

// ─── Main ──────────────────────────────────────────────────────────────

function generateManifest() {
  const commitHash = getCommitHash();
  const fullHash = getFullCommitHash();
  const branch = getBranch();
  const timestamp = new Date().toISOString();
  const touchedFiles = getTouchedFiles();
  const testCount = getTestCount();
  const phaseStatuses = parsePhaseStatuses();

  const manifest = {
    schemaVersion: '1.0.0',
    commitHash,
    fullCommitHash: fullHash,
    branch,
    timestamp,
    testCount,
    touchedFiles,
    touchedFileCount: touchedFiles.length,
    phaseStatuses,
    generator: 'scripts/ops/generate_manifest.js',
  };

  // Ensure output directory exists
  fs.mkdirSync(MANIFESTS_DIR, { recursive: true });

  // Write per-commit manifest (A6.6 + A11.1)
  const manifestPath = path.join(MANIFESTS_DIR, `MANIFEST_${commitHash}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Write latest manifest (A11.3 — archival pointer, symlink-free)
  const latestPath = path.join(MANIFESTS_DIR, 'MANIFEST_LATEST.json');
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Manifest generated: ${manifestPath}`);
  console.log(`Latest pointer:     ${latestPath}`);
  console.log(`  commit:  ${commitHash}`);
  console.log(`  branch:  ${branch}`);
  console.log(`  touched: ${touchedFiles.length} files`);
  console.log(`  tests:   ${testCount ?? 'unknown'}`);
  console.log(`  phases:  ${Object.keys(phaseStatuses).length} tracked`);

  return manifest;
}

// Export for programmatic use
export { generateManifest, getCommitHash, getBranch, getTouchedFiles, getTestCount, parsePhaseStatuses };

// Run if invoked directly
const isMain = process.argv[1] &&
  (process.argv[1].endsWith('generate_manifest.js') ||
   process.argv[1] === fileURLToPath(import.meta.url));

if (isMain) {
  generateManifest();
}
