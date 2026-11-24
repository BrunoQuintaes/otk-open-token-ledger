/**
 * QA2 — Smoke tests for src/proxy/ProxyGateway.ts (RB-052)
 *
 * Validates:
 *   - Module loads and exports startProxyGateway
 *   - ProxyGatewayOpts accepts optional port
 *   - Server starts on port 0 (OS-assigned) and closes cleanly
 *
 * No external network required; port 0 binds to loopback only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startProxyGateway, type ProxyGatewayOpts } from '../../src/proxy/ProxyGateway.js';

describe('ProxyGateway smoke — exports', () => {
  it('startProxyGateway is a function', () => {
    assert.equal(typeof startProxyGateway, 'function');
  });

  it('ProxyGatewayOpts accepts empty object', () => {
    const opts: ProxyGatewayOpts = {};
    assert.equal(typeof opts, 'object');
  });
});

describe('ProxyGateway smoke — lifecycle', () => {
  it('starts on port 0 and closes cleanly', (_, done) => {
    // port 0 lets the OS pick an ephemeral port — no conflict risk
    const server = startProxyGateway({ port: 0 });
    server.once('listening', () => {
      server.close(() => done());
    });
  });
});
