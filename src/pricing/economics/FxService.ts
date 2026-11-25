/**
 * U3.2 — FX Conversion (USD ↔ BRL)
 *
 * Deterministic conversion with a fixed rate (no external API).
 * Rate must be injected at construction — no hidden global state.
 * Use a snapshot rate for reproducible dissertation experiments.
 *
 * Floating-point amounts; no rounding is applied.
 *
 * @module src/pricing/economics/FxService
 */

/** Converts between USD and BRL with one fixed rate. */
export class FxService {
  /**
   * Fixes the conversion rate.
   *
   * @param usdToBrlRate - BRL per 1 USD (> 0).
   * @throws {Error} When the rate is not greater than 0.
   */
  constructor(private readonly usdToBrlRate: number) {
    if (usdToBrlRate <= 0) {
      throw new Error(`FxService: invalid rate ${usdToBrlRate} — must be > 0`);
    }
  }

  /**
   * Converts USD to BRL.
   *
   * @param usd - Amount in USD.
   * @returns Amount in BRL.
   */
  usdToBrl(usd: number): number {
    return usd * this.usdToBrlRate;
  }

  /**
   * Converts BRL to USD.
   *
   * @param brl - Amount in BRL.
   * @returns Amount in USD.
   */
  brlToUsd(brl: number): number {
    return brl / this.usdToBrlRate;
  }

  /**
   * The fixed rate.
   *
   * @returns BRL per 1 USD.
   */
  getRate(): number {
    return this.usdToBrlRate;
  }
}
