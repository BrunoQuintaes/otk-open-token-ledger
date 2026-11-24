/**
 * STOPGATE-01 P1.3 (R-12): source key of a request behind (or around) a reverse proxy. The key feeds the per-source
 * authentication-failure limiter of the proxy and the key-lookup miss limiter of the API: a client that can choose its
 * key can rotate it and escape both.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { sourceKey } from '../../src/security/authFailureLimiter.js';

const req = (peer: string, xff?: string | string[]): IncomingMessage =>
  ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

describe('STOPGATE-01 R-12: trusted hops and X-Forwarded-For', () => {
  const saved = { hops: process.env['OTK_PROXY_TRUSTED_HOPS'], addrs: process.env['OTK_PROXY_TRUSTED_ADDRS'] };
  beforeEach(() => { delete process.env['OTK_PROXY_TRUSTED_HOPS']; delete process.env['OTK_PROXY_TRUSTED_ADDRS']; });
  after(() => {
    if (saved.hops === undefined) delete process.env['OTK_PROXY_TRUSTED_HOPS']; else process.env['OTK_PROXY_TRUSTED_HOPS'] = saved.hops;
    if (saved.addrs === undefined) delete process.env['OTK_PROXY_TRUSTED_ADDRS']; else process.env['OTK_PROXY_TRUSTED_ADDRS'] = saved.addrs;
  });

  it('absent or invalid configuration: the header is ignored (socket peer)', () => {
    assert.equal(sourceKey(req('198.51.100.9', '1.2.3.4')), 'ip4:198.51.100.9');
    for (const bad of ['abc', '-1', '', ' ']) {
      process.env['OTK_PROXY_TRUSTED_HOPS'] = bad;
      assert.equal(sourceKey(req('198.51.100.9', '1.2.3.4')), 'ip4:198.51.100.9', `hops=${JSON.stringify(bad)}`);
    }
  });

  it('one trusted hop: the address appended by the proxy wins over client-prepended entries', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1';
    assert.equal(sourceKey(req('10.0.0.2', 'spoofed-1, 6.6.6.6, 203.0.113.7')), 'ip4:203.0.113.7');
    assert.equal(sourceKey(req('10.0.0.2', ['6.6.6.6', '203.0.113.7'])), 'ip4:203.0.113.7', 'repeated headers are joined');
  });

  it('more hops configured than present (proxy bypassed or misconfigured): socket peer', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '2';
    assert.equal(sourceKey(req('10.0.0.2', '203.0.113.7')), 'ip4:10.0.0.2');
    assert.equal(sourceKey(req('10.0.0.2')), 'ip4:10.0.0.2');
  });

  it('non-address entries never become source keys; ports and brackets are stripped', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1';
    for (const forged of ['evil', 'unknown', '999.1.1.1', 'a.b.c.d', '1.2.3.4.5', '_']) {
      assert.equal(sourceKey(req('10.0.0.2', forged)), 'ip4:10.0.0.2', `forged ${forged}`);
    }
    assert.equal(sourceKey(req('10.0.0.2', '203.0.113.7:51234')), 'ip4:203.0.113.7');
    assert.equal(sourceKey(req('10.0.0.2', '[2001:db8:1:2::7]:443')), 'ip6:2001:db8:1:2::/64');
  });

  it('IPv6: one /64 is one source; IPv4-mapped peers are IPv4', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1';
    assert.equal(sourceKey(req('10.0.0.2', '2001:db8:1:2::1')), sourceKey(req('10.0.0.2', '2001:db8:1:2:ffff::9')));
    assert.notEqual(sourceKey(req('10.0.0.2', '2001:db8:1:2::1')), sourceKey(req('10.0.0.2', '2001:db8:1:3::1')));
    delete process.env['OTK_PROXY_TRUSTED_HOPS'];
    assert.equal(sourceKey(req('::ffff:192.0.2.5')), 'ip4:192.0.2.5');
  });

  it('OTK_PROXY_TRUSTED_ADDRS: a client reaching the replica directly cannot choose its key', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1';
    process.env['OTK_PROXY_TRUSTED_ADDRS'] = '10.0.0.0/24, fd00::/8, bogus, 10.9.9.9/99';
    assert.equal(sourceKey(req('10.0.0.2', '203.0.113.7')), 'ip4:203.0.113.7', 'peer is a declared proxy');
    assert.equal(sourceKey(req('::ffff:10.0.0.3', '203.0.113.7')), 'ip4:203.0.113.7', 'IPv4-mapped proxy peer');
    assert.equal(sourceKey(req('fd00::5', '203.0.113.8')), 'ip4:203.0.113.8', 'IPv6 proxy peer');
    assert.equal(sourceKey(req('198.51.100.9', '1.2.3.4')), 'ip4:198.51.100.9', 'direct client: header ignored');
    assert.equal(sourceKey(req('10.9.9.9', '1.2.3.4')), 'ip4:10.9.9.9', 'invalid CIDR entry trusts nobody');
  });

  it('without OTK_PROXY_TRUSTED_ADDRS the bypass is the documented residual (header trusted from any peer)', () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1';
    assert.equal(sourceKey(req('198.51.100.9', '1.2.3.4')), 'ip4:1.2.3.4');
  });
});
