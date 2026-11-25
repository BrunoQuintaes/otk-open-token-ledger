/**
 * E4.5 — ProxySlice Dual-Mode Controller (Wave 3A Pack 05)
 *
 * Controls whether the proxy operates in direct, mediated, or auto mode.
 * Mode is read from OTK_PROXY_MODE env var at startup; can be overridden
 * at runtime via setProxyMode() (e.g., in tests or admin endpoint).
 *
 * Modes:
 * - 'direct'   : request flows straight through to upstream (no mediation logic)
 * - 'mediated' : request goes through OTK receipt creation + rate-limiting
 * - 'auto'     : mediated when auth is enabled, direct otherwise
 *
 * Environment variable read: `OTK_PROXY_MODE`, once at module load (and again by
 * `resetProxyModeForTest`). Its value is cast, not validated. The mode is reported by the proxy's
 * `/health` answer and by `src/api/routes.ts`; this module does not itself change how requests are handled.
 *
 * @module proxy/ProxySlice
 * @since Wave 3A (Pack 05)
 */

/**
 * Proxy operating mode: `direct`, `mediated` or `auto` (see the file header).
 */
export type ProxyMode = 'direct' | 'mediated' | 'auto';

let _mode: ProxyMode =
  (process.env['OTK_PROXY_MODE'] as ProxyMode | undefined) ?? 'direct';

/**
 * Returns the current proxy mode.
 *
 * @returns The mode last set (module-level state shared by the whole process).
 */
export function getProxyMode(): ProxyMode {
  return _mode;
}

/**
 * Sets the proxy mode (runtime override, useful for tests or admin API).
 *
 * @param mode - New mode; it applies process-wide until changed again.
 */
export function setProxyMode(mode: ProxyMode): void {
  _mode = mode;
}

/** Reset to default (reads env again). Used in tests. */
export function resetProxyModeForTest(): void {
  _mode = (process.env['OTK_PROXY_MODE'] as ProxyMode | undefined) ?? 'direct';
}
