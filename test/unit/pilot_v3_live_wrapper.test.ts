/**
 * PILOTO_V3 — live wrapper (run_live_pv3.sh) with a stub runner: a phase that may have paid (the ledger gained a
 * reservation) is never run again, whatever its exit code; a phase that reserved nothing may be retried; an
 * interrupted phase, open/uncertain exposure, an unreadable ledger or marker and bad arguments block before
 * anything runs; the test hooks need the explicit test mode and a stub key. Nothing is called.
 *
 * Module under test: the shell wrapper `scripts/pilot/anthropic/run_live_pv3.sh`, driven with the stub runner
 * `test/unit/fixtures/pilot_v3_stub_runner.ts` instead of the real pilot runner.
 *
 * Strategy / partitions: bad phase or no credential; provider selection (each provider's own key variable,
 * unknown provider); phases already finished are skipped; a failure after a reservation stops the run, a
 * failure without one may be retried; an interrupted phase with and without a new reservation; ledger parsing
 * (spaced JSON, CRLF, unreadable ledger or marker); test hooks outside test mode; open or uncertain exposure.
 *
 * Needs: `bash` on the PATH. Each case runs in a temporary directory with a stub key and with every
 * `OTK_*`, `*_API_KEY` and `PV3_*` variable removed from the child environment; no provider is called.
 *
 * Run just this file: `npx tsx --test test/unit/pilot_v3_live_wrapper.test.ts`
 *
 * @module test/unit/pilot_v3_live_wrapper.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fwd = (p: string) => p.replace(/\\/g, '/');
const STUB = fwd(path.resolve('test/unit/fixtures/pilot_v3_stub_runner.ts'));

function sandbox() {
  const dir = fwd(mkdtempSync(path.join(tmpdir(), 'pv3-wrap-')));
  const s = { root: `${dir}/live`, ledger: `${dir}/ledger.jsonl`, log: `${dir}/stub.log` };
  const run = (phases: string[], env: Record<string, string> = {}, key = true, provider?: string) => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(base)) if (/^OTK_|_API_KEY$|^PV3_/.test(k)) delete base[k];
    const r = spawnSync('bash', ['scripts/pilot/anthropic/run_live_pv3.sh', ...(provider ? [`--provider=${provider}`] : []), ...phases], { encoding: 'utf8', timeout: 120_000, env: { ...base,
      OTK_PV3_TEST_HOOKS: '1', OTK_PV3_LIVE_ROOT: s.root, OTK_PV3_RUNNER: STUB, OTK_PILOT_LEDGER: s.ledger, PV3_STUB_LOG: s.log,
      ...(key ? { [provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'gemini' || provider === 'gemini35' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY']: 'stub-not-a-key' } : {}), ...env } });
    return { status: r.status, err: r.stderr };
  };
  const calls = () => (existsSync(s.log) ? readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { ...s, run, calls };
}

describe('PILOTO_V3 live wrapper', () => {
  it('bad phase or no credential: nothing runs', () => {
    const s = sandbox();
    assert.equal(s.run(['minimal', 'bogus']).status, 4);
    assert.equal(s.run(['minimal'], {}, false).status, 3);
    assert.deepEqual(s.calls(), []);
  });

  it('provider selection: openai uses its own key variable; an unknown provider runs nothing', () => {
    const s = sandbox();
    // FECHAMENTO_GEMINI_AD: gemini became a known provider (its own test below); mistral stays unknown
    assert.equal(s.run(['minimal'], {}, true, 'mistral').status, 4);
    assert.equal(s.run(['minimal'], {}, false, 'openai').status, 3);
    assert.equal(s.run(['minimal'], { OPENAI_API_KEY: 'sk-proj-looks-real' }, true, 'openai').status, 4);
    assert.equal(s.run(['minimal'], {}, true, 'openai').status, 0);
    assert.deepEqual(s.calls(), ['minimal']);
  });

  it('provider gemini: own key variable (GEMINI_API_KEY), a non-stub key refused in test mode, the key file is ignored in test mode', () => {
    const s = sandbox();
    assert.equal(s.run(['minimal'], {}, false, 'gemini').status, 3);
    assert.equal(s.run(['minimal'], { GEMINI_API_KEY: 'AIza-looks-real' }, true, 'gemini').status, 4);
    const kf = `${path.dirname(s.ledger)}/key.txt`; writeFileSync(kf, 'stub-from-file\n');
    assert.equal(s.run(['minimal'], { OTK_PV3_KEY_FILE: kf }, false, 'gemini').status, 3, 'never read in test mode');
    assert.equal(s.run(['minimal'], {}, true, 'gemini').status, 0);
    assert.deepEqual(s.calls(), ['minimal']);
    // gemini35 (author decision 2026-10-04): same key variable (test mode uses one root per sandbox, so a fresh one)
    const s2 = sandbox();
    assert.equal(s2.run(['minimal'], {}, false, 'gemini35').status, 3);
    assert.equal(s2.run(['minimal'], {}, true, 'gemini35').status, 0);
    assert.deepEqual(s2.calls(), ['minimal']);
  });

  it('phases that ended with exit 0 are never run again', () => {
    const s = sandbox();
    assert.equal(s.run(['minimal', 'stream']).status, 0);
    assert.ok(existsSync(`${s.root}/minimal.done`) && existsSync(`${s.root}/stream.done`));
    assert.equal(s.run(['minimal', 'stream']).status, 0);
    assert.deepEqual(s.calls(), ['minimal', 'stream']);
  });

  it('a failure after a ledger reservation writes STOP, even with an exit code that looks pre-paid', () => {
    for (const code of ['1', '2', '3', '5']) {
      const s = sandbox();
      assert.equal(s.run(['minimal'], { PV3_STUB_MINIMAL: `paid:${code}` }).status, 1, `paid:${code}`);
      assert.ok(existsSync(`${s.root}/STOP`), `paid:${code}`);
      assert.equal(s.run(['minimal', 'stream']).status, 1);
      assert.deepEqual(s.calls(), ['minimal'], `paid:${code}`);
    }
  });

  it('a failure without any reservation may be retried', () => {
    const s = sandbox();
    assert.equal(s.run(['minimal'], { PV3_STUB_MINIMAL: 'nopaid:5' }).status, 5);
    assert.ok(!existsSync(`${s.root}/STOP`) && !existsSync(`${s.root}/minimal.started`));
    assert.equal(s.run(['minimal']).status, 0);
    assert.deepEqual(s.calls(), ['minimal', 'minimal']);
  });

  it('an interrupted phase blocks when the ledger gained a reservation since it started', () => {
    const s = sandbox();
    mkdirSync(s.root, { recursive: true });
    writeFileSync(`${s.root}/minimal.started`, '0\n');
    writeFileSync(s.ledger, `${JSON.stringify({ type: 'reserve', id: 'x', reservedUsd: 0.4 })}\n`);
    assert.equal(s.run(['minimal']).status, 1);
    assert.ok(existsSync(`${s.root}/STOP`));
    assert.deepEqual(s.calls(), []);
  });

  it('an interrupted phase with no new reservation runs normally', () => {
    const s = sandbox();
    mkdirSync(s.root, { recursive: true });
    writeFileSync(`${s.root}/minimal.started`, '0\n');
    assert.equal(s.run(['minimal']).status, 0);
    assert.deepEqual(s.calls(), ['minimal']);
  });

  it('the ledger is counted by parsing: spaced JSON and CRLF still block; an unreadable ledger or marker is STOP', () => {
    const spaced = sandbox();
    writeFileSync(spaced.ledger, '{ "type": "reserve", "id": "a", "reservedUsd": 0.4 }\r\n');
    assert.equal(spaced.run(['minimal']).status, 1, 'open reservation in a spaced CRLF ledger blocks');
    assert.deepEqual(spaced.calls(), []);
    const corrupt = sandbox();
    writeFileSync(corrupt.ledger, '{"type":"reserve","id":"a"\n');
    assert.equal(corrupt.run(['minimal']).status, 1);
    assert.ok(existsSync(`${corrupt.root}/STOP`));
    assert.deepEqual(corrupt.calls(), []);
    const marker = sandbox();
    mkdirSync(marker.root, { recursive: true });
    writeFileSync(`${marker.root}/minimal.started`, 'garbage');
    assert.equal(marker.run(['minimal']).status, 1);
    assert.ok(existsSync(`${marker.root}/STOP`));
    assert.deepEqual(marker.calls(), []);
  });

  it('test hooks need test mode and a stub key; a stray PV3_LOCK_HELD outside test mode is refused', () => {
    const s = sandbox();
    assert.equal(s.run(['minimal'], { ANTHROPIC_API_KEY: 'sk-ant-looks-real' }).status, 4);
    assert.equal(s.run(['minimal'], { OTK_PV3_TEST_HOOKS: '0', PV3_LOCK_HELD: '1' }).status, 1);
    assert.deepEqual(s.calls(), []);
    assert.ok(!existsSync(s.root));
  });

  it('open or uncertain exposure in the ledger blocks until the author acknowledges its exact count', () => {
    const s = sandbox();
    writeFileSync(s.ledger, [{ type: 'reserve', id: 'a', reservedUsd: 0.4 }, { type: 'settle', id: 'a', outcome: 'uncertain' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.equal(s.run(['minimal']).status, 1);
    assert.ok(!existsSync(`${s.root}/STOP`));
    assert.equal(s.run(['minimal'], { OTK_PV3_ACK_EXPOSURE: '2' }).status, 1);
    assert.deepEqual(s.calls(), []);
    assert.equal(s.run(['minimal'], { OTK_PV3_ACK_EXPOSURE: '1' }).status, 0);
    assert.deepEqual(s.calls(), ['minimal']);
  });
});
