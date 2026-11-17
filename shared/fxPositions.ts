/**
 * Positions in any currency. Each trade is converted with the PTAX frozen on it
 * (its own date), so the cost in reais, euros or francs is the historical one;
 * only the current price uses today's rate. The P/L in another currency
 * therefore includes the exchange-rate variation, as it really happened.
 */
import { Big } from "./decimal";
import { conversionFactor, isCurrency, type CurrencyCode, type FxSnapshot, type RateTable } from "./currencies";
import { calculatePosition, type Position, type PositionInputTx } from "./positions";

export type FxTrade = PositionInputTx & { currency?: string | null; fx?: FxSnapshot | null };

export type ConvertedTrades<T extends FxTrade = FxTrade> = {
  trades: T[];
  /** Trades converted at today's rate because their PTAX is not known yet. */
  approx: number;
  /** Trades left OUT (no PTAX and no live rate): never counted in the wrong currency. */
  missing: number;
};

/** Trades with prices in `to`. `live` (today's rates) is only a fallback for trades without PTAX. */
export function convertTrades<T extends FxTrade>(trades: T[], assetCurrency: CurrencyCode, to: CurrencyCode, live?: RateTable | null): ConvertedTrades<T> {
  let approx = 0;
  let missing = 0;
  const out: T[] = [];
  for (const t of trades) {
    const from: CurrencyCode = isCurrency(t.currency) ? t.currency : assetCurrency;
    if (from === to) {
      out.push(t);
      continue;
    }
    // The PTAX of the trade's date; else today's rate (approximate, said on screen); else left out.
    let factor: Big | null = t.fx ? conversionFactor(from, to, t.fx.sell) : null;
    if (!factor && live) {
      factor = conversionFactor(from, to, live);
      if (factor) approx++;
    }
    if (!factor) {
      missing++;
      continue;
    }
    out.push({ ...t, price: new Big(t.price).times(factor).toString() });
  }
  return { trades: out, approx, missing };
}

export type FxPosition = Position & {
  currency: CurrencyCode;
  /** Current price in `currency`. */
  currentPrice: number;
  approx: number;
  missing: number;
};

/**
 * Position of one asset shown in `to`. `currentPrice` is in the asset's own
 * currency; it is converted with `live` (today). Without `live`, only `to`
 * equal to the asset's currency is possible (null otherwise).
 */
export function positionIn(
  trades: FxTrade[],
  assetCurrency: CurrencyCode,
  currentPrice: number,
  to: CurrencyCode,
  live?: RateTable | null
): FxPosition | null {
  if (to !== assetCurrency && !live) return null;
  const converted = convertTrades(trades, assetCurrency, to, live);
  const liveFactor = to === assetCurrency ? new Big(1) : conversionFactor(assetCurrency, to, live!);
  if (!liveFactor) return null;
  const priceFactor = Number(liveFactor.toString());
  const price = (Number.isFinite(currentPrice) ? currentPrice : 0) * priceFactor;
  return {
    ...calculatePosition(converted.trades, price),
    currency: to,
    currentPrice: price,
    approx: converted.approx,
    missing: converted.missing,
  };
}
