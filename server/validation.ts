/**
 * Pure input validators. No database, no I/O: easy to test and to reuse.
 */

export const LIMITS = {
  emailMax: 254,
  displayNameMax: 80,
  passwordMin: 12,
  passwordMaxBytes: 72, // bcrypt only uses the first 72 bytes
  stockNameMax: 120,
  searchQueryMax: 50,
  symbolsPerRequest: 50,
  amountMax: 1_000_000_000,
  importStocksMax: 1_000,
  importTransactionsMax: 20_000,
  finnhubKeyMin: 10,
  finnhubKeyMax: 100,
  shortTextMax: 40,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FINNHUB_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeTicker(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidEmail(email: string) {
  return email.length > 0 && email.length <= LIMITS.emailMax && EMAIL_RE.test(email);
}

export function passwordProblem(password: string): string | null {
  if (password.length < LIMITS.passwordMin) {
    return `A senha precisa ter pelo menos ${LIMITS.passwordMin} caracteres`;
  }
  if (Buffer.byteLength(password, "utf8") > LIMITS.passwordMaxBytes) {
    return `A senha pode ter no máximo ${LIMITS.passwordMaxBytes} bytes`;
  }
  return null;
}

export function isValidTicker(ticker: string) {
  return TICKER_RE.test(ticker);
}

/** Accepts a real calendar date in YYYY-MM-DD between 1900 and 2100. */
export function isValidIsoDate(value: string) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1900 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidAmount(value: number) {
  return Number.isFinite(value) && value > 0 && value <= LIMITS.amountMax;
}

export function isValidFinnhubKey(value: string) {
  return (
    value.length >= LIMITS.finnhubKeyMin &&
    value.length <= LIMITS.finnhubKeyMax &&
    FINNHUB_KEY_RE.test(value)
  );
}

export function shortText(value: unknown, max: number = LIMITS.shortTextMax) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type PositionTx = {
  id?: number;
  ticker: string;
  type: "BUY" | "SELL";
  shares: number;
  date: string;
  sort_order?: number;
};

/**
 * Replays transactions in chronological order (date, sort_order, id) and
 * returns the first ticker whose position goes below zero, or null.
 */
export function findNegativePosition(transactions: PositionTx[]): string | null {
  const ordered = [...transactions].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER)
  );

  const held = new Map<string, number>();
  for (const tx of ordered) {
    const next = (held.get(tx.ticker) ?? 0) + (tx.type === "BUY" ? tx.shares : -tx.shares);
    if (next < -1e-9) return tx.ticker;
    held.set(tx.ticker, next);
  }
  return null;
}
