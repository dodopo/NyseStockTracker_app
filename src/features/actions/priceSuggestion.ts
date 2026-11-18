import { Big, DECIMAL_PLACES } from "../../../shared/decimal";
import { conversionFactor, type CurrencyCode, type RateTable } from "../../../shared/currencies";

/**
 * Price offered when a trade is registered without one: the asset's current
 * quote, in the currency paid (converted at today's rate when they differ).
 * Null when there is no quote, or no rate to convert it.
 */
export function suggestPrice(args: {
  quote: number | null | undefined;
  assetCurrency: CurrencyCode;
  tradeCurrency: CurrencyCode;
  live?: RateTable | null;
}): { value: string; converted: boolean } | null {
  const { quote, assetCurrency, tradeCurrency, live } = args;
  if (!quote || !Number.isFinite(quote) || quote <= 0) return null;
  let price = new Big(quote);
  const converted = tradeCurrency !== assetCurrency;
  if (converted) {
    const factor = live ? conversionFactor(assetCurrency, tradeCurrency, live) : null;
    if (!factor) return null;
    price = price.times(factor);
  }
  // up to 8 decimals (what a trade accepts), no trailing zeros
  const value = price.round(DECIMAL_PLACES, Big.roundHalfUp).toFixed().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return new Big(value).gt(0) ? { value, converted } : null;
}
