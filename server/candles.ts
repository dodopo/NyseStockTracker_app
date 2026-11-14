/**
 * Historical candles (OHLCV) for charts, from Massive (ex-Polygon) aggregates.
 *
 * The free Massive plan allows 5 requests per minute and 2 years of history, so
 * this module caches every answer and paces calls per API key. The chart can
 * switch ranges freely without ever hitting the provider limit.
 */

import { CHART_RANGES, type ChartRangeId } from "../shared/chartRanges";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timespan = "minute" | "hour" | "day" | "week" | "month";
export type Interval = { multiplier: number; timespan: Timespan };

/** Fetches a Massive path (already with query string) using the given key. */
export type MassiveFetch = (path: string, apiKey: string) => Promise<any>;

export const INTERVALS: Record<string, Interval> = {
  "5m": { multiplier: 5, timespan: "minute" },
  "15m": { multiplier: 15, timespan: "minute" },
  "30m": { multiplier: 30, timespan: "minute" },
  "1h": { multiplier: 1, timespan: "hour" },
  "1D": { multiplier: 1, timespan: "day" },
  "1W": { multiplier: 1, timespan: "week" },
  "1M": { multiplier: 1, timespan: "month" },
};

const DAY = 86_400_000;
const MAX_HISTORY_DAYS = 730; // free plan: 2 years

/** Lookback in days for each period button (sizes/labels live in shared/chartRanges). */
const RANGE_DAYS: Record<ChartRangeId, (now: number) => number> = {
  "1D": () => 5, // 5 days fetched to cover weekends/holidays; only the last session is kept
  "1S": () => 7,
  "1M": () => 31,
  "3M": () => 92,
  YTD: (now) => Math.max(1, Math.ceil((now - Date.UTC(new Date(now).getUTCFullYear(), 0, 1)) / DAY)),
  "1A": () => 366,
  MAX: () => MAX_HISTORY_DAYS,
};

export class CandleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isoDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar date of a timestamp in New York (the US market session date). */
export function nyDate(ms: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

function cacheTtlMs(interval: Interval) {
  return interval.timespan === "minute" || interval.timespan === "hour" ? 5 * 60_000 : 6 * 60 * 60_000;
}

export function createCandleService(options: {
  fetch: MassiveFetch;
  now?: () => number;
  maxCacheEntries?: number;
  callsPerMinute?: number;
}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxCacheEntries ?? 300;
  const callsPerMinute = options.callsPerMinute ?? 5;

  const cache = new Map<string, { candles: Candle[]; expiresAt: number }>();
  const callLog = new Map<string, number[]>(); // per API key: timestamps of recent calls

  function takeCallSlot(apiKey: string) {
    const t = now();
    const recent = (callLog.get(apiKey) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= callsPerMinute) {
      const waitS = Math.ceil((60_000 - (t - recent[0])) / 1000);
      callLog.set(apiKey, recent);
      return waitS;
    }
    recent.push(t);
    callLog.set(apiKey, recent);
    return 0;
  }

  function store(key: string, candles: Candle[], interval: Interval) {
    cache.delete(key);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { candles, expiresAt: now() + cacheTtlMs(interval) });
  }

  async function getCandles(params: { symbol: string; range: string; interval?: string; apiKey: string }) {
    if (!Object.hasOwn(CHART_RANGES, params.range)) throw new CandleError(400, "Período inválido");
    const rangeId = params.range as ChartRangeId;
    const range = CHART_RANGES[rangeId];

    const intervalId: string = params.interval && params.interval !== "auto" ? params.interval : range.auto;
    if (!(range.allowed as readonly string[]).includes(intervalId) || !Object.hasOwn(INTERVALS, intervalId)) {
      throw new CandleError(400, `Vela de ${intervalId} não disponível para o período ${params.range}`);
    }
    const interval = INTERVALS[intervalId];

    const key = `${params.symbol}|${params.range}|${intervalId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return { interval: intervalId, candles: cached.candles, cached: true };
    }

    const waitS = takeCallSlot(params.apiKey);
    if (waitS > 0) {
      // Over the free-plan pace: serve stale data if we have it, otherwise ask to wait.
      if (cached) return { interval: intervalId, candles: cached.candles, cached: true, stale: true };
      throw new CandleError(
        429,
        `O plano grátis da Massive permite 5 consultas por minuto. Tente de novo em ${waitS} s.`
      );
    }

    const to = now();
    const from = to - Math.min(RANGE_DAYS[rangeId](to), MAX_HISTORY_DAYS) * DAY;
    const path =
      `/v2/aggs/ticker/${encodeURIComponent(params.symbol)}/range/${interval.multiplier}/${interval.timespan}` +
      `/${isoDate(from)}/${isoDate(to)}?adjusted=true&sort=asc&limit=50000`;

    let raw: any;
    try {
      raw = await options.fetch(path, params.apiKey);
    } catch (error: any) {
      if (cached) return { interval: intervalId, candles: cached.candles, cached: true, stale: true };
      const status = Number(error?.status);
      if (status === 401 || status === 403) {
        throw new CandleError(400, "A Massive recusou a chave. Confira a chave em Configurações → Conta.");
      }
      if (status === 429) throw new CandleError(429, "A Massive pediu para aguardar um minuto. Tente de novo em instantes.");
      throw new CandleError(502, "Não foi possível buscar o histórico agora. Tente de novo em instantes.");
    }

    let candles: Candle[] = (Array.isArray(raw?.results) ? raw.results : [])
      .filter((r: any) => [r?.t, r?.o, r?.h, r?.l, r?.c].every((n) => Number.isFinite(n)))
      .map((r: any) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: Number.isFinite(r.v) ? r.v : 0 }));

    if (params.range === "1D" && candles.length) {
      // "1 day" = the most recent session only (5 days are fetched to cover weekends/holidays).
      const lastSession = nyDate(candles[candles.length - 1].t);
      candles = candles.filter((c) => nyDate(c.t) === lastSession);
    }

    store(key, candles, interval);
    return { interval: intervalId, candles, cached: false };
  }

  return { getCandles };
}

/** Default HTTP client for Massive: key in the Authorization header, never in the URL. */
export async function defaultMassiveFetch(path: string, apiKey: string) {
  // MASSIVE_BASE_URL: advanced/testing override (e.g. https://api.polygon.io or a local mock).
  const base = (process.env.MASSIVE_BASE_URL || "https://api.massive.com").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const error = new Error(`Massive HTTP ${res.status}`) as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}
