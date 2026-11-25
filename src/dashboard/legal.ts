/**
 * P4.4 + NEW-5.02 — Legal pages: Terms of Service, Privacy Policy, DPA (W5-5C02)
 *
 * Serves static HTML pages for legal/compliance documents.
 * Content is placeholder text — must be replaced by legal counsel before production.
 *
 * Routes (wired into routes.ts):
 *   GET /terms   — Terms of Service
 *   GET /privacy — Privacy Policy
 *   GET /dpa     — Data Processing Agreement
 *
 * The page bodies are fixed strings inserted without escaping (they contain no user input); the GA readiness
 * check in `src/api/gaReadinessCheck.ts` also refers to these renderers. No request data is read.
 *
 * @module src/dashboard/legal
 * @since Wave 5 (W5-5C02 / P4.4 + NEW-5.02)
 */

// Shared page shell; `title`, `heading` and `sections` must be trusted text because they are not escaped.
function legalPage(title: string, heading: string, sections: Array<{ h: string; body: string }>): string {
  const content = sections.map(s =>
    `<section><h2>${s.h}</h2><p>${s.body}</p></section>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OTK — ${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f14;color:#e8eef6;min-height:100vh;line-height:1.65}
  header{padding:16px 24px;border-bottom:1px solid #1c2430;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.1rem;font-weight:600}
  .nav-links{display:flex;gap:16px}
  .nav-links a{color:#7db7ff;text-decoration:none;font-size:0.85rem}
  .nav-links a:hover{text-decoration:underline}
  main{padding:40px 24px;max-width:760px;margin:0 auto}
  h1.doc-title{font-size:1.6rem;font-weight:700;margin-bottom:8px}
  .doc-meta{font-size:0.78rem;color:#7b8fa8;margin-bottom:32px}
  .placeholder-notice{background:#1a2540;border:1px solid #2563eb;color:#7db7ff;padding:12px 16px;border-radius:8px;font-size:0.82rem;margin-bottom:32px}
  section{margin-bottom:28px}
  h2{font-size:1rem;font-weight:600;margin-bottom:8px;color:#e8eef6}
  p{font-size:0.88rem;color:#b4c2d4}
  .legal-links{display:flex;gap:16px;margin-top:32px;padding-top:20px;border-top:1px solid #1c2430}
  .legal-links a{color:#7db7ff;text-decoration:none;font-size:0.82rem}
  .legal-links a:hover{text-decoration:underline}
</style>
</head>
<body>
<header>
  <h1>OTK zk-Metering</h1>
  <div class="nav-links"><a href="/app">Dashboard</a><a href="/pricing">Pricing</a></div>
</header>
<main>
  <h1 class="doc-title">${heading}</h1>
  <div class="doc-meta">Effective: 2026-04-01 | Version 1.0</div>
  <div class="placeholder-notice">
    <strong>Placeholder document.</strong> This content has not been reviewed by legal counsel.
    Replace with your organization's finalized legal text before production use.
  </div>
  ${content}
  <div class="legal-links">
    <a href="/terms">Terms of Service</a>
    <a href="/privacy">Privacy Policy</a>
    <a href="/dpa">Data Processing Agreement</a>
  </div>
</main>
</body>
</html>`;
}

/**
 * Renders the Terms of Service page (placeholder text).
 *
 * @returns A complete HTML document.
 */
export function renderTermsPage(): string {
  return legalPage('Terms of Service', 'Terms of Service', [
    {
      h: '1. Acceptance of Terms',
      body: 'By accessing or using the OTK zk-Metering platform ("Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service.',
    },
    {
      h: '2. Service Description',
      body: 'OTK zk-Metering provides privacy-preserving compute-unit metering for AI workloads using zero-knowledge proofs. The Service is provided "as is" subject to the service level agreements defined per plan tier.',
    },
    {
      h: '3. Acceptable Use',
      body: 'You may use the Service only for lawful purposes and in accordance with these Terms. You agree not to use the Service to process unlawful content, circumvent access controls, or engage in activities that disrupt or impair the Service.',
    },
    {
      h: '4. Privacy and Data',
      body: 'Your use of the Service is subject to our Privacy Policy. By using the Service you consent to the collection and use of information as described therein. ZK receipts are cryptographically anonymized by design.',
    },
    {
      h: '5. Service Level Agreements',
      body: 'SLA commitments are tier-specific: FREE (best-effort), STARTER (99.0% uptime, p99 < 3 s), PRO (99.9% uptime, p99 < 1 s). Uptime is measured monthly. Credits are the sole remedy for SLA breaches.',
    },
    {
      h: '6. Limitation of Liability',
      body: 'To the maximum extent permitted by law, OTK shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the Service.',
    },
    {
      h: '7. Governing Law',
      body: 'These Terms are governed by the laws of Brazil. Any disputes shall be submitted to the competent courts of São Paulo, SP, Brazil.',
    },
  ]);
}

/**
 * Renders the Privacy Policy page (placeholder text).
 *
 * @returns A complete HTML document.
 */
export function renderPrivacyPage(): string {
  return legalPage('Privacy Policy', 'Privacy Policy', [
    {
      h: '1. Data We Collect',
      body: 'We collect: account information (email, organization name), usage metadata (request counts, CU consumption per epoch), and technical logs (IP addresses, timestamps). ZK proof inputs are never transmitted to our servers — all proving occurs client-side.',
    },
    {
      h: '2. How We Use Your Data',
      body: 'Usage data is used to enforce plan quotas, generate invoices, and improve the Service. We do not sell personal data to third parties.',
    },
    {
      h: '3. Data Retention',
      body: 'Receipt metadata is retained for 90 days by default (configurable via OTK_RECEIPT_RETENTION_DAYS). Account data is retained for the lifetime of your account plus 30 days after deletion.',
    },
    {
      h: '4. Your Rights (LGPD / GDPR)',
      body: 'You have the right to access, rectify, or erase your personal data. Submit requests to the data export endpoint (POST /v1/data/export) or contact our DPO. Erasure requests are honored within 30 days via cryptographic tombstoning.',
    },
    {
      h: '5. Security',
      body: 'Data in transit is protected by TLS 1.2+. Data at rest uses AES-256 encryption. ZK receipts are Groth16-verified — the system cannot reconstruct usage from proofs alone.',
    },
    {
      h: '6. Contact',
      body: 'For privacy inquiries, contact: privacy@otk-metering.io. DPO: Appointed per LGPD Art. 41.',
    },
  ]);
}

/**
 * Renders the Data Processing Agreement page (placeholder text).
 *
 * @returns A complete HTML document.
 */
export function renderDpaPage(): string {
  return legalPage('Data Processing Agreement', 'Data Processing Agreement (DPA)', [
    {
      h: '1. Parties',
      body: 'This DPA is between the customer ("Controller") and OTK Metering Ltda. ("Processor"). It supplements the Terms of Service and governs the processing of personal data on behalf of the Controller.',
    },
    {
      h: '2. Subject Matter and Duration',
      body: 'The Processor will process personal data as specified in Annex I for the duration of the Terms of Service. Processing ceases upon termination of the agreement.',
    },
    {
      h: '3. Nature and Purpose of Processing',
      body: 'Purpose: providing the OTK zk-Metering service including quota enforcement, billing, and audit logging. Categories of data subjects: end users of the Controller\'s applications. Categories of personal data: usage metadata, tenant identifiers.',
    },
    {
      h: '4. Obligations of the Processor',
      body: 'The Processor shall: (a) process data only on Controller\'s documented instructions; (b) ensure personnel are committed to confidentiality; (c) implement appropriate technical and organizational security measures; (d) not engage sub-processors without prior authorization.',
    },
    {
      h: '5. Sub-processors',
      body: 'Current sub-processors: PostgreSQL hosting (infrastructure), Redis Cloud (caching). Controller will be notified of sub-processor changes with 30 days prior notice.',
    },
    {
      h: '6. Data Subject Rights',
      body: 'The Processor will assist the Controller in fulfilling data subject requests (access, rectification, erasure, portability) within 5 business days of notification.',
    },
    {
      h: '7. International Transfers',
      body: 'Personal data will be processed in Brazil. Any transfer outside Brazil will be subject to appropriate safeguards including Standard Contractual Clauses where required.',
    },
  ]);
}
