/**
 * Wave 2 Pack 20 — P2.2 /app/login Tests
 *
 * Tests:
 *   - Login page HTML structure and form elements
 *   - Logout redirect behavior
 *   - Token validation flow (client-side JS logic)
 *   - handleLoginRequest route handler
 *
 * @since Wave 2 Pack 20 (2026-03-15)
 *
 * Module under test: `src/dashboard/login.ts` (`getLoginHtml`, `handleLoginRequest`).
 *
 * Strategy / partitions: the page has the form, the client-side token check, the error message and the redirect
 * logic (checked as text); the route handler answers the login page with HTML.
 *
 * Needs: nothing external; the request and response are built on unconnected sockets and never sent.
 *
 * Run just this file: `npx tsx --test test/unit/wave2_pack20_login.test.ts`
 *
 * @module test/unit/wave2_pack20_login.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLoginHtml, handleLoginRequest } from '../../src/dashboard/login.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

/**
 * Create a minimal mock IncomingMessage for route testing.
 * @param method - HTTP method set on the request.
 * @param url - Request path set on the request.
 * @returns A request bound to an unconnected socket.
 */
function mockReq(method: string, url: string): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  return req;
}

/**
 * Create a minimal mock ServerResponse that captures status + headers + body.
 */
function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
  res._status = 0;
  res._headers = {};
  res._body = '';

  const origSetHeader = res.setHeader.bind(res);

  res.setHeader = function (name: string, value: string | number | readonly string[]) {
    res._headers[String(name).toLowerCase()] = String(value);
    return origSetHeader(name, value);
  } as typeof res.setHeader;

  Object.defineProperty(res, 'statusCode', {
    set(v: number) { res._status = v; },
    get() { return res._status; },
  });

  res.end = function (data?: any) {
    if (data) res._body = String(data);
    // Don't actually call origEnd to avoid socket errors in test
    return res;
  } as typeof res.end;

  return res;
}

describe('P2.2 — Login Page HTML', () => {

  it('generates valid HTML with form elements', () => {
    const html = getLoginHtml();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    assert.ok(html.includes('<title>OTK zk-Metering - Login</title>'), 'should have login title');
    assert.ok(html.includes('<form'), 'should contain a form element');
    assert.ok(html.includes('id="token-input"'), 'should have token input field');
    assert.ok(html.includes('id="login-btn"'), 'should have login button');
    assert.ok(html.includes('type="password"'), 'token input should be password type');
  });

  it('includes client-side token validation logic', () => {
    const html = getLoginHtml();
    assert.ok(html.includes('handleLogin'), 'should have handleLogin function');
    assert.ok(html.includes('localStorage'), 'should use localStorage for token storage');
    assert.ok(html.includes('/health'), 'should validate token against /health endpoint');
    assert.ok(html.includes('otk_token'), 'should use otk_token key in localStorage');
  });

  it('includes error message display', () => {
    const html = getLoginHtml();
    assert.ok(html.includes('id="error-msg"'), 'should have error message element');
    assert.ok(html.includes('Invalid token'), 'should show message for invalid token (401)');
    assert.ok(html.includes('Connection failed'), 'should show message for connection error');
  });

  it('has auto-redirect and session persistence logic', () => {
    const html = getLoginHtml();
    assert.ok(html.includes("localStorage.setItem('otk_token'"), 'should store token in localStorage on success');
    assert.ok(html.includes("localStorage.getItem('otk_token')"), 'should check existing token for auto-redirect');
    assert.ok(html.includes('/app'), 'should redirect to /app on success');
  });
});

describe('P2.2 — Login Route Handler', () => {

  it('handles GET /app/login and returns HTML', () => {
    const req = mockReq('GET', '/app/login');
    const res = mockRes();
    const handled = handleLoginRequest(req, res, '/app/login');
    assert.ok(handled, 'should handle /app/login');
    assert.equal(res._status, 200);
    assert.ok(res._headers['content-type']?.includes('text/html'), 'should return HTML');
    assert.ok(res._body.includes('<!DOCTYPE html>'), 'body should be HTML');
  });
});
