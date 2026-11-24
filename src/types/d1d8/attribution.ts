/**
 * D1–D8 shared contract v1.4 (OVERNIGHT 20261005 / Phase 7) — attribution of an operation to a project and a task.
 *
 * Hierarchy: tenant → project → application → taskType → taskRun → operation. The tenant comes from the
 * credential; every other level is optional. An operation without attribution stays valid and is reported as
 * "unattributed"; it is never assigned to a project by guess.
 *
 *  - projectId     a project REGISTERED for the tenant (otk_projects); the cost belongs to it.
 *  - applicationId a registered application of the tenant that issued the call (e.g. a shared orchestrator).
 *                  A dimension of the same spend, never an additional spend: totals by application are not
 *                  added to totals by project.
 *  - taskType      kind of work (e.g. "summarize", "classify"); free label of the tenant, format-checked.
 *  - taskRunId     one execution of a task; it may group many operations (and real retries).
 *  - teamId        legacy organizational field: recorded only when the authenticated identity carries one
 *                  (never taken from a request header); null in the durable proxy profile today.
 *
 * Privacy: attribution is private, off-chain. Labels never enter a public authorization, a commitment or a
 * chain transaction. The signed statement below is stored with the private receipt.
 *
 * Signature: the attribution frozen at admission is signed by the OTK OPERATOR in a separate statement bound to
 * the receipt digest (domain OTK_ATTRIBUTION_V1), like the conference report. otk.receipt.v3 keeps its frozen
 * shape (D1D8_SCHEMA_IDS: a new shape gets a new id), so every receipt signed before keeps verifying. A later
 * correction would be a new statement that names the one it supersedes, never an edit of a signed one.
 */
import type { Hex32, IsoTime, OperationKey } from './common.js';

export interface OperationAttribution {
  projectId: string | null;
  applicationId: string | null;
  taskType: string | null;
  taskRunId: string | null;
  teamId: string | null;
}

export interface AttributionStatementV1 {
  schema: 'otk.attribution.v1';
  key: OperationKey;
  /** Digest of the private receipt v3 this attribution belongs to (swap between receipts is rejected). */
  receiptDigest: Hex32;
  attribution: OperationAttribution;
  /** Admission time of the operation (the attribution was frozen then); deterministic on every retry. */
  attributedAt: IsoTime;
  /** Digest of an earlier statement this one corrects; null for the original. */
  supersedes: Hex32 | null;
}
