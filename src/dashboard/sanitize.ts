/**
 * H6.1 — XSS Prevention
 *
 * HTML escaping for all user-generated content in dashboard templates.
 *
 * @module dashboard/sanitize
 * @since Wave 2H (H6.1)
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

const ESCAPE_RE = /[&<>"'/]/g;

/**
 * Escape HTML special characters to prevent XSS.
 * Safe for use in HTML content, attribute values, and script contexts.
 */
export function escapeHtml(s: string): string {
  return s.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}
