/**
 * Test stand-in for `reproducao/reproduzir_tudo.mjs` that prints the repository folder (its working folder) in the
 * forms a machine path takes in messages and stack traces: `C:\...`, `C:/...`, `file:///C:/...` and, on Windows, with
 * the drive letter in lower case; then one OK item and the final line, and exits with 0. The live command must remove
 * every form before the lines reach the page. Reads nothing, writes nothing.
 *
 * @module test/reproducao_ao_vivo/fixtures/vaza_caminho
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const forms = [
  path.join(root, 'reproducao', 'x.mjs'),
  pathToFileURL(path.join(root, 'reproducao', 'x.mjs')).href,
  [root, 'reproducao', 'x.mjs'].join('/').split(path.sep).join('/'),
  root.charAt(0).toLowerCase() + path.join(root, 'reproducao', 'x.mjs').slice(1),
];
forms.forEach((form, i) => console.log(`log${i + 1} ${form}`));
console.log(`OK      A. Item de exemplo com caminho ${forms[0]} — dublê`);
console.log('\nTUDO OK: 1 de 1 itens. Detalhes em (dublê de teste)');
