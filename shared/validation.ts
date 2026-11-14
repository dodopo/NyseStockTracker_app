/**
 * Pure input validators shared by server and browser. No database, no I/O.
 */
import { Big } from "./decimal";

export const LIMITS = {
  emailMax: 254,
  displayNameMax: 80,
  passwordMin: 12,
  passwordMaxBytes: 72, // bcrypt only uses the first 72 bytes
  stockNameMax: 120,
  searchQueryMax: 50,
  symbolsPerRequest: 50,
  importStocksMax: 1_000,
  importTransactionsMax: 20_000,
  finnhubKeyMin: 10,
  finnhubKeyMax: 100,
  shortTextMax: 40,
} as const;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
export const FINNHUB_KEY_RE = /^[A-Za-z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeTicker(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidEmail(email: string) {
  return email.length > 0 && email.length <= LIMITS.emailMax && EMAIL_RE.test(email);
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export function passwordProblem(password: string): string | null {
  if (password.length < LIMITS.passwordMin) {
    return `A senha precisa ter pelo menos ${LIMITS.passwordMin} caracteres`;
  }
  if (utf8ByteLength(password) > LIMITS.passwordMaxBytes) {
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
  shares: string | number;
  date: string;
  sort_order?: number;
};

/** Chronological order used everywhere: date, then sort_order, then id. */
export function compareTransactions<T extends { date: string; sort_order?: number; id?: number }>(a: T, b: T) {
  return (
    a.date.localeCompare(b.date) ||
    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
    (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Replays transactions in chronological order with exact decimals and returns
 * the first ticker whose position goes below zero, or null.
 */
export function findNegativePosition(transactions: PositionTx[]): string | null {
  const held = new Map<string, Big>();
  for (const tx of [...transactions].sort(compareTransactions)) {
    const qty = new Big(tx.shares);
    const current = held.get(tx.ticker) ?? new Big(0);
    const next = tx.type === "BUY" ? current.plus(qty) : current.minus(qty);
    if (next.lt(0)) return tx.ticker;
    held.set(tx.ticker, next);
  }
  return null;
}
