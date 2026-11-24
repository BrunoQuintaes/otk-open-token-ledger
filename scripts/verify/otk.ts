#!/usr/bin/env node
/**
 * Comando `otk` do verificador offline de recibos (VERIFICADOR_MVP, C160).
 *
 *   otk verify <pasta|arquivo>... --keyring <chaveiro.json> [--fingerprint <sha256>] [--json] [--out <rel.json>]
 *              [--since AAAA-MM-DD] [--until AAAA-MM-DD]
 *   otk keyring export [--history <historico.json>] [--key <keyId>=<endereço>[,<estado>[,<retiredAt>]]]... [--operator <nome>] --out <chaveiro.json>
 *   otk keyring fingerprint <chaveiro.json>
 *   otk keyring convert <anel_do_bot.json> [--operator <nome>] --out <chaveiro.json>   (otk.bridge.keyring_file.v1 → otk.keyring.public.v1)
 *   otk receipts export --since AAAA-MM-DD --until AAAA-MM-DD --out <pasta> --pg-env <NOME> [--tenant <id>]
 *
 * Códigos de saída do verify: 0 tudo verde; 10 há amarelo; 20 há vermelho; 2 erro de uso.
 * receipts export: 0 ok, 1 falha ao ler o banco, 2 erro de uso.
 * verify e keyring: sem rede, sem variável de ambiente, sem chave privada (o chaveiro só tem endereços).
 * receipts export (lado do operador): lê a URL do PostgreSQL da variável cujo NOME vem em --pg-env,
 * como o reconcile.ts; o valor nunca é impresso nem gravado.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertBridgeKeyRingBytes, parsePublicKeyRing, renderHuman, reportSha256, serializePublicKeyRing, serializeReport,
  sha256Hex, verifyBundle, VerifierUsageError, type InputFile, type PublicKeyEntry,
} from '../../src/verifier/index.js';
import type { PgQueryable } from '../../src/operations/schema.js';
import { exportReceipts } from './receiptsExport.js';

const USO = `Uso:
  otk verify <pasta|arquivo>... --keyring <chaveiro.json> [--fingerprint <sha256>] [--json] [--out <relatorio.json>] [--since AAAA-MM-DD] [--until AAAA-MM-DD]
  otk keyring export [--history <historico.json>] [--key <keyId>=<endereco>[,<estado>[,<retiredAt>]]]... [--operator <nome>] --out <chaveiro.json>
  otk keyring fingerprint <chaveiro.json>
  otk keyring convert <anel_do_bot.json> [--operator <nome>] --out <chaveiro.json>
  otk receipts export --since AAAA-MM-DD --until AAAA-MM-DD --out <pasta> --pg-env <NOME_DA_VARIAVEL> [--tenant <id>]
Saida do verify: 0 tudo verde, 10 ha amarelo, 20 ha vermelho, 2 erro de uso.`;

/** Abre o banco pelo NOME da variável (padrão do reconcile.ts). Injetável nos testes. */
export interface CliDeps { openPool(envName: string): Promise<PgQueryable & { end(): Promise<void> }> }

const defaultDeps: CliDeps = {
  async openPool(envName) {
    const url = process.env[envName];
    if (!url) throw new UsageError(`a variável ${envName} está vazia ou não existe`);
    const { default: pg } = await import('pg');
    return new pg.Pool({ connectionString: url, max: 1 });
  },
};

class UsageError extends Error {}

export interface CliResult { code: number; stdout: string; stderr: string }

