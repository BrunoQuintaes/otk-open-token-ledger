/**
 * RB-01 (RUN-M1-RESUME-20261012): tools/academic_demo/run_demo.sh must end with exit 0 only when DEMO_SUMMARY says ok
 * and its own cleanup succeeded. Before this fix the summary was written through a pipe to `tee` (exit status of tee)
 * and the cleanup always logged "cleanup done": a demo with 8 of 9 consistent operations, or whose containers could not
 * be removed, still ended "DEMO DONE" with exit 0. The script runs in a fake repository root with fake docker/npx and
 * a node wrapper that fakes only the heavy steps (Besu generation/readiness, e2e, receipt check, test runners).
 * The version of a919934 (before) is exercised too, to show the defect.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const fwd = (p: string) => p.replace(/\\/g, '/');
const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeRoot(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-demo-')); dirs.push(dir);
  const root = path.join(dir, 'repo');
  for (const d of ['tools/academic_demo', 'node_modules', 'tools/hardhat/node_modules', 'zk/circuits/circomlib/circuits', 'infra/test']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/academic_demo/run_demo.sh'), script);
  fs.writeFileSync(path.join(root, 'zk/circuits/circomlib/circuits/poseidon.circom'), '// fake\n');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const realNode = fwd(process.execPath);
  const D = fwd(dir);
  const w = (n: string, body: string) => fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\nD='${D}'\n${body}`, { mode: 0o755 });
  w('docker', `echo "$*" >> "$D/docker.log"
case " $* " in *" version "*) echo 29.0.0; exit 0 ;; esac
[ "$1" = network ] && exit 0
case " $* " in *" down "*) [ "\${FAKE_DOWN_FAIL:-0}" = 1 ] && { echo "fake: down refused"; exit 1; } ;; esac
[ "$1" = ps ] || [ "$1" = volume ] && exit 0
exit 0\n`);
  w('npx', 'exit 0\n');
  w('npm', 'echo 10.9.0; exit 0\n');
  w('node', `arg() { local k="$1" a; shift; for a in "$@"; do case "$a" in --$k=*) echo "\${a#--$k=}";; esac; done; }
case "$*" in
  *s4_gen_besu7.mjs*) out=""; prev=""; for a in "$@"; do [ "$prev" = --out ] && out="$a"; prev="$a"; done
    mkdir -p "$out/dev"; echo "services: {}" > "$out/docker-compose.yml"; echo '{"dev":{"operator":"0x00000000000000000000000000000000000000aa"}}' > "$out/network.json"; echo 11 > "$out/dev/deployer.key"; exit 0 ;;
  *wait_ready.mjs*) out=""; prev=""; for a in "$@"; do [ "$prev" = --out ] && out="$a"; prev="$a"; done
    [ "\${FAKE_BESU:-}" = notready ] && { echo '{"status":"TIMEOUT"}' > "$out"; exit 1; }; echo '{"status":"READY"}' > "$out"; exit 0 ;;
  *runPilotV3.ts*) o=$(arg out "$@"); mkdir -p "$o"; echo '{}' > "$o/x_manifest.json"
    echo "{\\"calls\\":9,\\"consistent\\":\${FAKE_CONSISTENT:-9}}" > "$o/x_summary.json"; exit 0 ;;
  *verify_demo_receipt.mts*) o=$(arg out "$@"); echo '{"ok":true,"checks":{"a":true},"cuReference":{"exact":"1/25"}}' > "$o"; exit 0 ;;
  *"--test"*) echo "# tests 1"; echo "# pass 1"; echo "# fail 0"; exit 0 ;;
esac
exec "${realNode}" "$@"\n`);
  return { dir, root, bin };
}
function run(script: string, env: Record<string, string> = {}) {
  const f = fakeRoot(script);
  const keep: Record<string, string> = {};
  for (const k of ['SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'WINDIR', 'PATHEXT']) if (process.env[k]) keep[k] = process.env[k] as string;
  const out = path.join(f.dir, 'report'); const net = path.join(f.dir, 'net');
  const r = spawnSync('bash', [path.join(f.root, 'tools/academic_demo/run_demo.sh')], { cwd: f.root, encoding: 'utf-8', timeout: 180_000,
    env: { ...keep, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, DEMO_OUT: fwd(out), DEMO_BESU_DIR: fwd(net), ...env } });
  const steps = fs.existsSync(path.join(out, 'STEPS.txt')) ? fs.readFileSync(path.join(out, 'STEPS.txt'), 'utf-8') : '';
  const docker = fs.existsSync(path.join(f.dir, 'docker.log')) ? fs.readFileSync(path.join(f.dir, 'docker.log'), 'utf-8') : '';
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), steps, docker, net };
}
const NOW = fs.readFileSync(path.join(ROOT, 'tools/academic_demo/run_demo.sh'), 'utf-8');
const before = spawnSync('git', ['show', 'a919934:tools/academic_demo/run_demo.sh'], { cwd: ROOT, encoding: 'utf-8' });
const BEFORE = before.status === 0 ? before.stdout : null;

describe('RB-01 run_demo.sh: exit 0 only for an ok summary and a clean environment', { skip: !hasBash && 'bash not available' }, () => {
  it('baseline: 9/9 consistent, cleanup ok → exit 0, DEMO DONE, both projects brought down', () => {
    const r = run(NOW);
    assert.equal(r.status, 0, r.out + r.steps);
    assert.match(r.steps, /DEMO DONE/);
    assert.match(r.docker, /compose -p otk-demo-besu7 .*down -v/); assert.match(r.docker, /compose -p otk-demo-svc .*down -v/);
  });
  it('H1-S12: cleanup deletes the private keys of the demo network, keeps network.json; DEMO_KEEP_KEYS=1 keeps them', () => {
    const r = run(NOW);
    assert.equal(r.status, 0, r.out + r.steps);
    assert.ok(!fs.existsSync(path.join(r.net, 'dev', 'deployer.key')), 'deployer key deleted');
    assert.ok(fs.existsSync(path.join(r.net, 'network.json')), 'addresses kept as evidence');
    const k = run(NOW, { DEMO_KEEP_KEYS: '1' });
    assert.equal(k.status, 0, k.out + k.steps);
    assert.ok(fs.existsSync(path.join(k.net, 'dev', 'deployer.key')));
    assert.match(k.steps, /DEMO_KEEP_KEYS=1/);
  });
  it('8/9 consistent → summary ok:false → exit 1, no DEMO DONE', () => {
    const r = run(NOW, { FAKE_CONSISTENT: '8' });
    assert.equal(r.status, 1, r.out + r.steps);
    assert.doesNotMatch(r.steps, /DEMO DONE/); assert.match(r.steps, /STOP: DEMO_SUMMARY not ok/);
    assert.match(r.steps, /"ok": false/, 'the summary was written and says ok:false (failure for the right reason)');
  });
  it('cleanup refused by docker → exit 1, CLEANUP FAILED logged, no DEMO DONE', () => {
    const r = run(NOW, { FAKE_DOWN_FAIL: '1' });
    assert.equal(r.status, 1, r.out + r.steps);
    assert.match(r.steps, /CLEANUP FAILED/); assert.doesNotMatch(r.steps, /DEMO DONE/);
  });
  it('Besu never ready → exit 1 and the environment is brought down', () => {
    const r = run(NOW, { FAKE_BESU: 'notready' });
    assert.equal(r.status, 1, r.out + r.steps);
    assert.match(r.steps, /STOP: Besu not ready/); assert.match(r.docker, /down -v/);
  });
  it('custom project names are honoured (the runner passes otk-rb-<id>-*)', () => {
    const r = run(NOW, { DEMO_SVC_PROJECT: 'otk-rb-x-demo-svc', DEMO_BESU_PROJECT: 'otk-rb-x-besu7' });
    assert.equal(r.status, 0, r.out + r.steps);
    assert.doesNotMatch(r.docker, /-p otk-demo-/);
  });
  it('before the fix (a919934): the same two defects end with exit 0 and DEMO DONE', { skip: !BEFORE && 'a919934 not in this repository (package without git history)' }, () => {
    const inconsistent = run(BEFORE as string, { FAKE_CONSISTENT: '8' });
    assert.equal(inconsistent.status, 0); assert.match(inconsistent.steps, /DEMO DONE/); assert.match(inconsistent.steps, /"ok": false/);
    const dirty = run(BEFORE as string, { FAKE_DOWN_FAIL: '1' });
    assert.equal(dirty.status, 0); assert.match(dirty.steps, /cleanup done/); assert.match(dirty.steps, /DEMO DONE/);
  });
});

describe('H1R2: fixed host ports are quiet before Docker binds them (ephemeral-range collision seen in the R2 runbook)', () => {
  const RUNNER = fs.readFileSync(path.join(ROOT, 'tools/academic_demo/run_from_package.sh'), 'utf-8');
  it('run_demo.sh waits for PG, Redis and RPC ports before the services come up', () => {
    const i = NOW.indexOf('port_quiet $PGP $RDP $RPC'); const j = NOW.indexOf('need 03_services_up');
    assert.ok(i > 0 && i < j, 'port_quiet before 03_services_up');
    assert.match(NOW, /port_quiet\(\) \{[\s\S]*\/proc\/net\/tcp[\s\S]*seq 1 120/);
  });
  it('run_from_package.sh waits for the R07f service ports before compose up', () => {
    const i = RUNNER.indexOf('port_quiet "$PG_PORT" "$REDIS_PORT"'); const j = RUNNER.indexOf('docker compose -p "$SVC_PROJ" $cf up -d --wait');
    assert.ok(i > 0 && i < j);
  });
  it('port_quiet returns at once for a free port and is a no-op without /proc/net/tcp', { skip: !hasBash && 'bash not available' }, () => {
    const fn = NOW.slice(NOW.indexOf('port_quiet() {'), NOW.indexOf('\n}\n', NOW.indexOf('port_quiet() {')) + 3);
    const r = spawnSync('bash', ['-c', `${fn}\nport_quiet 1; echo rc=$?`], { encoding: 'utf-8', timeout: 10_000 });
    assert.match(r.stdout, /rc=0/);
  });
});
