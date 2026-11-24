/**
 * Webhook endpoint management (H1R2 S21-F01) — guarded list/create, NOT wired to the HTTP API.
 *
 * The HTTP routes GET/POST /v1/webhooks answer 501 `webhook_management_disabled` (src/api/routes.ts). This module is
 * the base for enabling them later: every protection the activation needs is here and tested
 * (test/security/h1r2_c4_webhooks_ssrf.test.ts):
 *   - destination validated with the SSRF policy (destinationPolicy.ts) at registration;
 *   - tenant isolation: the tenant always comes from the caller credential, list returns only that tenant's endpoints;
 *   - role: PENDING_HUMAN_POLICY (M24-DYN-09). PROPOSED_WEBHOOK_MANAGER_ROLES is a proposal, not the policy in force;
 *   - limits: endpoints per tenant, event names per endpoint;
 *   - the HMAC signing secret is returned once at creation and never listed.
 *
 * @module webhooks/WebhookManagement
 */

import type { IWebhookStore, WebhookEndpoint } from './WebhookRegistry.js';
import { createWebhookEndpoint } from './WebhookRegistry.js';
import { validateWebhookDestination, WebhookDestinationError, type DestinationPolicyOptions } from './destinationPolicy.js';

/** H1R2 S21-F01: the HTTP list/create routes stay disabled until the role policy is decided. */
export const WEBHOOK_MANAGEMENT_HTTP_ENABLED = false;

/** PENDING_HUMAN_POLICY (M24-DYN-09): proposed minimum roles for webhook management. Not the policy in force. */
export const PROPOSED_WEBHOOK_MANAGER_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN']);

export const MAX_WEBHOOK_ENDPOINTS_PER_TENANT = 10;
export const MAX_WEBHOOK_EVENTS_PER_ENDPOINT = 32;

export interface WebhookCaller { tenantId: string; role: string }

export type PublicWebhookEndpoint = Omit<WebhookEndpoint, 'secret'>;

export type ManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 409 | 422; error: string; detail?: string };

function redact(ep: WebhookEndpoint): PublicWebhookEndpoint {
  const { secret: _secret, ...rest } = ep;
  return rest;
}

function roleAllowed(caller: WebhookCaller): boolean {
  return PROPOSED_WEBHOOK_MANAGER_ROLES.has(String(caller.role).toUpperCase());
}

export async function listWebhookEndpointsForTenant(store: IWebhookStore, caller: WebhookCaller): Promise<ManagementResult<PublicWebhookEndpoint[]>> {
  if (!caller.tenantId) return { ok: false, status: 400, error: 'tenant_context_required' };
  if (!roleAllowed(caller)) return { ok: false, status: 403, error: 'forbidden' };
  const eps = await store.listEndpoints(caller.tenantId);
  return { ok: true, value: eps.filter((e) => e.tenantId === caller.tenantId).map(redact) };
}

export async function registerWebhookEndpoint(
  store: IWebhookStore,
  caller: WebhookCaller,
  input: { url: string; events?: string[] },
  policy: DestinationPolicyOptions = {},
): Promise<ManagementResult<{ endpoint: PublicWebhookEndpoint; secret: string }>> {
  if (!caller.tenantId) return { ok: false, status: 400, error: 'tenant_context_required' };
  if (!roleAllowed(caller)) return { ok: false, status: 403, error: 'forbidden' };
  const events = input.events && input.events.length ? input.events : ['*'];
  if (events.length > MAX_WEBHOOK_EVENTS_PER_ENDPOINT) return { ok: false, status: 400, error: 'too_many_events' };
  const existing = (await store.listEndpoints(caller.tenantId)).filter((e) => e.tenantId === caller.tenantId);
  if (existing.length >= MAX_WEBHOOK_ENDPOINTS_PER_TENANT) return { ok: false, status: 409, error: 'webhook_endpoint_limit_reached' };
  try {
    await validateWebhookDestination(input.url, policy);
  } catch (e) {
    if (e instanceof WebhookDestinationError) return { ok: false, status: 422, error: 'webhook_destination_not_allowed', detail: e.reason };
    throw e;
  }
  const ep = createWebhookEndpoint(caller.tenantId, input.url, events);
  await store.createEndpoint(ep);
  return { ok: true, value: { endpoint: redact(ep), secret: ep.secret } };
}
