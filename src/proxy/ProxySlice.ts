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
 * @module proxy/ProxySlice
 * @since Wave 3A (Pack 05)
 */

export type ProxyMode = 'direct' | 'mediated' | 'auto';

let _mode: ProxyMode =
  (process.env['OTK_PROXY_MODE'] as ProxyMode | undefined) ?? 'direct';

/** Returns the current proxy mode. */
export function getProxyMode(): ProxyMode {
  return _mode;
}

/** Sets the proxy mode (runtime override, useful for tests or admin API). */
export function setProxyMode(mode: ProxyMode): void {
  _mode = mode;
}

/** Reset to default (reads env again). Used in tests. */
export function resetProxyModeForTest(): void {
  _mode = (process.env['OTK_PROXY_MODE'] as ProxyMode | undefined) ?? 'direct';
}
