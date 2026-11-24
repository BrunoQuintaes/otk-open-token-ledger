/**
 * H2-EVAL / R13 — ContentStore endereçado por hash (interface da integradora, scripts/h2eval/types.ts: `ContentStore.get/getBytes`).
 * Cada conteúdo é um arquivo `<dir>/content/<sha256>` com `{ messages, prefixMessages }`; o sha256 é o do JSON canônico desse par e é
 * RECALCULADO em toda leitura (adulteração => erro). Binários (imagem/áudio, dono MET-02) ficam em `<sha256>.bin`. Nada de conteúdo vai ao
 * journal: só o hash. Escrita idempotente; um conteúdo já presente com bytes diferentes é recusado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../corpus/util.js';
import type { NeutralContent } from './dialogs.js';
import type { S1Prompt } from '../corpus/s1Corpus.js';

export interface ResolvedContentLike { promptSha256: string; messages: NeutralContent['messages']; prefixMessages: number | 'NOT_APPLICABLE' }
export interface ContentStoreLike { get(sha256: string): Promise<ResolvedContentLike>; getBytes(sha256: string): Promise<Uint8Array> }
export interface StorableContent { messages: NeutralContent['messages']; prefixMessages: number | 'NOT_APPLICABLE' }

export class ContentStoreError extends Error {
  readonly code: 'NOT_FOUND' | 'TAMPERED' | 'CONFLICT' | 'BAD_HASH';
  constructor(code: ContentStoreError['code'], m: string) { super(m); this.name = 'ContentStoreError'; this.code = code; }
}

const HEX64 = /^[0-9a-f]{64}$/;
export const contentHash = (c: StorableContent): string => sha256Hex(canonicalJson({ messages: c.messages, prefixMessages: c.prefixMessages }));
const bytesSha = (b: Uint8Array): string => sha256Hex(Buffer.from(b).toString('latin1'));

/** S1: uma mensagem de usuário, sem sistema (`prefixMessages` não se aplica). */
export function contentOfS1(p: S1Prompt): ResolvedContentLike {
  const messages: NeutralContent['messages'] = [{ role: 'user', parts: [{ type: 'text', text: p.text }] }];
  return { promptSha256: contentHash({ messages, prefixMessages: 'NOT_APPLICABLE' }), messages, prefixMessages: 'NOT_APPLICABLE' };
}

export interface ContentStore extends ContentStoreLike {
  put(c: StorableContent): string;
  has(sha256: string): boolean;
  putBytes(b: Uint8Array): string;
}

export function createContentStore(dir: string): ContentStore {
  const root = path.join(dir, 'content');
  const file = (sha: string, ext = ''): string => {
    if (!HEX64.test(sha)) throw new ContentStoreError('BAD_HASH', 'hash inválido');
    return path.join(root, sha + ext);
  };
  return {
    put(c) {
      const sha = contentHash(c); const f = file(sha); const body = canonicalJson({ messages: c.messages, prefixMessages: c.prefixMessages });
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(f)) {
        if (fs.readFileSync(f, 'utf8') !== body) throw new ContentStoreError('CONFLICT', `conteúdo ${sha} já existe com bytes diferentes`);
        return sha;
      }
      fs.writeFileSync(f, body, { flag: 'wx' });
      return sha;
    },
    has: (sha) => fs.existsSync(file(sha)),
    async get(sha) {
      const f = file(sha);
      if (!fs.existsSync(f)) throw new ContentStoreError('NOT_FOUND', `conteúdo ${sha} ausente`);
      const o = JSON.parse(fs.readFileSync(f, 'utf8')) as StorableContent;
      if (contentHash(o) !== sha) throw new ContentStoreError('TAMPERED', `conteúdo ${sha} adulterado`);
      return { promptSha256: sha, messages: o.messages, prefixMessages: o.prefixMessages };
    },
    putBytes(b) {
      const sha = bytesSha(b); const f = file(sha, '.bin');
      fs.mkdirSync(root, { recursive: true });
      if (!fs.existsSync(f)) fs.writeFileSync(f, b, { flag: 'wx' });
      return sha;
    },
    async getBytes(sha) {
      const f = file(sha, '.bin');
      if (!fs.existsSync(f)) throw new ContentStoreError('NOT_FOUND', `binário ${sha} ausente`);
      const b = new Uint8Array(fs.readFileSync(f));
      if (bytesSha(b) !== sha) throw new ContentStoreError('TAMPERED', `binário ${sha} adulterado`);
      return b;
    },
  };
}
