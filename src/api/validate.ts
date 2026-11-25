/**
 * H1.4 — Body Validation Helper
 *
 * Wraps Zod safeParse into a typed result with field-level error details.
 *
 * Used by `src/api/routes.ts` with the schemas of `src/api/schemas.ts`; the caller turns the issues into a 400 error.
 *
 * @module src/api/validate
 * @since Wave 2H (H1.4)
 */

import type { ZodSchema } from 'zod';
import type { ErrorDetail } from './errors.js';

/** Validation outcome: the parsed data, or the list of field-level issues. */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ErrorDetail[] };

/**
 * Validates a parsed JSON body against a Zod schema without throwing.
 *
 * @param body - The parsed request body (not mutated).
 * @param schema - Zod schema to apply (defaults and transforms of the schema are applied to `data`).
 * @returns `success: true` with the parsed data, or `success: false` with one issue per Zod error (`field` is the
 *   dotted path, absent for root-level errors).
 */
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
