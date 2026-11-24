/**
 * G4 — Chain Registry behavioral tests
 *
 * Validates the ChainRegistry contract:
 *   - Known chains are resolvable by ID
 *   - Unknown chains return undefined (no throw)
 *   - Deployments are retrievable per chain and per contract
 *   - evmVersion for ibft-local is 'berlin' (ADR-EVM-0002)
 *   - getChainRegistry() / resetChainRegistry() singleton works
 *   - addDeployment() operator injection works
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChainRegistry } from '../../src/infra/chainRegistry.js';
import {
  getChainRegistry,
  resetChainRegistry,
  setChainRegistry,
} from '../../src/infra/multichainRuntime.js';

const IBFT_CHAIN_ID = 1337;

describe('Chain Registry — known networks', () => {
  it('getChain(1337) returns ibft-local profile', () => {
    const reg = new ChainRegistry();
    const chain = reg.getChain(IBFT_CHAIN_ID);
    assert.ok(chain, 'ibft-local chain not found');
    assert.equal(chain.name, 'ibft-local');
    assert.equal(chain.chainId, IBFT_CHAIN_ID);
  });

  it('ibft-local has evmVersion=berlin (Berlin EVM — ADR-EVM-0002)', () => {
    const chain = new ChainRegistry().getChain(IBFT_CHAIN_ID);
    assert.equal(chain?.evmVersion, 'berlin');
  });

  it('listChains() returns at least 4 networks', () => {
    const chains = new ChainRegistry().listChains();
    assert.ok(chains.length >= 4, `Expected >= 4 chains, got ${chains.length}`);
  });

  it('getChain(999) returns undefined for unknown chain', () => {
    const chain = new ChainRegistry().getChain(999);
    assert.equal(chain, undefined);
  });

  it('all listed chains have required fields: chainId, name, rpcRef, nativeCurrency', () => {
    const chains = new ChainRegistry().listChains();
    for (const c of chains) {
      assert.ok(typeof c.chainId === 'number', `chainId not number: ${c.name}`);
      assert.ok(c.name.length > 0, 'name is empty');
      assert.ok(c.rpcRef.length > 0, 'rpcRef is empty');
      assert.ok(c.nativeCurrency.length > 0, 'nativeCurrency is empty');
    }
  });
});

describe('Chain Registry — deployments', () => {
  it('getDeployment(1337, ReceiptRegistry) returns a record', () => {
    const reg = new ChainRegistry();
    const dep = reg.getDeployment(IBFT_CHAIN_ID, 'ReceiptRegistry');
    assert.ok(dep, 'ReceiptRegistry deployment not found for ibft-local');
    assert.equal(dep.chainId, IBFT_CHAIN_ID);
    assert.equal(dep.contractName, 'ReceiptRegistry');
  });

  it('getDeployment(1337, MeteringVerifierV2) returns a record', () => {
    const dep = new ChainRegistry().getDeployment(IBFT_CHAIN_ID, 'MeteringVerifierV2');
    assert.ok(dep, 'MeteringVerifierV2 not found');
    assert.equal(dep.version, 'metering_v2-mpc-final');
  });

  it('getDeployment(1337, Unknown) returns undefined', () => {
    const dep = new ChainRegistry().getDeployment(IBFT_CHAIN_ID, 'NonExistent');
    assert.equal(dep, undefined);
  });

  it('getDeploymentsByChain(1337) returns at least 2 records', () => {
    const deps = new ChainRegistry().getDeploymentsByChain(IBFT_CHAIN_ID);
    assert.ok(deps.length >= 2, `Expected >= 2 deployments on ibft-local, got ${deps.length}`);
  });

  it('addDeployment() injects operator deployment (override)', () => {
    const reg = new ChainRegistry();
    reg.addDeployment({
      chainId: 1,
      contractName: 'ReceiptRegistry',
      address: '0xAbCdEf0000000000000000000000000000000001',
      deployedAt: '2026-03-06T00:00:00Z',
      version: 'U8.5.3',
      status: 'active',
    });
    const dep = reg.getDeployment(1, 'ReceiptRegistry');
    assert.equal(dep?.status, 'active');
    assert.equal(dep?.address, '0xAbCdEf0000000000000000000000000000000001');
  });
});

describe('Chain Registry — singleton', () => {
  beforeEach(() => { resetChainRegistry(); });

  it('getChainRegistry() returns a ChainRegistry instance', () => {
    assert.ok(getChainRegistry() instanceof ChainRegistry);
  });

  it('getChainRegistry() returns same instance (singleton)', () => {
    assert.strictEqual(getChainRegistry(), getChainRegistry());
  });

  it('setChainRegistry() replaces the singleton', () => {
    const custom = new ChainRegistry();
    setChainRegistry(custom);
    assert.strictEqual(getChainRegistry(), custom);
  });

  it('resetChainRegistry() restores default registry', () => {
    setChainRegistry(new ChainRegistry());
    resetChainRegistry();
    assert.ok(getChainRegistry().getChain(IBFT_CHAIN_ID), 'ibft-local missing after reset');
  });
});
