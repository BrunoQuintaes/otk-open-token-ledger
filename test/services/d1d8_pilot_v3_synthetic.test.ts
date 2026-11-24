/**
 * PILOTO_V3 — synthetic gate of the v3 Anthropic runner through the REAL entrypoint (durable D1–D8 profile):
 * simple, streaming, deliberate client disconnect, no final usage, a small sample and a restart, each checked
 * by the runner's independent oracles. A canary ANTHROPIC_API_KEY sits in the parent environment: it must not
 * reach the child's environment or any request the provider received (both measured by the runner), nor any
 * output; every call must land on the local loopback provider; the run-local ledger is settled only from
 * provider-reported usage; and the canonical cumulative ledger must not be created.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 --test-timeout=600000 test/services/d1d8_pilot_v3_synthetic.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireEnv } from './d1d8_c_env.js';

describe('PILOTO_V3 — synthetic gate through the durable path', () => {
  it('8 planned cases consistent, restart without duplicates, no paid-API path, canary key never leaks', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-gate-'));
    const ledger = path.join(out, 'canonical-must-not-exist.jsonl');
    const canary = `sk-ant-canary-${Date.now()}-must-never-appear`;
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PILOT_PG_URL: requireEnv('OTK_TEST_PG_URL'), OTK_PILOT_LEDGER: ledger, ANTHROPIC_API_KEY: canary };
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pilot/anthropic/runPilotV3.ts', '--mode=synthetic', '--phase=gate', `--out=${out}`], { env, encoding: 'utf8', timeout: 540_000 });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-3000));
    const files = readdirSync(out);
    const read = (suffix: string) => readFileSync(path.join(out, files.find((f) => f.endsWith(suffix))!), 'utf8');
    const summary = JSON.parse(read('_summary.json')) as { calls: number; planned: number; consistent: number };
    assert.deepEqual([summary.calls, summary.planned, summary.consistent], [8, 8, 8]);
    const calls = read('_calls.jsonl').trim().split('\n').map((l) => JSON.parse(l) as { label: string; consistent: boolean; otk: { delivery: string; moneyState: string };
      ledgerReservation: { settlement: string; settlementSource: string } });
    assert.equal(calls.find((c) => c.label === 'disconnect')!.otk.delivery, 'client_disconnected');
    assert.equal(calls.find((c) => c.label === 'nousage')!.otk.moneyState, 'held_uncertain');
    // canonical-ledger settlement only from provider-reported usage; the cut stream keeps its reservation
    for (const c of calls) {
      const expected = c.label === 'nousage' ? ['uncertain', 'none'] : ['ok', c.label === 'disconnect' ? 'otk_final_measurement' : 'provider_response'];
      assert.deepEqual([c.ledgerReservation.settlement, c.ledgerReservation.settlementSource], expected, c.label);
    }
    const restart = JSON.parse(read('_restart.json')) as { ok: boolean };
    assert.equal(restart.ok, true);
    const manifest = JSON.parse(read('_manifest.json')) as { upstream: { url: string; realKeyInChildEnv: boolean; realKeySeenByProvider: boolean }; syntheticProviderCalls: number; ledger: { file: string } };
    assert.match(manifest.upstream.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(manifest.upstream.realKeyInChildEnv, false, 'measured on the child environment');
    assert.equal(manifest.upstream.realKeySeenByProvider, false, 'measured on every request the provider received');
    assert.equal(manifest.syntheticProviderCalls, 8, 'every call landed on the loopback provider');
    assert.match(manifest.ledger.file, /synthetic/);
    assert.equal(existsSync(ledger), false, 'the canonical cumulative ledger is never touched by a synthetic run');
    for (const f of files) {
      const p = path.join(out, f);
      if (f.startsWith('spool-')) continue;
      assert.ok(!readFileSync(p, 'utf8').includes(canary), `canary key leaked into ${f}`);
    }
    assert.ok(!(r.stdout + r.stderr).includes(canary));
  });

  it('openai profile (gpt-4o-mini, policy v3): 8 cases consistent incl. cached prompt tokens, restart clean, canary never leaks', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-oa-gate-'));
    const canary = `sk-proj-canary-${Date.now()}-must-never-appear`;
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PILOT_PG_URL: requireEnv('OTK_TEST_PG_URL'), OPENAI_API_KEY: canary };
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pilot/anthropic/runPilotV3.ts', '--provider=openai', '--mode=synthetic', '--phase=gate', `--out=${out}`], { env, encoding: 'utf8', timeout: 540_000 });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-3000));
    const files = readdirSync(out);
    const read = (suffix: string) => readFileSync(path.join(out, files.find((f) => f.endsWith(suffix))!), 'utf8');
    const summary = JSON.parse(read('_summary.json')) as { calls: number; planned: number; consistent: number };
    assert.deepEqual([summary.calls, summary.planned, summary.consistent], [8, 8, 8]);
    const calls = read('_calls.jsonl').trim().split('\n').map((l) => JSON.parse(l) as { label: string; otk: { moneyState: string }; oracle: { costPico: string } | null;
      ledgerReservation: { settlement: string; settlementSource: string; costUsd: number | null }; checks: Record<string, { ok: boolean; observed: unknown }> });
    for (const c of calls) {
      const expected = c.label === 'nousage' ? ['uncertain', 'none'] : ['ok', c.label === 'disconnect' ? 'otk_final_measurement' : 'provider_response'];
      assert.deepEqual([c.ledgerReservation.settlement, c.ledgerReservation.settlementSource], expected, c.label);
      if (c.label !== 'nousage') assert.equal(c.checks['policy_strict']!.observed, 'otk.money_bound_policy.v3@2026-10-03');
    }
    // 1500 prompt tokens of which 1024 cached, 40 output: 476 × 0.15 + 1024 × 0.075 + 40 × 0.60 µUSD
    const cached = calls.find((c) => c.label === 'sample-medio-stream')!;
    assert.equal(cached.oracle!.costPico, String(476n * 150_000n + 1024n * 75_000n + 40n * 600_000n));
    assert.ok(Math.abs(cached.ledgerReservation.costUsd! - 0.0001722) < 1e-12);
    const manifest = JSON.parse(read('_manifest.json')) as { provider: string; upstream: { realKeyInChildEnv: boolean; realKeySeenByProvider: boolean }; syntheticProviderCalls: number };
    assert.deepEqual([manifest.provider, manifest.upstream.realKeyInChildEnv, manifest.upstream.realKeySeenByProvider, manifest.syntheticProviderCalls], ['openai', false, false, 8]);
    assert.equal((JSON.parse(read('_restart.json')) as { ok: boolean }).ok, true);
    for (const f of files) if (!f.startsWith('spool-')) assert.ok(!readFileSync(path.join(out, f), 'utf8').includes(canary), f);
    assert.ok(!(r.stdout + r.stderr).includes(canary));
  });

  it('positive control (openai): a response processed by a non-Standard service tier fails the run', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-oa-tier-'));
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PILOT_PG_URL: requireEnv('OTK_TEST_PG_URL'), PV3_SYNTH_OPENAI_TIER: 'priority' };
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pilot/anthropic/runPilotV3.ts', '--provider=openai', '--mode=synthetic', '--phase=minimal', `--out=${out}`], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 1, (r.stdout + r.stderr).slice(-2000));
    const calls = readFileSync(path.join(out, readdirSync(out).find((f) => f.endsWith('_calls.jsonl'))!), 'utf8');
    const c = JSON.parse(calls.trim()) as { consistent: boolean; checks: Record<string, { ok: boolean; observed: unknown }> };
    // FECHAMENTO_GEMINI_AD: the tier is checked as seen by the client AND as persisted by the server (product)
    assert.deepEqual([c.consistent, c.checks['service_tier_standard_client']!.ok, c.checks['service_tier_standard_client']!.observed], [false, false, 'priority']);
    assert.deepEqual([c.checks['service_tier_standard_server']!.ok, c.checks['service_tier_standard_server']!.observed], [false, 'priority']);
  });

  it('positive control: the real key reaching the child environment is detected and the run fails', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pv3-leak-'));
    const canary = `sk-ant-canary-${Date.now()}-leak-probe`;
    // a variable whose name the runner does not filter carries the key into the child's environment
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PILOT_PG_URL: requireEnv('OTK_TEST_PG_URL'), ANTHROPIC_API_KEY: canary, PV3_LEAK_PROBE: canary };
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pilot/anthropic/runPilotV3.ts', '--mode=synthetic', '--phase=minimal', `--out=${out}`], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 1, (r.stdout + r.stderr).slice(-2000));
    assert.match(r.stderr, /real key would reach the child/);
    assert.ok(!readdirSync(out).some((f) => f.endsWith('_calls.jsonl')), 'no call was made');
  });
});
