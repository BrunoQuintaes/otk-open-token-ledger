/**
 * LEGACY PROFILE (historical, PILOTO_V3 2026-10-03): this runner sets OTK_DB_URL='', starts the gateway
 * WITHOUT `operations` (never reaches handleDurableMitm), recomputes CU with CU_MODEL_v1 + bucket 100 and reads
 * the legacy TAL accounting. It is NOT evidence of the durable D1–D8 path; use runPilotV3.ts for that.
 * Kept unchanged otherwise so its historical results stay reproducible. Both share the canonical ledger.
 *
 * Anthropic pilot through the OTK transparent proxy (session 2026-09-29/30).
 *
 *   client (official @anthropic-ai/sdk, unmodified; base URL = OTK proxy, api key = OTK token)
 *     → OTK proxy (ProxyGateway, real code, in this process) → provider
 *     → receipt store + accounting layer → independent recomputation.
 *
 * Usage:
 *   npx tsx scripts/pilot/anthropic/runPilot.ts --mode=dry  --phase=minimal|stream|sample --out=<dir>
 *   npx tsx scripts/pilot/anthropic/runPilot.ts --mode=live --phase=minimal|stream|sample --out=<dir>
 * live needs ANTHROPIC_API_KEY in the environment (never printed); dry replaces the provider
 * by the local stand-in and uses its own ledger (dry calls never touch the paid budget).
 *
 * Every attempt is reserved in the shared ledger (budgetLedger.ts) before it starts,
 * one call at a time, SDK retries disabled; the run stops on the first divergence,
 * uncertain outcome or budget refusal. Exit: 0 all calls consistent; 1 divergence or
 * uncertain outcome; 2 budget refusal; 3 no credential (nothing called); 4 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { BudgetLedger, BudgetError, costFromUsage, maxInputTokensFor, PRICES, type ProviderUsage } from './budgetLedger.js';

const MODEL = 'claude-haiku-4-5-20251001';
const LIVE_LEDGER = process.env['OTK_PILOT_LEDGER'] ?? '<HOME>/otk-pilot/anthropic_budget_ledger.jsonl';
// Independent copy of the static weights (CostUnits.ts, CU_MODEL_v1) used to recompute CU
const W_PROVIDER_ANTHROPIC = 1.1;
const W_MODEL_HAIKU_45 = 0.8;
const CU_BUCKET = 100;

type Phase = 'minimal' | 'stream' | 'sample';
interface Planned { label: string; stream: boolean; prompt: string; maxTokens: number }

function arg(name: string): string | undefined {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

/** Deterministic synthetic text (no personal data). */
function syntheticText(sentences: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sentences; i++) {
    parts.push(`Frase ${i}: o medidor registra ${i * 7} unidades no lote ${100 + i}, sem dados pessoais.`);
  }
  return parts.join(' ');
}

function plan(phase: Phase): Planned[] {
  const ask = 'Responda apenas com a palavra ok.';
  if (phase === 'minimal') return [{ label: 'minimal-nostream', stream: false, prompt: ask, maxTokens: 16 }];
  if (phase === 'stream') return [{ label: 'minimal-stream', stream: true, prompt: ask, maxTokens: 16 }];
  const texts = { curto: syntheticText(3), medio: syntheticText(60), longo: syntheticText(400) };
  const out: Planned[] = [];
  for (const [size, text] of Object.entries(texts)) {
    for (const stream of [false, true]) {
      for (let rep = 1; rep <= 2; rep++) {
        out.push({ label: `${size}-${stream ? 'stream' : 'nostream'}-r${rep}`, stream,
          prompt: `Resuma em uma frase curta o texto a seguir.\n\n${text}`, maxTokens: 64 });
      }
    }
  }
  return out;
}

/** round-half-up, as CU_MODEL_v1 documents */
const roundHalfUp = (x: number) => Math.floor(x + 0.5);

function independentCU(inp: number, out: number): { raw: number; published: number } {
  const raw = roundHalfUp((inp + out) * W_MODEL_HAIKU_45 * W_PROVIDER_ANTHROPIC);
  return { raw, published: roundHalfUp(raw / CU_BUCKET) * CU_BUCKET };
}

