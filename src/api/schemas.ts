/**
 * H1.4 — Input Validation Schemas (Zod)
 *
 * Zod schemas for all POST/PUT endpoint bodies.
 * Each schema matches the current manual validation + coercion behavior
 * to ensure zero backward-incompatible changes.
 *
 * @module api/schemas
 * @since Wave 2H (H1.4)
 */

import { z } from 'zod';
import { tenantTokenWeakness } from '../security/tokenStrength.js';

// ── Helper: accept string or number, coerce to string for BigInt conversion ──
const bigintCoerce = z.union([z.string(), z.number()]).transform(v => String(v));

/**
 * POST /receipts body schema.
 * Matches RawReceipt fields with the same coercion the manual code did.
 */
export const ReceiptSubmissionSchema = z.object({
  requestId: z.string().min(1).max(256),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUnits: z.number().nonnegative().optional().default(0),
  latencyMs: z.number().nonnegative().optional().default(0),
  timestamp: z.number().int().positive().optional(),
  userId: bigintCoerce.optional().default('0'),
  nonce: bigintCoerce.optional().default('0'),
  tenantId: z.string().max(128).optional(),
  cwVersion: z.string().max(64).optional(),
  metadata: z.object({
    sessionId: z.string().optional(),
    endpoint: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
}).strip();

export type ReceiptSubmission = z.infer<typeof ReceiptSubmissionSchema>;

/**
 * POST /admin/tenants body schema.
 */
/**
 * H1-S06 (SEC02-N02): minimum length of a tenant token registered through the API (POST/PUT /admin/tenants). The token
 * is a bearer secret accepted by the MITM proxy, which spends the operator's provider keys; a short token can be guessed.
 * Applies to new registrations only: tokens already in OTK_TENANTS or in the tenant log keep working.
 */
export const MIN_TENANT_TOKEN_LENGTH = 24;
const tenantTokenSchema = z.string().trim()
  .min(MIN_TENANT_TOKEN_LENGTH, `token must have at least ${MIN_TENANT_TOKEN_LENGTH} characters`).max(512)
  // H1 lane B (S06 residual): long enough is not enough; repeated, sequential or low-entropy tokens are refused
  .superRefine((t, ctx) => {
    if (t.length < MIN_TENANT_TOKEN_LENGTH) return; // already reported by min()
    const weakness = tenantTokenWeakness(t);
    if (weakness) ctx.addIssue({ code: z.ZodIssueCode.custom, message: weakness });
  });

export const TenantCreateSchema = z.object({
  tenantId: z.string().min(1).max(128),
  token: tenantTokenSchema,
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']).optional(),
}).strip();

export type TenantCreate = z.infer<typeof TenantCreateSchema>;

/**
 * PUT /admin/tenants/:id body schema.
 */
export const TenantUpdateSchema = z.object({
  token: tenantTokenSchema.optional(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']).optional(),
  /** H1-S04: true reactivates a deactivated tenant (old JWTs/refresh tokens stay invalid); false deactivates it */
  active: z.boolean().optional(),
  /** H1 lane B, POLICY PENDING (D4): with active=true, restore the dynamic keys minted before the deactivation */
  restoreKeys: z.boolean().optional(),
}).strip();

export type TenantUpdate = z.infer<typeof TenantUpdateSchema>;

/**
 * POST /admin/plans/assign body schema.
 */
export const PlanAssignmentSchema = z.object({
  tenantId: z.string().min(1),
  tier: z.enum(['FREE', 'STARTER', 'PRO']),
}).strip();

export type PlanAssignment = z.infer<typeof PlanAssignmentSchema>;

/**
 * POST /admin/tenants/reload body schema.
 */
export const TenantsReloadSchema = z.object({
  tenants: z.string(), // empty string is valid (disables auth)
}).strip();

/**
 * POST /v1/keys body schema (NEW-3.06).
 */
export const ApiKeyCreateSchema = z.object({
  label: z.string().min(1).max(100),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']).optional().default('MEMBER'),
  expiresAt: z.string().datetime().optional(),
}).strip();

export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

export type TenantsReload = z.infer<typeof TenantsReloadSchema>;

/**
 * POST /signup body schema (P3.1, Wave 3E).
 */
export const SignupSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  orgName: z.string().min(1).max(100),
}).strip();

export type SignupInput = z.infer<typeof SignupSchema>;

/**
 * POST /login body schema (P3.1, Wave 3E).
 */
export const LoginSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(1).max(128),
}).strip();

export type LoginInput = z.infer<typeof LoginSchema>;

/**
 * POST /verify-email body schema (P3.1, Wave 3E).
 */
export const VerifyEmailSchema = z.object({
  token: z.string().min(1),
}).strip();

export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

/**
 * POST /v1/webhooks body schema (SEC-12).
 */
export const WebhookCreateSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1).max(64)).optional().default(['*']),
}).strip();

export type WebhookCreate = z.infer<typeof WebhookCreateSchema>;

/**
 * POST /admin/flags body schema (SEC-12).
 */
export const FeatureFlagUpsertSchema = z.object({
  key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/, 'key must be alphanumeric with _ . -'),
  enabled: z.boolean(),
  description: z.string().max(256).optional(),
}).strip();

export type FeatureFlagUpsert = z.infer<typeof FeatureFlagUpsertSchema>;
