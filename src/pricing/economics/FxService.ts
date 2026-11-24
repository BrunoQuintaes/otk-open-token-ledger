/**
 * U3.2 — FX Conversion (USD ↔ BRL)
 *
 * Deterministic conversion with a fixed rate (no external API).
 * Rate must be injected at construction — no hidden global state.
 * Use a snapshot rate for reproducible dissertation experiments.
 */

export class FxService {
  constructor(private readonly usdToBrlRate: number) {
    if (usdToBrlRate <= 0) {
      throw new Error(`FxService: invalid rate ${usdToBrlRate} — must be > 0`);
    }
  }

  usdToBrl(usd: number): number {
    return usd * this.usdToBrlRate;
  }

  brlToUsd(brl: number): number {
    return brl / this.usdToBrlRate;
  }

  getRate(): number {
    return this.usdToBrlRate;
  }
}