async function main(): Promise<number> {
  const mode = arg('mode');
  const phase = arg('phase') as Phase | undefined;
  const outDir = arg('out');
  if ((mode !== 'dry' && mode !== 'live') || !phase || !['minimal', 'stream', 'sample'].includes(phase) || !outDir) {
    console.error('usage: --mode=dry|live --phase=minimal|stream|sample --out=<dir>');
    return 4;
  }
  if (mode === 'live' && !process.env['ANTHROPIC_API_KEY']) {
    console.error('credential_missing: ANTHROPIC_API_KEY not set; no call made');
    return 3;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const runId = `pilot-${mode}-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const ledger = new BudgetLedger(mode === 'live' ? LIVE_LEDGER : path.join(outDir, 'dry_ledger.jsonl'));

  // OTK configuration of this run (before importing OTK modules, which read env at load)
  const otkToken = crypto.randomBytes(24).toString('hex');
  process.env['OTK_TENANTS'] = `pilot-tenant/MEMBER:${otkToken}`;
  process.env['OTK_RECEIPT_LOG'] = path.join(outDir, `${runId}_receipts.jsonl`);
  process.env['OTK_DB_URL'] = '';
  process.env['PROVER_URL'] = 'disabled';

  let fake: Awaited<ReturnType<typeof import('../../../test/integration/fixtures/anthropicLikeServer.js')['startAnthropicLikeServer']>> | undefined;
  const realFetch = globalThis.fetch;
  if (mode === 'dry') {
    const dryKey = 'sk-ant-dry-run-fixture';
    process.env['ANTHROPIC_API_KEY'] = dryKey;
    const { startAnthropicLikeServer } = await import('../../../test/integration/fixtures/anthropicLikeServer.js');
    fake = await startAnthropicLikeServer(dryKey);
    const f = fake;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.anthropic.com')) return realFetch(f.url + url.slice('https://api.anthropic.com'.length), init);
      return realFetch(input as string, init);
    }) as typeof fetch;
  }

  const gw = await import('../../../src/proxy/ProxyGateway.js');
  const store = await import('../../../src/api/receiptStore.js');
  const tal = await import('../../../src/security/talRuntime.js');
  const { deriveEpoch } = await import('../../../src/types/receipt.js');
  const { defaultCostNormalizer } = await import('../../../src/sdk/OTKSDK.js');
  const { getCWJson } = await import('../../../src/economics/cwRuntime.js').catch(() => ({ getCWJson: () => null }));

  const server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Anthropic({ apiKey: otkToken, baseURL: base, maxRetries: 0, timeout: 60_000,
    defaultHeaders: { 'x-otk-provider': 'anthropic' } });

  const results: Record<string, unknown>[] = [];
  const callsFile = path.join(outDir, `${runId}_calls.jsonl`);
  let exit = 0;
  const seenEntries = new Set<string>();

  for (const p of plan(phase)) {
    const body = { model: MODEL, max_tokens: p.maxTokens, messages: [{ role: 'user' as const, content: p.prompt }] };
    let reservation: { id: string; reservedUsd: number };
    try {
      reservation = ledger.reserve(`${runId}/${p.label}`, MODEL, maxInputTokensFor(MODEL), p.maxTokens);
    } catch (e) {
      console.error(`budget refusal before ${p.label}: ${(e as Error).message}`);
      exit = e instanceof BudgetError ? 2 : 1;
      break;
    }
    const t0 = Date.now();
    let httpStatus: number | undefined;
    let usage: ProviderUsage | undefined;
    let returnedModel: string | undefined;
    let messageId: string | undefined;
    let providerRequestId: string | undefined;
    let text = '';
    let firstChunkMs: number | undefined;
    let error: string | undefined;
    let errorBody = false;
    try {
      if (!p.stream) {
        const { data, response, request_id } = await client.messages.create(body).withResponse();
        httpStatus = response.status;
        providerRequestId = request_id ?? undefined;
        usage = data.usage as unknown as ProviderUsage;
        returnedModel = data.model;
        messageId = data.id;
        text = data.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      } else {
        const { data: events, response, request_id } = await client.messages.create({ ...body, stream: true }).withResponse();
        providerRequestId = request_id ?? undefined;
        let stopped = false;
        // Independent aggregation of the documented events (message_delta usage is cumulative)
        for await (const ev of events) {
          if (firstChunkMs === undefined) firstChunkMs = Date.now() - t0;
          if (ev.type === 'message_start') {
            returnedModel = ev.message.model; messageId = ev.message.id;
            usage = { ...(ev.message.usage as unknown as ProviderUsage) };
          } else if (ev.type === 'message_delta') {
            // cumulative; null fields must not erase known values
            const next: ProviderUsage = { ...(usage ?? {}) };
            for (const [k, v] of Object.entries(ev.usage as unknown as Record<string, unknown>)) if (typeof v === 'number') next[k] = v;
            usage = next;
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            text += ev.delta.text;
          } else if (ev.type === 'message_stop') {
            stopped = true;
          }
        }
        // Only a complete stream settles as ok; a cut stream keeps the reservation (uncertain)
        httpStatus = stopped ? response.status : undefined;
        if (!stopped) error = 'stream ended without message_stop';
      }
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        httpStatus = e.status; errorBody = e.error != null; providerRequestId = e.requestID ?? undefined;
      }
      error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 500);
    }
    const latencyMs = Date.now() - t0;
    const settled = ledger.settle(reservation.id, { httpStatus, usage, errorBody, note: error,
      providerRequestId, providerMessageId: messageId });

    // OTK side: wait for the receipt of this call (metering runs after the response ends)
    await new Promise(r => setTimeout(r, 400));
    const epoch = String(deriveEpoch(Math.floor(Date.now() / 1000)));
    const entries = tal.getAccountingLayer().entries('pilot-tenant', epoch).filter(e => !seenEntries.has(e.requestId));
    entries.forEach(e => seenEntries.add(e.requestId));
    const entry = entries[0];
    const receipt = entry ? store.getReceipt(entry.requestId) : undefined;

    const inp = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
    const out = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
    const indep = inp !== undefined && out !== undefined ? independentCU(inp, out) : undefined;
    const cost = costFromUsage(MODEL, usage);
    const checks: Record<string, boolean> = {};
    if (httpStatus === 200) {
      checks['one_new_receipt'] = entries.length === 1 && receipt != null;
      checks['receipt_model_is_returned_id'] = receipt?.model === returnedModel;
      checks['receipt_tokens_equal_provider_usage'] = receipt?.inputTokens === inp && receipt?.outputTokens === out;
      checks['accounting_tokens_equal_provider_usage'] = entry?.inputTokens === inp && entry?.outputTokens === out;
      checks['receipt_cu_equals_independent'] = receipt?.costUnits === indep?.published;
      checks['accounting_debit_equals_receipt_cu'] = entry != null && receipt != null && entry.cu === BigInt(Math.floor(receipt.costUnits));
      checks['receipt_correlated_with_provider_id'] = entry?.requestId === messageId;
      checks['receipt_tenant'] = receipt?.tenantId === 'pilot-tenant';
      checks['usage_complete_for_pricing'] = cost !== null;
    }
    const allOk = httpStatus === 200 && Object.values(checks).every(Boolean);
    const record = {
      runId, label: p.label, mode, stream: p.stream, ledgerReservationId: reservation.id,
      reservedUsd: reservation.reservedUsd, settlement: settled.outcome, costUsd: settled.costUsd ?? null,
      costBreakdown: cost?.breakdown ?? null,
      requestedModel: MODEL, returnedModel, providerMessageId: messageId, providerRequestId,
      httpStatus, error, latencyMs, firstChunkMs, maxTokens: p.maxTokens,
      promptSha256: crypto.createHash('sha256').update(p.prompt).digest('hex'), promptChars: p.prompt.length,
      responseTextSha256: crypto.createHash('sha256').update(text).digest('hex'), responseChars: text.length,
      providerUsage: usage ?? null,
      receipt: receipt ? { requestId: receipt.requestId, model: receipt.model, inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens, costUnits: receipt.costUnits, cwVersion: (receipt as { cwVersion?: string }).cwVersion,
        tenantId: receipt.tenantId } : null,
      accounting: entry ? { requestId: entry.requestId, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, cu: String(entry.cu) } : null,
      independent: indep ? { ...indep, formula: 'round_half_up((in+out)×0.8×1.1), bucket 100 round-half-up',
        otkNormalizer: inp !== undefined && out !== undefined ? defaultCostNormalizer('anthropic', MODEL, inp, out) : null } : null,
      cwVersionLoaded: getCWJson()?.version ?? 'static',
      price: PRICES[MODEL], checks, consistent: allOk,
    };
    fs.appendFileSync(callsFile, JSON.stringify(record) + '\n');
    results.push(record);
    console.log(`${p.label}: http=${httpStatus ?? '-'} settle=${settled.outcome} cost=${(settled.costUsd ?? reservation.reservedUsd).toFixed(6)} consistent=${allOk}`);
    if (!allOk) { exit = 1; break; }
  }

  const summary = { runId, mode, phase, calls: results.length, exit, meteringCounts: gw.proxyMeteringCounts(), budget: ledger.summary(), ledgerFile: ledger.file };
  fs.writeFileSync(path.join(outDir, `${runId}_summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.budget));
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await fake?.close();
  return exit;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
