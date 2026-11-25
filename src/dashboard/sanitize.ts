/**
 * H6.1 — XSS Prevention
 *
 * HTML escaping for all user-generated content in dashboard templates.
 *
 * Used by the dashboard HTML pages, by the e-mail HTML bodies of the Stripe webhook handler and by the data
 * export e-mail in `src/api/gdpr.ts`. It escapes text; it does NOT sanitize HTML (any tag becomes text) and does
 * NOT make a string safe inside a URL scheme such as `javascript:`.
 *
 * @module src/dashboard/sanitize
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
 *
 * Escapes `& < > " ' /`.
 *
 * @param s - Untrusted text.
 * @returns The escaped text.
 * @example
 * escapeHtml('<b>"x"</b>'); // '&lt;b&gt;&quot;x&quot;&lt;&#x2F;b&gt;'
 */
export function escapeHtml(s: string): string {
  return s.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}
