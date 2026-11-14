import Big from "big.js";

/**
 * Exact decimal handling shared by server and browser.
 * Quantities and prices are stored and transported as canonical decimal strings
 * (no binary floating point), with up to 8 decimal places (1 satoshi = 0.00000001).
 */
export const DECIMAL_PLACES = 8;
export const MAX_INTEGER_DIGITS = 12;

Big.DP = 20; // precision for divisions (average cost)
Big.RM = Big.roundHalfUp;

export { Big };

/**
 * Parses a positive decimal (string or number) into its canonical string form
 * (e.g. "0.10" -> "0.1", 1e-8 -> "0.00000001"). Returns null when the value is
 * not a finite positive number, has more than 8 decimal places or more than
 * 12 integer digits.
 */
export function parsePositiveDecimal(value: unknown): string | null {
  let big: Big;
  try {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      big = new Big(value);
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
      big = new Big(trimmed);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  if (big.lte(0)) return null;
  if (!big.round(DECIMAL_PLACES, Big.roundDown).eq(big)) return null;

  const canonical = big.toFixed();
  const integerDigits = canonical.split(".")[0].length;
  if (integerDigits > MAX_INTEGER_DIGITS) return null;

  return canonical;
}

/** Converts a stored REAL (legacy column) into a canonical decimal string. */
export function decimalFromLegacyNumber(value: number): string {
  return new Big(value).round(DECIMAL_PLACES).toFixed();
}

export function toNumber(value: Big | string | number): number {
  return Number(value instanceof Big ? value.toString() : value);
}
