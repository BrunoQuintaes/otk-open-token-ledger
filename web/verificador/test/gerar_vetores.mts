// Grava em disco os vetores do VERIFICADOR_MVP (test/verifier/vetores.ts, importado pelo caminho,
// sem cópia) para a página e o comando lerem os MESMOS bytes. Só chaves de teste públicas.
// Uso: node_modules/.bin/tsx test/gerar_vetores.mts <saida>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const saida = path.resolve(process.argv[2] ?? 'test/vetores_gerados');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const V = await import(pathToFileURL(path.join(REPO, 'test', 'verifier', 'vetores.ts')).href);
const { files, expect } = await V.buildVectors();
for (const f of files) {
  const p = path.join(saida, ...f.name.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, f.bytes);
}
const kr = V.keyringFile();
fs.writeFileSync(path.join(saida, kr.name), kr.bytes);
fs.writeFileSync(path.join(saida, 'esperado.json'), JSON.stringify({ fingerprint: V.KEYRING_FINGERPRINT, keyring: kr.name, files: files.map((f: { name: string }) => f.name), expect }, null, 2) + '\n');
console.log(JSON.stringify({ saida, arquivos: files.length, esperados: expect.length }));
