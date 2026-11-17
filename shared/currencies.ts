import { z } from "zod";
import { Big } from "./decimal";
import type { AssetType } from "./assetTypes";

/**
 * Currencies the app knows: of a trade (what was paid), of an asset's quote and
 * of the consolidated view. Rates are kept as "reais per 1 unit" (how the
 * Banco Central publishes PTAX), so BRL is always 1 and any pair is a division.
 */
export const CURRENCIES = ["BRL", "USD", "EUR", "CHF"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Currencies with a PTAX (everything but the real itself). */
export const PTAX_CURRENCIES = ["USD", "EUR", "CHF"] as const;
export type PtaxCurrency = (typeof PTAX_CURRENCIES)[number];

export const CURRENCY_LABEL: Record<CurrencyCode, string> = {
  BRL: "Real (R$)",
  USD: "Dólar (US$)",
  EUR: "Euro (€)",
  CHF: "Franco suíço (CHF)",
};

export function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Currency an asset is quoted in. Today every quoted asset comes in dollars. */
export function quoteCurrencyOf(_assetType: AssetType): CurrencyCode {
  return "USD";
}

/**
 * Reais per 1 unit of each PTAX currency (decimal strings). USD is always
 * there; EUR or CHF may be missing on dates the Banco Central did not quote
 * them (e.g. the euro before 1999).
 */
export type RateTable = { USD: string; EUR?: string; CHF?: string };

/**
 * PTAX frozen on a trade: the Banco Central closing rates (buy and sell) of
 * `date`, the last business day on or before the trade date. `provisional`
 * means the trade date's own rate was not published yet (it is replaced when
 * it is). Conversions use the SELL rate: IN RFB 2.180/2024, art. 57 (closing
 * rate for sale published by the BCB for the date of the taxable event).
 */
export type FxSnapshot = {
  date: string;
  provisional: boolean;
  buy: RateTable;
  sell: RateTable;
};

/** Sanity range for reais per USD/EUR/CHF: a value outside it is never a real PTAX. */
export const RATE_MIN = 0.01;
export const RATE_MAX = 1000;
const rate = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,10})?$/)
  .refine((v) => Number(v) > RATE_MIN && Number(v) < RATE_MAX);
const rateTable = z.object({ USD: rate, EUR: rate.optional(), CHF: rate.optional() }).strict();
export const fxSnapshotSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    provisional: z.boolean(),
    buy: rateTable,
    sell: rateTable,
  })
  .strict();

/** Parses the stored JSON; null when absent or invalid (then it is fetched again). */
export function parseFxSnapshot(raw: unknown): FxSnapshot | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = fxSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function reaisPerUnit(currency: CurrencyCode, rates: RateTable): Big | null {
  if (currency === "BRL") return new Big(1);
  const r = rates[currency];
  return r === undefined ? null : new Big(r);
}

/** Multiplier that turns an amount in `from` into `to`; null if a needed rate is missing. */
export function conversionFactor(from: CurrencyCode, to: CurrencyCode, rates: RateTable): Big | null {
  if (from === to) return new Big(1);
  const a = reaisPerUnit(from, rates);
  const b = reaisPerUnit(to, rates);
  return a && b ? a.div(b) : null;
}
