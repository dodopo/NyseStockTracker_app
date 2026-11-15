/**
 * Historical candles (OHLCV) for charts. Picks a provider per asset type and
 * falls back to the next one when a provider fails or does not list the asset:
 *   crypto: Coinbase (real time, no key) -> Binance (no key) -> Massive (key)
 *   stocks: Alpaca (key, all exchanges, 15 min delay) -> Massive (key)
 * Every answer is cached. Massive calls keep the free-plan pace of 5 per minute.
 */

import { CHART_RANGES, CUSTOM_RANGE, customRangeConfig, parseCustomRange, type ChartRangeId } from "../shared/chartRanges";
import { isCryptoTicker } from "../shared/assetTypes";
import { alpacaCandles, type AlpacaKeys } from "./providers/alpaca";
import { binanceCandles } from "./providers/binance";
import { coinbaseCandles } from "./providers/coinbase";
import type { CandleRequest, DataFetch, IntervalId } from "./providers/types";

export type { AlpacaKeys } from "./providers/alpaca";
export type DataSource = "alpaca" | "coinbase" | "binance" | "massive";

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
const FALLBACK_TTL_MS = 5 * 60_000;
const MAX_HISTORY_DAYS = 730; // free plan: 2 years

/** Lookback in days for each period button (sizes/labels live in shared/chartRanges). */
const RANGE_DAYS: Record<ChartRangeId, (now: number) => number> = {
  "1D": () => 5, // 5 days fetched to cover weekends/holidays; only the last session is kept
  "1S": () => 7,
  "1M": () => 31,
  "3M": () => 92,
  YTD: (now) => Math.max(1, Math.ceil((now - Date.UTC(new Date(now).getUTCFullYear(), 0, 1)) / DAY)),
  "1A": () => 366,
  "3A": () => 3 * 366,
  "5A": () => 5 * 366,
  "10A": () => 10 * 366,
  MAX: () => MAX_HISTORY_DAYS,
};

export class CandleError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

/** Base URLs, overridable for a local mock (testing). */
export function providerUrls() {
  const clean = (v: string | undefined, fallback: string) => (v?.trim() || fallback).replace(/\/+$/, "");
  return {
    alpaca: clean(process.env.ALPACA_DATA_URL, "https://data.alpaca.markets"),
    coinbase: clean(process.env.COINBASE_BASE_URL, "https://api.exchange.coinbase.com"),
    binance: clean(process.env.BINANCE_BASE_URL, "https://api.binance.com"),
  };
}

function isoDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar date of a timestamp in New York (the US market session date). */
export function nyDate(ms: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

function cacheTtlMs(interval: Interval, source: DataSource) {
  const intraday = interval.timespan === "minute" || interval.timespan === "hour";
  if (source === "massive") return intraday ? 5 * 60_000 : 6 * 60 * 60_000; // free plan: 5 calls per minute
  if (source === "alpaca") return intraday ? 2 * 60_000 : 15 * 60_000;
  return intraday ? 60_000 : 10 * 60_000; // crypto in real time
}

export function createCandleService(options: {
  fetch: MassiveFetch;
  /** Client for the keyless/other providers. Without it, only Massive is used. */
  dataFetch?: DataFetch;
  now?: () => number;
  maxCacheEntries?: number;
  callsPerMinute?: number;
}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxCacheEntries ?? 300;
  const callsPerMinute = options.callsPerMinute ?? 5;

  const cache = new Map<string, { candles: Candle[]; source: DataSource; fallbackFrom?: DataSource; requestedFrom: number; expiresAt: number }>();
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

  const misc = new Map<string, { value: unknown; expiresAt: number }>();

  function paceError(waitS: number) {
    return new CandleError(429, `O plano grátis da Massive permite 5 consultas por minuto. Tente de novo em ${waitS} s.`);
  }

  function providerError(error: any) {
    const status = Number(error?.status);
    if (status === 401 || status === 403) {
      return new CandleError(400, "A Massive recusou a chave. Confira a chave em Configurações → Conta.");
    }
    if (status === 429) return new CandleError(429, "A Massive pediu para aguardar um minuto. Tente de novo em instantes.");
    return new CandleError(502, "Não foi possível consultar a Massive agora. Tente de novo em instantes.");
  }

  /**
   * Any other Massive request (crypto search, exchange rate): cached for `ttlMs`
   * and sharing the same 5-per-minute pace as the candles. Stale cache is served
   * when the pace is exceeded or the provider fails.
   */
  async function cachedGet<T>(cacheKey: string, path: string, apiKey: string, ttlMs: number, map: (raw: any) => T): Promise<T> {
    const hit = misc.get(cacheKey);
    if (hit && hit.expiresAt > now()) return hit.value as T;

    const waitS = takeCallSlot(apiKey);
    if (waitS > 0) {
      if (hit) return hit.value as T;
      throw paceError(waitS);
    }
    let raw: any;
    try {
      raw = await options.fetch(path, apiKey);
    } catch (error) {
      if (hit) return hit.value as T;
      throw providerError(error);
    }
    const value = map(raw);
    misc.delete(cacheKey);
    if (misc.size >= maxEntries) {
      const oldest = misc.keys().next().value;
      if (oldest !== undefined) misc.delete(oldest);
    }
    misc.set(cacheKey, { value, expiresAt: now() + ttlMs });
    return value;
  }

  function store(key: string, candles: Candle[], source: DataSource, interval: Interval, requestedFrom: number, fallbackFrom?: DataSource) {
    cache.delete(key);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    // An answer from a fallback is kept briefly, so the main provider is tried again soon.
    const ttl = fallbackFrom ? Math.min(cacheTtlMs(interval, source), FALLBACK_TTL_MS) : cacheTtlMs(interval, source);
    cache.set(key, { candles, source, fallbackFrom, requestedFrom, expiresAt: now() + ttl });
  }

  /** Server log line when a provider fails: status and a short reason, never URLs or keys. */
  function logProviderFailure(source: DataSource, symbol: string, error: any) {
    const status = Number(error?.status) || "-";
    const reason = String(error?.message ?? error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 120);
    console.warn(`[candles] ${source} falhou para ${symbol} (status ${status}): ${reason}`);
  }

  async function fromMassive(symbol: string, interval: Interval, from: number, to: number, apiKey: string) {
    const waitS = takeCallSlot(apiKey);
    if (waitS > 0) throw paceError(waitS);
    // The symbol is already validated (letters, digits, '.', '-', and the 'X:' crypto prefix).
    const path =
      `/v2/aggs/ticker/${symbol}/range/${interval.multiplier}/${interval.timespan}` +
      `/${isoDate(Math.max(from, to - MAX_HISTORY_DAYS * DAY))}/${isoDate(to)}?adjusted=true&sort=asc&limit=50000`;
    let raw: any;
    try {
      raw = await options.fetch(path, apiKey);
    } catch (error) {
      throw providerError(error);
    }
    return (Array.isArray(raw?.results) ? raw.results : [])
      .filter((r: any) => [r?.t, r?.o, r?.h, r?.l, r?.c].every((n) => Number.isFinite(n)))
      .map((r: any) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: Number.isFinite(r.v) ? r.v : 0 })) as Candle[];
  }

  /** Providers to try, in order, for this asset and the keys the user has. */
  function chain(symbol: string, keys: { massive?: string | null; alpaca?: AlpacaKeys | null }) {
    const list: DataSource[] = [];
    if (isCryptoTicker(symbol)) {
      if (options.dataFetch) list.push("coinbase", "binance");
    } else if (options.dataFetch && keys.alpaca) {
      list.push("alpaca");
    }
    if (keys.massive) list.push("massive");
    return list;
  }

  async function fetchFrom(
    source: DataSource,
    req: CandleRequest,
    interval: Interval,
    keys: { massive?: string | null; alpaca?: AlpacaKeys | null }
  ): Promise<Candle[]> {
    const urls = providerUrls();
    const dataFetch = options.dataFetch!;
    switch (source) {
      case "coinbase":
        return coinbaseCandles(req, dataFetch, urls.coinbase);
      case "binance":
        return binanceCandles(req, dataFetch, urls.binance);
      case "alpaca":
        try {
          return await alpacaCandles(req, keys.alpaca!, dataFetch, urls.alpaca, now());
        } catch (error: any) {
          if (error?.status === 401 || error?.status === 403) {
            throw new CandleError(400, "A Alpaca recusou a chave. Confira a chave em Configurações → Conta.");
          }
          throw error;
        }
      case "massive":
        return fromMassive(req.symbol, interval, req.from, req.to, keys.massive!);
    }
  }

  async function getCandles(params: {
    symbol: string;
    range: string;
    interval?: string;
    /** Massive key (kept as `apiKey` for compatibility). */
    apiKey?: string | null;
    alpaca?: AlpacaKeys | null;
    /** Custom period (range "CUSTOM"): dates as YYYY-MM-DD. */
    customFrom?: unknown;
    customTo?: unknown;
  }) {
    const custom = params.range === CUSTOM_RANGE;
    let customSpan: { from: number; to: number } | null = null;
    if (custom) {
      const parsed = parseCustomRange(params.customFrom, params.customTo, now());
      if ("error" in parsed) throw new CandleError(400, parsed.error);
      customSpan = parsed;
    } else if (!Object.hasOwn(CHART_RANGES, params.range)) {
      throw new CandleError(400, "Período inválido");
    }
    const rangeId = params.range as ChartRangeId;
    const range = customSpan ? customRangeConfig(customSpan.from, customSpan.to) : CHART_RANGES[rangeId];

    const intervalId: string = params.interval && params.interval !== "auto" ? params.interval : range.auto;
    if (!(range.allowed as readonly string[]).includes(intervalId) || !Object.hasOwn(INTERVALS, intervalId)) {
      throw new CandleError(400, `Vela de ${intervalId} não disponível para o período ${params.range}`);
    }
    const interval = INTERVALS[intervalId];
    const keys = { massive: params.apiKey, alpaca: params.alpaca };

    // The providers this user can use come first: no key, no chart (not even a cached one),
    // and a new key changes the chain, so it takes effect immediately.
    const sources = chain(params.symbol, keys);
    if (sources.length === 0) {
      throw new CandleError(
        400,
        "Configure a chave da Alpaca (ou da Massive) em Configurações → Conta para ver os gráficos.",
        "CHART_KEY_MISSING"
      );
    }

    const rangeKey = customSpan ? `${CUSTOM_RANGE}:${params.customFrom}:${params.customTo}` : params.range;
    const key = `${params.symbol}|${rangeKey}|${intervalId}|${sources.join(">")}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return { interval: intervalId, candles: cached.candles, source: cached.source, fallbackFrom: cached.fallbackFrom, requestedFrom: cached.requestedFrom, cached: true };
    }

    const crypto = isCryptoTicker(params.symbol);
    let from: number;
    let to: number;
    if (customSpan) {
      ({ from, to } = customSpan);
    } else {
      to = now();
      const days = crypto && rangeId === "1D" ? 2 : RANGE_DAYS[rangeId](to); // crypto trades 24/7
      // "Máx": everything the provider has (Massive's free plan is capped at 2 years in fromMassive).
      from = rangeId === "MAX" ? 0 : to - days * DAY;
    }

    let firstError: unknown = null;
    let failed: DataSource | undefined; // first provider that failed (shown to the user)
    for (const source of sources) {
      let candles: Candle[];
      try {
        candles = await fetchFrom(source, { symbol: params.symbol, interval: intervalId as IntervalId, from, to }, interval, keys);
      } catch (error) {
        firstError ??= error;
        // A keyless crypto provider answering 404/400 just does not list this coin: normal, not a failure.
        const notListed = (source === "coinbase" || source === "binance") && [400, 404].includes(Number((error as any)?.status));
        if (!notListed) {
          failed ??= source;
          logProviderFailure(source, params.symbol, error);
        }
        continue; // next provider
      }
      if (candles.length === 0 && source !== sources[sources.length - 1]) continue;

      if (params.range === "1D" && candles.length) {
        const lastT = candles[candles.length - 1].t;
        candles = crypto
          ? // crypto: the last 24 hours
            candles.filter((c) => c.t > lastT - DAY)
          : // stocks: the most recent session only (5 days are fetched to cover weekends/holidays)
            candles.filter((c) => nyDate(c.t) === nyDate(lastT));
      }

      const fallbackFrom = failed;
      store(key, candles, source, interval, from, fallbackFrom);
      return { interval: intervalId, candles, source, fallbackFrom, requestedFrom: from, cached: false };
    }

    // Every provider failed: serve stale data if we have it.
    if (cached) {
      return { interval: intervalId, candles: cached.candles, source: cached.source, fallbackFrom: cached.fallbackFrom, requestedFrom: cached.requestedFrom, cached: true, stale: true };
    }
    if (firstError instanceof CandleError) throw firstError;
    throw new CandleError(502, "Não foi possível consultar o histórico agora. Tente de novo em instantes.");
  }

  return { getCandles, cachedGet };
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
