/**
 * Email templates — HTML/text generators for system emails (NEW-3.07)
 *
 * Each function returns { subject, html, text } for an EmailMessage.
 * Templates are minimal and self-contained — no external templating engine.
 *
 * @module email/templates
 * @since Wave 3C (PACK 3C-02)
 */

import { escapeHtml } from '../dashboard/sanitize.js';

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

/** API key created notification. */
export function keyCreatedTemplate(params: { keyId: string; label: string; tenantId: string }): EmailTemplate {
  return {
    subject: `[OTK] API key created: ${params.label}`,
    html: `<p>A new API key <strong>${escapeHtml(params.label)}</strong> (${escapeHtml(params.keyId)}) was created for tenant <code>${escapeHtml(params.tenantId)}</code>.</p>`,
    text: `A new API key "${params.label}" (${params.keyId}) was created for tenant ${params.tenantId}.`,
  };
}

/** API key revoked notification. */
export function keyRevokedTemplate(params: { keyId: string; tenantId: string }): EmailTemplate {
  return {
    subject: `[OTK] API key revoked: ${params.keyId}`,
    html: `<p>API key <code>${escapeHtml(params.keyId)}</code> was revoked for tenant <code>${escapeHtml(params.tenantId)}</code>.</p>`,
    text: `API key ${params.keyId} was revoked for tenant ${params.tenantId}.`,
  };
}

/** API key rotated notification. */
export function keyRotatedTemplate(params: { oldKeyId: string; newKeyId: string; tenantId: string }): EmailTemplate {
  return {
    subject: `[OTK] API key rotated`,
    html: `<p>API key <code>${escapeHtml(params.oldKeyId)}</code> was rotated. New key: <code>${escapeHtml(params.newKeyId)}</code> for tenant <code>${escapeHtml(params.tenantId)}</code>.</p>`,
    text: `API key ${params.oldKeyId} was rotated. New key: ${params.newKeyId} for tenant ${params.tenantId}.`,
  };
}

/** Welcome email for new user registration (with verification link). */
export function welcomeTemplate(params: { name: string; orgName: string; verifyToken?: string }): EmailTemplate {
  const verifySection = params.verifyToken
    ? `<p>Verify your email: <a href="/verify-email?token=${escapeHtml(params.verifyToken)}">Click here</a></p>`
    : '';
  const verifyText = params.verifyToken
    ? `\nVerify your email: /verify-email?token=${params.verifyToken}`
    : '';
  return {
    subject: `Welcome to OTK — ${params.orgName}`,
    html: `<p>Hi ${escapeHtml(params.name)},</p><p>Welcome to OTK zk-Metering! Your organization <strong>${escapeHtml(params.orgName)}</strong> is ready.</p>${verifySection}`,
    text: `Hi ${params.name}, Welcome to OTK zk-Metering! Your organization ${params.orgName} is ready.${verifyText}`,
  };
}