function parseArgs(argv: string[], flags: Set<string>, valued: Set<string>): { pos: string[]; opt: Map<string, string[]>; flag: Set<string> } {
  const pos: string[] = []; const opt = new Map<string, string[]>(); const flag = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [name, inline] = a.includes('=') && a.indexOf('=') > 2 ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      if (flags.has(name)) { flag.add(name); continue; }
      if (!valued.has(name)) throw new UsageError(`opção desconhecida: ${name}`);
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${name} precisa de um valor`);
      if (!opt.has(name)) opt.set(name, []);
      opt.get(name)!.push(v);
    } else pos.push(a);
  }
  return { pos, opt, flag };
}

function one(opt: Map<string, string[]>, name: string): string | null {
  const v = opt.get(name);
  if (!v) return null;
  if (v.length > 1) throw new UsageError(`${name} só pode aparecer uma vez`);
  return v[0]!;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const p = resolve(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (st.isFile()) out.push(p);
  }
}

/** Arquivos de entrada com o mesmo nome que o navegador daria (webkitRelativePath / file.name). */
export function collectInputs(paths: string[]): InputFile[] {
  const files: InputFile[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    let st;
    try { st = statSync(abs); } catch { throw new UsageError(`não encontrado: ${p}`); }
    if (st.isDirectory()) {
      const list: string[] = [];
      walk(abs, list);
      const base = dirname(abs);
      for (const f of list) files.push({ name: relative(base, f).split(sep).join('/'), bytes: new Uint8Array(readFileSync(f)) });
    } else {
      files.push({ name: basename(abs), bytes: new Uint8Array(readFileSync(abs)) });
    }
  }
  return files;
}

function cmdVerify(argv: string[], isTTY: boolean): CliResult {
  const { pos, opt, flag } = parseArgs(argv, new Set(['--json']), new Set(['--keyring', '--fingerprint', '--out', '--since', '--until']));
  if (pos.length === 0) throw new UsageError('informe ao menos uma pasta ou arquivo de recibos');
  const kr = one(opt, '--keyring');
  if (!kr) throw new UsageError('--keyring <chaveiro.json> é obrigatório (o chaveiro público do operador)');
  let krBytes: Uint8Array;
  try { krBytes = new Uint8Array(readFileSync(resolve(kr))); } catch { throw new UsageError(`chaveiro não encontrado: ${kr}`); }
  const inputs = collectInputs(pos);
  const report = verifyBundle(inputs, { name: basename(resolve(kr)), bytes: krBytes }, {
    fingerprint: one(opt, '--fingerprint'), since: one(opt, '--since'), until: one(opt, '--until'),
  });
  const json = serializeReport(report);
  const out = one(opt, '--out');
  let stderr = '';
  if (out) { writeFileSync(resolve(out), json, 'utf8'); stderr += `relatório gravado em ${out} (sha256 ${reportSha256(report)})\n`; }
  if (flag.has('--json')) return { code: report.exitCode, stdout: json, stderr };
  let human = renderHuman(report) + `sha256 do relatório JSON: ${reportSha256(report)}\n`;
  if (isTTY) {
    human = human.replace(/\[OK\]/g, '\x1b[32m[OK]\x1b[0m').replace(/\[ATENÇÃO\]/g, '\x1b[33m[ATENÇÃO]\x1b[0m').replace(/\[FALHOU\]/g, '\x1b[31m[FALHOU]\x1b[0m');
  }
  return { code: report.exitCode, stdout: human, stderr };
}

function parseKeySpec(s: string): PublicKeyEntry {
  const eq = s.indexOf('=');
  if (eq <= 0) throw new UsageError(`--key deve ser keyId=endereco[,estado[,retiredAt]]: ${s}`);
  const keyId = s.slice(0, eq);
  const [address, status = 'active', retiredAt] = s.slice(eq + 1).split(',');
  if (status !== 'active' && status !== 'retired' && status !== 'revoked') throw new UsageError(`estado inválido em --key ${keyId}: ${status}`);
  const e: PublicKeyEntry = { keyId, address: address ?? '', status };
  if (retiredAt !== undefined) e.retiredAt = retiredAt;
  return e;
}

function cmdKeyring(argv: string[]): CliResult {
  const sub = argv[0];
  if (sub === 'fingerprint') {
    const f = argv[1];
    if (!f || argv.length > 2) throw new UsageError('otk keyring fingerprint <chaveiro.json>');
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(resolve(f))); } catch { throw new UsageError(`não encontrado: ${f}`); }
    const p = parsePublicKeyRing(bytes);
    if (!p.ok) return { code: 20, stdout: `${p.fingerprint}\n`, stderr: `chaveiro inválido: ${p.error}\n` };
    return { code: 0, stdout: `${p.fingerprint}\n`, stderr: '' };
  }
  if (sub === 'convert') {
    // anel público do bot → chaveiro público do OTK, sem perder chave nem campo (F4, DEFESA_CIRCUITO)
    const { pos, opt } = parseArgs(argv.slice(1), new Set(), new Set(['--operator', '--out']));
    if (pos.length !== 1) throw new UsageError('otk keyring convert <anel_do_bot.json> [--operator <nome>] --out <chaveiro.json>');
    const out = one(opt, '--out');
    if (!out) throw new UsageError('--out <chaveiro.json> é obrigatório');
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(resolve(pos[0]!))); } catch { throw new UsageError(`não encontrado: ${pos[0]}`); }
    const operator = one(opt, '--operator');
    let text: string;
    try { text = convertBridgeKeyRingBytes(bytes, operator ?? undefined); } catch (e) { throw new UsageError(`anel do bot não convertido: ${e instanceof Error ? e.message : String(e)}`); }
    writeFileSync(resolve(out), text, 'utf8');
    const fp = sha256Hex(new TextEncoder().encode(text));
    return { code: 0, stdout: `chaveiro convertido gravado em ${out}
impressão digital do anel do bot (sha256 do arquivo de entrada): ${sha256Hex(bytes)}
impressão digital do chaveiro convertido (sha256): ${fp}
Publique a impressão digital do arquivo que vai entregar, por outro canal (contrato, site), nunca junto com os recibos.
`, stderr: '' };
  }
  if (sub !== 'export') throw new UsageError('otk keyring export | otk keyring fingerprint | otk keyring convert');
  const { pos, opt } = parseArgs(argv.slice(1), new Set(), new Set(['--key', '--history', '--from', '--operator', '--out']));
  if (pos.length) throw new UsageError(`argumento inesperado: ${pos[0]}`);
  const keys: PublicKeyEntry[] = [];
  if (opt.has('--history') && opt.has('--from')) throw new UsageError('use só --history (--from é o nome antigo da mesma opção)');
  const hist = one(opt, '--history') ?? one(opt, '--from');
  if (hist) {
    let v: unknown;
    try { v = JSON.parse(readFileSync(resolve(hist), 'utf8')); } catch { throw new UsageError(`--history não é JSON legível: ${hist}`); }
    const arr = Array.isArray(v) ? v : (v as { keys?: unknown }).keys;
    if (!Array.isArray(arr)) throw new UsageError('--history deve ter uma lista de chaves {keyId, address, status, retiredAt?} (ou {keys:[...]})');
    for (const e of arr as Array<Record<string, unknown>>) {
      // o histórico pode ter anotações do operador (ex.: "nota"); o chaveiro público só leva os 4 campos
      const k: PublicKeyEntry = { keyId: String(e['keyId'] ?? ''), address: String(e['address'] ?? ''), status: e['status'] as PublicKeyEntry['status'] };
      if (e['retiredAt'] !== undefined) k.retiredAt = String(e['retiredAt']);
      keys.push(k);
    }
  }
  for (const k of opt.get('--key') ?? []) {
    const spec = parseKeySpec(k);
    // --key substitui a entrada do mesmo keyId vinda do histórico (ex.: aposentar ou revogar agora)
    const i = keys.findIndex((x) => x.keyId === spec.keyId);
    if (i >= 0) keys[i] = spec; else keys.push(spec);
  }
  if (keys.length === 0) throw new UsageError('informe as chaves com --history e/ou --key');
  const out = one(opt, '--out');
  if (!out) throw new UsageError('--out <chaveiro.json> é obrigatório');
  const operator = one(opt, '--operator');
  let text: string;
  try {
    text = serializePublicKeyRing({ schema: 'otk.keyring.public.v1', ...(operator ? { operator } : {}), keys });
  } catch (e) { throw new UsageError(`chaveiro inválido: ${e instanceof Error ? e.message : String(e)}`); }
  writeFileSync(resolve(out), text, 'utf8');
  const fp = sha256Hex(new TextEncoder().encode(text));
  return { code: 0, stdout: `chaveiro gravado em ${out}\nimpressão digital (sha256): ${fp}\nPublique esta impressão digital por outro canal (contrato, site), nunca junto com os recibos.\n`, stderr: '' };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function cmdReceipts(argv: string[], deps: CliDeps): Promise<CliResult> {
  if (argv[0] !== 'export') throw new UsageError('otk receipts export --since AAAA-MM-DD --until AAAA-MM-DD --out <pasta> --pg-env <NOME>');
  const { pos, opt } = parseArgs(argv.slice(1), new Set(), new Set(['--since', '--until', '--out', '--pg-env', '--tenant']));
  if (pos.length) throw new UsageError(`argumento inesperado: ${pos[0]}`);
  const since = one(opt, '--since'); const until = one(opt, '--until'); const out = one(opt, '--out'); const envName = one(opt, '--pg-env');
  if (!since || !until) throw new UsageError('--since e --until são obrigatórios (AAAA-MM-DD)');
  if (!DAY_RE.test(since) || !DAY_RE.test(until) || since > until) throw new UsageError('--since/--until devem ser AAAA-MM-DD, com since <= until');
  if (!out) throw new UsageError('--out <pasta> é obrigatório');
  if (!envName) throw new UsageError('--pg-env <NOME> é obrigatório: o NOME da variável que guarda a URL do PostgreSQL (nunca a URL)');
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new UsageError('--pg-env deve ser o NOME de uma variável (A-Z, 0-9, _), nunca a URL');
  const tenant = one(opt, '--tenant');
  let pool: Awaited<ReturnType<CliDeps['openPool']>> | null = null;
  let res;
  try {
    // a abertura também fica dentro do try (X1 R5): nenhuma mensagem crua de conexão sai
    pool = await deps.openPool(envName);
    res = await exportReceipts(pool, { since, until, tenant });
  } catch (e) {
    if (e instanceof UsageError) throw e; // variável vazia: só o NOME aparece
    // nunca repassa a mensagem crua do driver (pode citar host ou usuário); só o código
    const code = (e as { code?: unknown }).code;
    return { code: 1, stdout: '', stderr: `erro: falha ao abrir ou ler o PostgreSQL${typeof code === 'string' ? ` (código ${code})` : ''}\n` };
  } finally {
    if (pool) { try { await pool.end(); } catch { /* fechar não pode vazar mensagem */ } }
  }
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, res.fileName), res.jsonl, 'utf8');
  writeFileSync(resolve(dir, res.manifestName), res.manifest, 'utf8');
  return {
    code: 0,
    stdout: `${res.receipts} recibo(s) e ${res.conferences} conferência(s) gravados em ${out}/${res.fileName}\nMANIFEST: ${out}/${res.manifestName}\nPróximo passo: otk verify ${out} --keyring <chaveiro.json> --fingerprint <impressão digital>\n`,
    stderr: '',
  };
}

export async function runCli(argv: string[], isTTY = false, deps: CliDeps = defaultDeps): Promise<CliResult> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === 'verify') return cmdVerify(rest, isTTY);
    if (cmd === 'keyring') return cmdKeyring(rest);
    if (cmd === 'receipts') return await cmdReceipts(rest, deps);
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') return { code: 0, stdout: USO + '\n', stderr: '' };
    throw new UsageError(cmd ? `comando desconhecido: ${cmd}` : 'informe um comando');
  } catch (e) {
    if (e instanceof UsageError || e instanceof VerifierUsageError) return { code: 2, stdout: '', stderr: `erro: ${e.message}\n${USO}\n` };
    throw e;
  }
}

// uso direto: tsx scripts/verify/otk.ts verify ...
const invokedDirectly = (() => {
  try { return resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  const r = await runCli(process.argv.slice(2), Boolean(process.stdout.isTTY));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
