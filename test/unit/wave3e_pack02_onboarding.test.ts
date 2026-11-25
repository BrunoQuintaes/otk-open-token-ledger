/**
 * Wave 3E Pack 02 — Onboarding Wizard + Keys UI Tests (P3.2+P3.3+P3.4)
 *
 * Tests dashboard HTML structure for onboarding and key management.
 *
 * Modules under test: `src/dashboard/app.ts` (onboarding wizard and key management in the page) and
 * `src/dashboard/login.ts` (login and signup forms), both checked as generated HTML text.
 *
 * Strategy / partitions: as listed in each `describe`; the presence of each element, form, script function and
 * request target in the generated page.
 *
 * Needs: nothing external (no browser; the page scripts are not run).
 *
 * Run just this file: `npx tsx --test test/unit/wave3e_pack02_onboarding.test.ts`
 *
 * @module test/unit/wave3e_pack02_onboarding.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ===========================================================================
// Dashboard HTML — Onboarding tab structure (P3.2)
// ===========================================================================

import { getDashboardHtml } from '../../src/dashboard/app.js';

describe('W3E-02 — Dashboard Onboarding tab (P3.2)', () => {
  const html = getDashboardHtml();

  it('has 6 tabs (Overview, Receipts, Billing, Admin, Health, Onboarding)', () => {
    const tabs = html.match(/data-tab="/g);
    assert.ok(tabs && tabs.length >= 6, `expected >= 6 tabs, got ${tabs?.length}`);
  });

  it('contains onboarding tab button', () => {
    assert.ok(html.includes('data-tab="onboarding"'));
  });

  it('contains onboarding tab content', () => {
    assert.ok(html.includes('id="tab-onboarding"'));
  });

  it('has wizard steps 1-4', () => {
    assert.ok(html.includes('wizard-step-1'));
    assert.ok(html.includes('wizard-step-2'));
    assert.ok(html.includes('wizard-step-3'));
    assert.ok(html.includes('wizard-step-4'));
  });

  it('wizard step 2 has key generation form', () => {
    assert.ok(html.includes('wizard-key-label'));
    assert.ok(html.includes('wizardCreateKey'));
  });

  it('wizard step 3 has curl command area', () => {
    assert.ok(html.includes('wizard-curl'));
  });

  it('wizard step 4 links to Receipts tab', () => {
    assert.ok(html.includes("data-tab=receipts"));
  });
});

// ===========================================================================
// Keys Management UI (P3.3)
// ===========================================================================

describe('W3E-02 — Keys Management UI (P3.3)', () => {
  const html = getDashboardHtml();

  it('has keys table container', () => {
    assert.ok(html.includes('id="keys-table"'));
  });

  it('has new key creation form', () => {
    assert.ok(html.includes('new-key-label'));
    assert.ok(html.includes('new-key-role'));
    assert.ok(html.includes('createNewKey'));
  });

  it('has revoke and rotate JavaScript functions', () => {
    assert.ok(html.includes('revokeKey'));
    assert.ok(html.includes('rotateKey'));
  });

  it('key role selector has MEMBER/ADMIN/VIEWER options', () => {
    assert.ok(html.includes('value="MEMBER"'));
    assert.ok(html.includes('value="ADMIN"'));
    assert.ok(html.includes('value="VIEWER"'));
  });
});

// ===========================================================================
// Login page — email/password + signup (P3.1 UI)
// ===========================================================================

import { getLoginHtml } from '../../src/dashboard/login.js';

describe('W3E-02 — Login page with email/password + signup (P3.1 UI)', () => {
  const html = getLoginHtml();

  it('has email login form', () => {
    assert.ok(html.includes('email-login-form'));
    assert.ok(html.includes('email-input'));
    assert.ok(html.includes('password-input'));
  });

  it('has signup form', () => {
    assert.ok(html.includes('signup-form'));
    assert.ok(html.includes('signup-name'));
    assert.ok(html.includes('signup-email'));
    assert.ok(html.includes('signup-password'));
    assert.ok(html.includes('signup-org'));
  });

  it('has token login form (backward compat)', () => {
    assert.ok(html.includes('token-input'));
    assert.ok(html.includes('handleLogin'));
  });

  it('has panel switching functions', () => {
    assert.ok(html.includes('showSignup'));
    assert.ok(html.includes('showLogin'));
    assert.ok(html.includes('showTokenLogin'));
  });

  it('signup form calls POST /signup', () => {
    assert.ok(html.includes("fetch('/signup'"));
  });

  it('email login form calls POST /login', () => {
    assert.ok(html.includes("fetch('/login'"));
  });

  it('has "Create an account" link', () => {
    assert.ok(html.includes('Create an account'));
  });
});

// ===========================================================================
// First Receipt E2E flow (P3.4)
// ===========================================================================

describe('W3E-02 — First Receipt E2E flow (P3.4)', () => {
  const html = getDashboardHtml();

  it('wizard generates curl command with /v1/receipts endpoint', () => {
    assert.ok(html.includes('/v1/receipts'));
  });

  it('curl command includes Authorization header', () => {
    assert.ok(html.includes('Authorization'));
  });

  it('wizard tracks completion via steps', () => {
    assert.ok(html.includes('wizardNext'));
  });
});
