/**
 * FeatureFlagService — per-tenant feature toggles runtime (NEW-6.01)
 *
 * Provides a lightweight in-memory feature flag store with:
 *   - Global defaults per flag (enabled/disabled for all tenants)
 *   - Per-tenant overrides (override the global default for a specific tenant)
 *   - Admin CRUD API (GET/PUT/DELETE via routes.ts)
 *
 * Design:
 *   - In-memory only (no persistence): flags reset on restart.
 *     Persistence via external config (env vars or database) is a post-RC2 concern.
 *   - Thread-safe: single-process Map access is synchronous and safe.
 *   - Flag keys are lowercase dot-separated strings (e.g. "zk.proof.enabled").
 *
 * Valid keys match `^[a-z][a-z0-9._-]{1,62}$` (2 to 63 characters). The objects returned by the methods are the
 * stored ones, not copies.
 *
 * @module src/features/FeatureFlagService
 * @since Wave 6 (NEW-6.01)
 */

/** One feature flag with its global default and per-tenant overrides. */
export interface FeatureFlag {
  /** Flag key (see the key rule in the module comment). */
  key: string;
  enabled: boolean;               // global default
  description?: string;
  overrides?: Record<string, boolean>; // tenantId → override value
  /** Creation time, ISO 8601. */
  createdAt: string;
  /** Last change, ISO 8601. */
  updatedAt: string;
}

/** Effective value of a flag for one tenant and where it came from. */
export interface FlagDecision {
  key: string;
  enabled: boolean;
  /** `override` (tenant value), `global` (flag default) or `default` (unknown flag, false). */
  source: 'override' | 'global' | 'default';
}

const FLAG_KEY_RE = /^[a-z][a-z0-9._-]{1,62}$/;

function now(): string {
  return new Date().toISOString();
}

/** In-memory store and evaluator of feature flags. */
export class FeatureFlagService {
  private readonly _flags = new Map<string, FeatureFlag>();

  /**
   * Set or update a flag's global default.
   * Creates the flag if it does not exist.
   *
   * Existing overrides and creation time are kept; the description is kept when `description` is undefined.
   *
   * @param key - Flag key.
   * @param enabled - New global default.
   * @param description - Optional description.
   * @returns The stored flag.
   * @throws {Error} When the key is invalid.
   */
  upsert(key: string, enabled: boolean, description?: string): FeatureFlag {
    if (!FLAG_KEY_RE.test(key)) {
      throw new Error(`Invalid flag key "${key}". Use lowercase dot-separated alphanumeric (e.g. "zk.proof.enabled").`);
    }
    const existing = this._flags.get(key);
    const flag: FeatureFlag = {
      key,
      enabled,
      description: description ?? existing?.description,
      overrides: existing?.overrides ?? {},
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this._flags.set(key, flag);
    return flag;
  }

  /**
   * Set a per-tenant override.
   * Creates the global flag with enabled=false if it does not exist yet.
   *
   * @param key - Flag key.
   * @param tenantId - Tenant the override applies to.
   * @param enabled - Value for that tenant.
   * @returns The stored flag.
   * @throws {Error} When the key is invalid or `tenantId` is empty.
   */
  setOverride(key: string, tenantId: string, enabled: boolean): FeatureFlag {
    if (!FLAG_KEY_RE.test(key)) {
      throw new Error(`Invalid flag key "${key}".`);
    }
    if (!tenantId) throw new Error('tenantId is required');

    let flag = this._flags.get(key);
    if (!flag) {
      flag = {
        key,
        enabled: false,
        overrides: {},
        createdAt: now(),
        updatedAt: now(),
      };
    }
    flag.overrides = { ...(flag.overrides ?? {}), [tenantId]: enabled };
    flag.updatedAt = now();
    this._flags.set(key, flag);
    return flag;
  }

  /**
   * Remove a per-tenant override, falling back to global default.
   *
   * @param key - Flag key.
   * @param tenantId - Tenant whose override is removed.
   * @returns True when an override existed and was removed.
   */
  clearOverride(key: string, tenantId: string): boolean {
    const flag = this._flags.get(key);
    if (!flag?.overrides) return false;
    const had = Object.prototype.hasOwnProperty.call(flag.overrides, tenantId);
    if (had) {
      delete flag.overrides[tenantId];
      flag.updatedAt = now();
    }
    return had;
  }

  /**
   * Delete a flag entirely.
   *
   * @param key - Flag key.
   * @returns True when the flag existed.
   */
  delete(key: string): boolean {
    return this._flags.delete(key);
  }

  /**
   * Evaluate a flag for a given tenant.
   * Returns the effective enabled value and its source.
   *
   * @param key - Flag key.
   * @param tenantId - Tenant; without it only the global default applies.
   * @returns The decision (an unknown flag is disabled, source `default`).
   */
  evaluate(key: string, tenantId?: string): FlagDecision {
    const flag = this._flags.get(key);
    if (!flag) {
      return { key, enabled: false, source: 'default' };
    }
    if (tenantId && flag.overrides && Object.prototype.hasOwnProperty.call(flag.overrides, tenantId)) {
      return { key, enabled: flag.overrides[tenantId], source: 'override' };
    }
    return { key, enabled: flag.enabled, source: 'global' };
  }

  /**
   * Convenience: returns true if the flag is enabled for the given tenant.
   *
   * @param key - Flag key.
   * @param tenantId - Tenant, optional.
   * @returns The effective value.
   */
  isEnabled(key: string, tenantId?: string): boolean {
    return this.evaluate(key, tenantId).enabled;
  }

  /**
   * List all flags.
   *
   * @returns Every flag, sorted by key.
   */
  list(): FeatureFlag[] {
    return Array.from(this._flags.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Get a single flag by key.
   *
   * @param key - Flag key.
   * @returns The flag, or undefined when unknown.
   */
  get(key: string): FeatureFlag | undefined {
    return this._flags.get(key);
  }

  /**
   * Total flag count.
   *
   * @returns Number of flags.
   */
  get size(): number {
    return this._flags.size;
  }

  /** Reset all flags (for tests). */
  reset(): void {
    this._flags.clear();
  }
}

// Process-level singleton — lazy initialization to avoid module-load side effects
// and ensure tests can import without triggering state creation.
let _service: FeatureFlagService | undefined;
/**
 * Returns the process-wide flag service, creating it on first call.
 *
 * @returns The shared service.
 */
export function getFeatureFlagService(): FeatureFlagService {
  if (!_service) _service = new FeatureFlagService();
  return _service;
}

/**
 * Destroy the singleton so the next call to getFeatureFlagService() returns a
 * fresh instance. Use this in test teardown when you need a fully clean state.
 * Note: if you only want to clear the flag map on the current instance, call
 * getFeatureFlagService().reset() instead.
 */
export function resetFeatureFlagServiceForTest(): void {
  _service = undefined;
}
