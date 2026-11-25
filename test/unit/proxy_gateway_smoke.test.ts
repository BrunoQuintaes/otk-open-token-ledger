/**
 * QA2 — Smoke tests for src/proxy/ProxyGateway.ts (RB-052)
 *
 * Validates:
 *   - Module loads and exports startProxyGateway
 *   - ProxyGatewayOpts accepts optional port
 *   - Server starts on port 0 (OS-assigned) and closes cleanly
 *
 * No external network required; port 0 binds to loopback only.
 *
 * Module under test: `src/proxy/ProxyGateway.ts`.
 *
 * Strategy / partitions: the exports exist and the options object may be empty; the gateway starts on an
 * OS-assigned port and closes.
 *
 * Needs: binds one local port for a moment.
 *
 * Run just this file: `npx tsx --test test/unit/proxy_gateway_smoke.test.ts`
 *
 * @module test/unit/proxy_gateway_smoke.test
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
