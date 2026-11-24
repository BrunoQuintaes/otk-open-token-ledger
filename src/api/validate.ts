/**
 * H1.4 — Body Validation Helper
 *
 * Wraps Zod safeParse into a typed result with field-level error details.
 *
 * @module api/validate
 * @since Wave 2H (H1.4)
 */

import type { ZodSchema } from 'zod';
import type { ErrorDetail } from './errors.js';

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ErrorDetail[] };

export function validateBody<T>(body: unknown, schema: ZodSchema<T>): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map(i => ({
      field: i.path.join('.') || undefined,
      issue: i.message,
    })),
  };
}
