#!/usr/bin/env node
/**
 * U3.5 — Scenario Analysis Runner
 *
 * Generates Light/Normal/Heavy scenarios for N users across providers,
 * plus break-even analysis. Pure JS math (no compilation needed).
 *
 * Usage:
 *   node scripts/ops/run_scenario_analysis.mjs [users] [fixedCostUsd] [fxRate] [markup]
 *
 * Defaults: 10000 users, $5000 fixed cost/month, R$ 5.80/USD, 40% markup
 *
 * Prices in the table below are USD per 1,000 tokens (input / output) and are a static copy, not read from
 * src/pricing; a month is 30 days. A missing, zero or non-numeric argument falls back to its default.
 * It only prints to stdout and writes no file.
 *
 * @since U3.5
 * @module scripts/ops/run_scenario_analysis
 */

const users        = Number(process.argv[2]) || 10_000;
const fixedCostUsd = Number(process.argv[3]) || 5_000;
const fxRate       = Number(process.argv[4]) || 5.80;
const markupPct    = Number(process.argv[5]) || 40;

// ── Price table (mirrors ProviderPriceTable.ts) ──────────────────────────────
const PRICES = {
  "openai/gpt-4o":        { in: 0.005,    out: 0.015   },
  "openai/gpt-3.5-turbo": { in: 0.0005,   out: 0.0015  },
  "anthropic/claude-sonnet-4": { in: 0.003, out: 0.015  },
  "anthropic/claude-haiku-4":  { in: 0.00025, out: 0.00125 },
};

// ── Usage profiles (calls/day, inputTokens/call, outputTokens/call) ──────────
const PROFILES = {
  Light:  { calls: 5,  inputTok: 200,  outputTok: 100  },
  Normal: { calls: 10, inputTok: 700,  outputTok: 300  },
  Heavy:  { calls: 20, inputTok: 2000, outputTok: 1000 },
};

const DAYS = 30;

// ── Core math ────────────────────────────────────────────────────────────────
function calcUsd(provider, inTok, outTok) {
  const p = PRICES[provider];
  return (inTok / 1000) * p.in + (outTok / 1000) * p.out;
}

function calcMargin(costUsd, markup) {
  const price = costUsd * (1 + markup / 100);
  return { costUsd, priceUsd: price, marginUsd: price - costUsd };
}

function breakEven(fixedCost, pricePerUser, varCostPerUser) {
  const contrib = pricePerUser - varCostPerUser;
  if (contrib <= 0) return Infinity;
  return fixedCost / contrib;
}

// ── Table formatting ──────────────────────────────────────────────────────────
const fmt = (n, dec = 2) => n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtBrl = (n) => "R$" + fmt(n);
const fmtUsd = (n) => "$" + fmt(n);

// ── Run scenarios ─────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(72)}`);
console.log(`SCENARIO ANALYSIS — ${users.toLocaleString()} users | ${DAYS} days | ${markupPct}% markup | FX: ${fxRate}`);
console.log(`Fixed cost: ${fmtUsd(fixedCostUsd)}/month`);
console.log("=".repeat(72));

for (const [provKey, price] of Object.entries(PRICES)) {
  console.log(`\n── ${provKey} ──`);
  console.log(
    "Profile".padEnd(8),
    "Cost/user".padStart(12),
    "Price/user".padStart(12),
    "Margin/user".padStart(12),
    "BRL/user".padStart(12),
    "Cost total".padStart(12),
    "Price total".padStart(12),
    "Break-even N*".padStart(15),
  );
  console.log("-".repeat(100));

  for (const [profileName, profile] of Object.entries(PROFILES)) {
    const callsTotal = users * profile.calls * DAYS;
    const inTokTotal  = callsTotal * profile.inputTok;
    const outTokTotal = callsTotal * profile.outputTok;

    const costTotal = calcUsd(provKey, inTokTotal, outTokTotal);
    const m = calcMargin(costTotal, markupPct);

    const costPerUser  = costTotal  / users;
    const pricePerUser = m.priceUsd / users;

    const be = breakEven(fixedCostUsd, pricePerUser, costPerUser);

    console.log(
      profileName.padEnd(8),
      fmtUsd(costPerUser).padStart(12),
      fmtUsd(pricePerUser).padStart(12),
      fmtUsd(pricePerUser - costPerUser).padStart(12),
      fmtBrl(pricePerUser * fxRate).padStart(12),
      fmtUsd(costTotal).padStart(12),
      fmtUsd(m.priceUsd).padStart(12),
      (be === Infinity ? "∞" : Math.ceil(be).toLocaleString() + " users").padStart(15),
    );
  }
}

// ── Break-even summary ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(72)}`);
console.log(`BREAK-EVEN SUMMARY (fixed cost ${fmtUsd(fixedCostUsd)}/month, ${markupPct}% markup)`);
console.log("=".repeat(72));
console.log("Formula: N* = FixedCost / (PricePerUser - VariableCostPerUser)");
console.log();

for (const [provKey] of Object.entries(PRICES)) {
  for (const [profileName, profile] of Object.entries(PROFILES)) {
    const callsPerUser = profile.calls * DAYS;
    const inTok  = callsPerUser * profile.inputTok;
    const outTok = callsPerUser * profile.outputTok;

    const costPerUser  = calcUsd(provKey, inTok, outTok);
    const pricePerUser = costPerUser * (1 + markupPct / 100);
    const contrib      = pricePerUser - costPerUser;
    const be           = Math.ceil(fixedCostUsd / contrib);

    console.log(
      `${provKey} / ${profileName}:`.padEnd(42),
      `contrib ${fmtUsd(contrib)}/user/month →`.padEnd(28),
      `N* = ${be.toLocaleString()} users`
    );
  }
  console.log();
}
