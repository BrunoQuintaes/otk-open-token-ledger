// SYNTHETIC test helper (C158 cycle 2): the HUMAN acknowledgement of uncertain operations that a resume now requires. Reads the journals of a campaign dir (plain JSON lines).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { UncertainAck } from '../../../scripts/h2eval/core/runner.js';

export const TEST_AUTHORITY = 'ordem SINTETICA de teste (C158 ciclo 2): retomada humana apos operacao incerta';
/** every uncertain operation found in <campaignDir>/batches/<id>/journal.jsonl (or in <campaignDir>/journal.jsonl for a single batch dir), acknowledged by a synthetic human */
export function uncertainAcksIn(dir: string): UncertainAck[] {
  const files = existsSync(path.join(dir, 'batches')) ? readdirSync(path.join(dir, 'batches')).map((b) => path.join(dir, 'batches', b, 'journal.jsonl')) : [path.join(dir, 'journal.jsonl')];
  const ids = new Set<string>();
  for (const f of files) if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const j = JSON.parse(l) as { kind: string; operationId: string }; if (j.kind === 'UNCERTAIN_ISOLATED' || j.kind === 'TIMEOUT_UNCERTAIN') ids.add(j.operationId); }
  return [...ids].map((operationId) => ({ operationId, acknowledgedBy: 'human:operador-sintetico', authority: TEST_AUTHORITY }));
}
