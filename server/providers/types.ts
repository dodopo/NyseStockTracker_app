/**
 * Market data providers for charts. Each provider is one module with the same
 * shape, so a provider can be added, swapped or used as a fallback without
 * touching routes or screens.
 */

import { APP_USER_AGENT } from "../../shared/brand";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

/** Candle sizes the chart offers (see shared/chartRanges.ts). */
export type IntervalId = "5m" | "15m" | "30m" | "1h" | "1D" | "1W" | "1M";

export type CandleRequest = {
  symbol: string; // already validated: AAPL, BRK.B, X:BTCUSD
  interval: IntervalId;
  from: number; // ms, inclusive; 0 = the oldest data the provider has
  to: number; // ms
};

/** JSON over HTTP with optional headers. Throws an error with `status` on HTTP errors. */
export type DataFetch = (url: string, headers?: Record<string, string>) => Promise<any>;

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Keeps only well-formed candles, sorted by time, without duplicates. */
export function cleanCandles(list: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of list) {
    if ([c.t, c.o, c.h, c.l, c.c].every((n) => Number.isFinite(n))) {
      byTime.set(c.t, { ...c, v: Number.isFinite(c.v) ? c.v : 0 });
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Default client: 15 s timeout, JSON body, error with `status` when the HTTP status is not 2xx. */
export async function defaultDataFetch(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": APP_USER_AGENT, ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ProviderError(res.status, `HTTP ${res.status}`);
  return res.json();
}

/** Used in tests when no fake client is given: never reaches the network. */
export async function offlineDataFetch(): Promise<never> {
  throw new ProviderError(503, "network disabled in tests");
}
