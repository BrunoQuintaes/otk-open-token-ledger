/**
 * Grava os vetores de teste em test/verifier/vetores/ (para a página e para a paridade):
 *   vetores/recibos/...        os arquivos de entrada (iguais aos de buildVectors)
 *   vetores/chaveiro.json      chaveiro público de TESTE
 *   vetores/esperado.json      impressão digital, sha256 do relatório (com e sem impressão digital) e vereditos
 * Uso: npx tsx test/verifier/gera_vetores.ts [--check]   (--check só compara com o que está no disco)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSha256, verifyBundle } from '../../src/verifier/index.js';
import { buildVectors, KEYRING_FINGERPRINT, KEYRING_TEXT, keyringFile } from './vetores.js';

export const VETORES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'vetores');

export async function expectedFiles(): Promise<Map<string, Uint8Array>> {
  const { files, expect } = await buildVectors();
  const m = new Map<string, Uint8Array>();
  for (const f of files) m.set(f.name, f.bytes);
  m.set('chaveiro.json', new TextEncoder().encode(KEYRING_TEXT));
  const anchored = verifyBundle(files, keyringFile(), { fingerprint: KEYRING_FINGERPRINT });
  const notAnchored = verifyBundle(files, keyringFile(), {});
  const esperado = {
    schema: 'otk.verifier_vectors.v1',
    aviso: 'CHAVES DE TESTE: os recibos foram assinados com chaves fixas públicas, sem valor. Não são recibos reais.',
    entrada: 'pasta recibos/ (arrastar a pasta inteira) + chaveiro.json',
    impressaoDigital: KEYRING_FINGERPRINT,
    relatorioSha256: { comImpressaoDigital: reportSha256(anchored), semImpressaoDigital: reportSha256(notAnchored) },
    exitCode: { comImpressaoDigital: anchored.exitCode, semImpressaoDigital: notAnchored.exitCode },
    vereditos: expect,
  };
  m.set('esperado.json', new TextEncoder().encode(JSON.stringify(esperado, null, 2) + '\n'));
  return m;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const m = await expectedFiles();
  let diff = 0;
  for (const [name, bytes] of m) {
    const p = resolve(VETORES_DIR, name);
    if (check) {
      const same = existsSync(p) && Buffer.compare(readFileSync(p), Buffer.from(bytes)) === 0;
      if (!same) { diff++; console.log('DIFERENTE', name); }
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    }
  }
  console.log(check ? `conferidos ${m.size} arquivos, ${diff} diferentes` : `gravados ${m.size} arquivos em ${VETORES_DIR}`);
  process.exitCode = diff ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
