/**
 * Child process for core_flow_restart.test.ts — a fresh process that restores the
 * receipt JSONL written by the API server (restart), then runs the real billing
 * (UsageMeterService) and reconciliation (ReconciliationSystem) modules on it.
 *
 * Env (set by the parent): OTK_RECEIPT_LOG, PROVER_URL=disabled, OTK_DB_URL=''.
 * Args: tenant ids and epoch as JSON in argv[2].
 * Prints one JSON object on stdout.
 *
 * The argument object has `tenants` (tenant ids to bill), `epochId` (billing epoch, decimal string), `batchTenant`
 * (tenant whose receipts are reconciled) and `externalUsd` (synthetic invoice amount in USD). The output has the
 * per-tenant billing summary (CU as decimal strings), the reconciliation line, the result of verifying an
 * ephemeral signed weights table and a tampered copy, the number of restored receipts and the balance of the
 * `default` tenant. Billing runs with `dryRun: true`, so no usage is submitted to an external billing service.
 * Not a test file; it is started by the parent test with `node --import tsx`.
 *
 * @module test/integration/fixtures/core_flow_worker
 */
import { Wallet } from 'ethers';

const { tenants, epochId, batchTenant, externalUsd } = JSON.parse(process.argv[2] ?? '{}') as {
  tenants: string[]; epochId: string; batchTenant: string; externalUsd: number;
};

const store = await import('../../../src/api/receiptStore.js');
const { getAccountingLayer } = await import('../../../src/security/talRuntime.js');
const { computeAndSubmitUsage } = await import('../../../src/billing/UsageMeterService.js');
const { reconcile } = await import('../../../src/economics/ReconciliationSystem.js');
const { buildSignedMessage, verifyCWSignature } = await import('../../../src/economics/CUWeightsLoader.js');

const billing: Record<string, unknown> = {};
for (const t of tenants) {
  const s = await computeAndSubmitUsage(t, epochId, { dryRun: true });
  billing[t] = { ...s, totalCU: String(s.totalCU), balanceCU: String(getAccountingLayer().balance(t, epochId).totalCU) };
}

// Reconciliation: the batchTenant's receipts are grouped under one synthetic tx
// (substitute for an on-chain batch) and compared with a synthetic invoice line.
const entries = getAccountingLayer().entries(batchTenant, epochId);
const otkRecords = entries.map(e => {
  const r = store.getReceipt(e.requestId)!;
  return {
    txHash: 'tx-sim-batch-1', userId: String(r.userId), costUnits: e.cu, epoch: Number(epochId),
    provider: r.provider, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    receiptId: r.requestId,
  };
});
const report = reconcile(otkRecords, [{ txHash: 'tx-sim-batch-1', userId: 'invoice', billedUsd: externalUsd }], '2026-09-29T00:00:00Z');
const line = report.items[0]!;

// R01 still holds in this process: an ephemeral signer, a V2 table, one tampering.
const signer = Wallet.createRandom();
const cw = {
  version: 'itest', validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
  weights: { openai: { 'gpt-4o': { inputWeight: 1, outputWeight: 3, latencyWeight: 0 } } },
  signedBy: signer.address, signature: '',
};
cw.signature = await signer.signMessage(buildSignedMessage(cw));
const tampered = structuredClone(cw);
tampered.weights.openai['gpt-4o'].outputWeight = 900;

console.log(JSON.stringify({
  billing,
  reconciliation: {
    otkCU: String(line.otkCU), otkReceiptCount: line.otkReceiptCount, receiptIds: line.receiptIds,
    expectedUsd: line.expectedUsd, externalUsd: line.externalUsd, deltaUsd: line.deltaUsd,
    discrepancyFlag: line.discrepancyFlag, status: line.status,
  },
  r01: { original: await verifyCWSignature(cw, signer.address), tampered: await verifyCWSignature(tampered, signer.address) },
  restoredReceipts: store.size(),
  defaultCU: String(getAccountingLayer().balance('default', epochId).totalCU),
}));
