/**
 * Demo Seed Script — popula o dashboard com dados realistas de AI usage
 * Uso: tsx scripts/seed_demo.ts
 *
 * English summary: fills a locally running OTK API (fixed base URL on local port 8787) with demo receipts for the
 * last 7 days (fixed daily counts, three fake tenants, five provider/model profiles with random jitter). It first
 * promotes the tenants and `default` to the PRO plan through the admin route, using the `OTK_ADMIN_KEY` variable
 * (default: a public demo value). Writes only through the API; exits with code 1 when the server's health route
 * does not answer. Demo data only: every token and tenant here is fake.
 *
 * @module scripts/seed_demo
 */

const BASE = 'http://localhost:8787';
const ADMIN_KEY = process.env['OTK_ADMIN_KEY'] ?? 'demo-otk-2026';

const PROVIDERS = [
  { provider: 'openai',    model: 'gpt-4o',              inputTokens: 1200, outputTokens: 800,  costUnits: 120, latencyMs: 820,  costUsd: 0.024 },
  { provider: 'openai',    model: 'gpt-4o-mini',          inputTokens: 900,  outputTokens: 400,  costUnits: 18,  latencyMs: 310,  costUsd: 0.0009 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6',    inputTokens: 1500, outputTokens: 900,  costUnits: 95,  latencyMs: 740,  costUsd: 0.019 },
  { provider: 'anthropic', model: 'claude-haiku-4-5',     inputTokens: 600,  outputTokens: 300,  costUnits: 12,  latencyMs: 190,  costUsd: 0.0005 },
  { provider: 'google',    model: 'gemini-1.5-pro',       inputTokens: 1100, outputTokens: 700,  costUnits: 85,  latencyMs: 650,  costUsd: 0.017 },
];

const TENANTS = [
  { tenantId: 'acme-corp',    label: 'ACME Corp',    token: 'token-acme' },
  { tenantId: 'startup-xyz',  label: 'Startup XYZ',  token: 'token-startup' },
  { tenantId: 'demo-tenant',  label: 'Demo Tenant',  token: 'token-demo' },
];

// When auth is disabled, all requests are attributed to 'default' for rate-limiting purposes.
// We must assign PRO to 'default' as well.
const ALL_PLAN_TENANTS = [...TENANTS.map(t => t.tenantId), 'default'];

// Gera receipts dos últimos 7 dias
const now = Date.now();
const DAYS = 7;
const dailyCounts = [12, 18, 22, 31, 27, 19, 25]; // crescimento realista

let totalPosted = 0;

async function assignPro(tenantId: string): Promise<void> {
  const res = await fetch(`${BASE}/admin/plans/assign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': ADMIN_KEY,
    },
    body: JSON.stringify({ tenantId, tier: 'PRO' }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`WARN: plan assign failed for ${tenantId}: ${res.status} — ${err.slice(0, 80)}`);
  }
}

async function postReceipt(body: object, token: string): Promise<void> {
  const res = await fetch(`${BASE}/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`FAIL: ${res.status} — ${err.slice(0, 100)}`);
  } else {
    totalPosted++;
  }
}

async function main() {
  console.log('OTK Demo Seed — populando dashboard...\n');

  // Verificar servidor
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error('Servidor não está rodando em', BASE);
    console.error('Execute: OTK_ADMIN_KEY=demo-otk-2026 OTK_JWT_SECRET=demo-secret-2026 tsx src/api/server.ts');
    process.exit(1);
  }
  console.log('✓ Servidor OK\n');

  // Promover todos os tenants para PRO (sem rate limit restritivo)
  // Inclui 'default' porque com auth desabilitado, todos os requests são atribuídos a 'default'
  console.log('Promovendo tenants para PRO tier...');
  for (const tid of ALL_PLAN_TENANTS) {
    await assignPro(tid);
    console.log(`  ✓ ${tid} → PRO`);
  }
  console.log();

  // Postar receipts por dia
  for (let d = DAYS - 1; d >= 0; d--) {
    const dayMs = now - d * 86_400_000;
    const count = dailyCounts[DAYS - 1 - d];
    const dateStr = new Date(dayMs).toISOString().slice(0, 10);

    const batch: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      const p = PROVIDERS[i % PROVIDERS.length];
      const tenant = TENANTS[i % TENANTS.length];
      const timestamp = dayMs + Math.floor(Math.random() * 86_400_000);

      batch.push(postReceipt({
        requestId: `seed-${d}-${i}-${Math.random().toString(36).slice(2)}`,
        provider: p.provider,
        model: p.model,
        inputTokens: p.inputTokens + Math.floor(Math.random() * 200),
        outputTokens: p.outputTokens + Math.floor(Math.random() * 100),
        costUnits: p.costUnits,
        latencyMs: p.latencyMs + Math.floor(Math.random() * 100),
        timestamp,
        tenantId: tenant.tenantId,
        userId: String(1000 + (i % 5)),
        metadata: { tags: [p.provider, 'seed'] },
      }, tenant.token));
    }

    // Enviar em batches de 10 para não sobrecarregar
    for (let b = 0; b < batch.length; b += 10) {
      await Promise.all(batch.slice(b, b + 10));
    }
    console.log(`  ${dateStr}: ${count} receipts postados`);
  }

  console.log(`\n✓ Total: ${totalPosted} receipts inseridos`);
  console.log(`\nAbra: http://localhost:8787/app`);
  console.log(`      http://localhost:8787/analytics`);
  console.log(`      http://localhost:8787/demo`);
}

main().catch(console.error);
