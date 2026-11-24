/**
 * PILOTO_V3 — guards of the v3 Anthropic runner that need no service: nothing is called and nothing is
 * created when the credential, the arguments or the database are missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUNNER = 'scripts/pilot/anthropic/runPilotV3.ts';
function run(args: string[], env: Record<string, string | undefined>) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (/^OTK_|_API_KEY$/.test(k)) delete base[k];
  return spawnSync(process.execPath, ['--import', 'tsx', RUNNER, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('PILOTO_V3 runner guards', () => {
  it('live without ANTHROPIC_API_KEY: exit 3, no call, no output, canonical ledger untouched', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-'));
    const ledger = path.join(out, 'never-created-ledger.jsonl');
    const r = run(['--mode=live', '--phase=minimal', `--out=${path.join(out, 'run')}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none', OTK_PILOT_LEDGER: ledger });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /credential_missing/);
    assert.equal(existsSync(ledger), false);
    assert.equal(existsSync(path.join(out, 'run')), false);
  });

  it('bad arguments: exit 4; gate is synthetic only; besu needs a network directory', () => {
    assert.equal(run(['--mode=live'], {}).status, 4);
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-'));
    assert.equal(run(['--mode=synthetic', '--phase=besu', `--out=${out}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none' }).status, 4);
    assert.equal(run(['--mode=live', '--phase=gate', `--out=${out}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none', ANTHROPIC_API_KEY: 'sk-ant-guard-canary-not-a-key' }).status, 4);
    assert.deepEqual(readdirSync(out), []);
  });

  it('live with a non-canonical ledger path: exit 4 before any call (outside the wrapper test mode)', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-'));
    const r = run(['--mode=live', '--phase=minimal', `--out=${path.join(out, 'run')}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none', ANTHROPIC_API_KEY: 'sk-ant-guard-canary-not-a-key', OTK_PILOT_LEDGER: path.join(out, 'other.jsonl') });
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /canonical ledger/);
    assert.equal(existsSync(path.join(out, 'other.jsonl')), false);
    assert.equal(existsSync(path.join(out, 'run')), false);
  });

  it('openai profile: live without OPENAI_API_KEY is exit 3; an unknown provider is exit 4', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-'));
    const r = run(['--provider=openai', '--mode=live', '--phase=minimal', `--out=${path.join(out, 'run')}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none', ANTHROPIC_API_KEY: 'sk-ant-guard-canary-not-a-key' });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /OPENAI_API_KEY/);
    // FECHAMENTO_GEMINI_AD: gemini became a known profile (guard below); mistral stays unknown
    assert.equal(run(['--provider=mistral', '--mode=synthetic', '--phase=minimal', `--out=${out}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none' }).status, 4);
    assert.equal(existsSync(path.join(out, 'run')), false);
  });

  it('gemini profile: live without GEMINI_API_KEY is exit 3 (keys of other providers do not count); nothing created', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-gem-'));
    const r = run(['--provider=gemini', '--mode=live', '--phase=minimal', `--out=${path.join(out, 'run')}`], { OTK_PILOT_PG_URL: 'postgres://u:p@127.0.0.1:1/none', OPENAI_API_KEY: 'sk-guard-canary-not-a-key', ANTHROPIC_API_KEY: 'sk-ant-guard-canary-not-a-key' });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /GEMINI_API_KEY/);
    assert.equal(existsSync(path.join(out, 'run')), false);
  });

  it('no isolated database configured: exit 5 before anything else', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-guard-'));
    assert.equal(run(['--mode=synthetic', '--phase=minimal', `--out=${out}`], {}).status, 5);
  });
});
