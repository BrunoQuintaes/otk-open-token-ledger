/**
 * OTK Subgraph Mapping — E6.7 (W5-5B03)
 *
 * AssemblyScript event handlers for The Graph indexer.
 * Indexes ReceiptSubmitted (v1) and ReceiptSubmittedV2 events.
 *
 * @note This file uses AssemblyScript (a TypeScript subset that compiles to WASM).
 *       It is NOT runnable as Node.js TypeScript. Deploy via `graph deploy`.
 *
 * @module subgraph/src/mapping
 * @since Wave 5 (W5-5B03 / E6.7)
 */

import { BigInt, Bytes } from '@graphprotocol/graph-ts';
import { Receipt, ReceiptV2, Tenant } from '../generated/schema';
import {
  ReceiptSubmitted,
} from '../generated/ReceiptRegistry/ReceiptRegistry';
import {
  ReceiptSubmittedV2,
} from '../generated/ReceiptRegistryV2/ReceiptRegistryV2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadOrCreateTenant(userId: BigInt, blockNumber: BigInt): Tenant {
  const id = userId.toString();
  let tenant = Tenant.load(id);
  if (tenant === null) {
    tenant = new Tenant(id);
    tenant.userId = userId;
    tenant.totalCostUnits = BigInt.fromI32(0);
    tenant.totalCostUnitsV2 = BigInt.fromI32(0);
    tenant.receiptCount = BigInt.fromI32(0);
    tenant.receiptCountV2 = BigInt.fromI32(0);
    tenant.lastEpoch = BigInt.fromI32(0);
    tenant.lastUpdatedBlock = blockNumber;
  }
  return tenant as Tenant;
}

// ---------------------------------------------------------------------------
// v1 Handler: ReceiptSubmitted
// ---------------------------------------------------------------------------

/**
 * Handles ReceiptSubmitted from ReceiptRegistry (v1).
 *
 * Event: ReceiptSubmitted(bytes32 indexed commitment, uint256 indexed userId,
 *                         uint256 costUnits, uint256 epoch, address submitter)
 */
export function handleReceiptSubmitted(event: ReceiptSubmitted): void {
  const commitment = event.params.commitment;
  const id = commitment.toHexString();

  // Create Receipt entity
  const receipt = new Receipt(id);
  receipt.userId = event.params.userId;
  receipt.costUnits = event.params.costUnits;
  receipt.epoch = event.params.epoch;
  receipt.submitter = event.params.submitter;
  receipt.blockNumber = event.block.number;
  receipt.blockTimestamp = event.block.timestamp;
  receipt.transactionHash = event.transaction.hash;

  // Load or create Tenant aggregate
  const tenant = loadOrCreateTenant(event.params.userId, event.block.number);
  receipt.tenant = tenant.id;

  // Update Tenant aggregates
  tenant.totalCostUnits = tenant.totalCostUnits.plus(event.params.costUnits);
  tenant.receiptCount = tenant.receiptCount.plus(BigInt.fromI32(1));
  if (event.params.epoch.gt(tenant.lastEpoch)) {
    tenant.lastEpoch = event.params.epoch;
  }
  tenant.lastUpdatedBlock = event.block.number;

  receipt.save();
  tenant.save();
}

// ---------------------------------------------------------------------------
// v2 Handler: ReceiptSubmittedV2
// ---------------------------------------------------------------------------

/**
 * Handles ReceiptSubmittedV2 from ReceiptRegistryV2.
 *
 * Event: ReceiptSubmittedV2(bytes32 indexed commitment, uint256 indexed userId,
 *                           uint256 costUnits, uint256 epoch,
 *                           uint256 minUsageBucket, uint256 maxUsageBucket,
 *                           address submitter)
 */
export function handleReceiptSubmittedV2(event: ReceiptSubmittedV2): void {
  const commitment = event.params.commitment;
  const id = commitment.toHexString();

  // Create ReceiptV2 entity
  const receipt = new ReceiptV2(id);
  receipt.userId = event.params.userId;
  receipt.costUnits = event.params.costUnits;
  receipt.epoch = event.params.epoch;
  receipt.minUsageBucket = event.params.minUsageBucket;
  receipt.maxUsageBucket = event.params.maxUsageBucket;
  receipt.submitter = event.params.submitter;
  receipt.blockNumber = event.block.number;
  receipt.blockTimestamp = event.block.timestamp;
  receipt.transactionHash = event.transaction.hash;

  // Load or create Tenant aggregate
  const tenant = loadOrCreateTenant(event.params.userId, event.block.number);
  receipt.tenant = tenant.id;

  // Update Tenant v2 aggregates
  tenant.totalCostUnitsV2 = tenant.totalCostUnitsV2.plus(event.params.costUnits);
  tenant.receiptCountV2 = tenant.receiptCountV2.plus(BigInt.fromI32(1));
  if (event.params.epoch.gt(tenant.lastEpoch)) {
    tenant.lastEpoch = event.params.epoch;
  }
  tenant.lastUpdatedBlock = event.block.number;

  receipt.save();
  tenant.save();
}
