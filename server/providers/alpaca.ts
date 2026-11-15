/**
 * Alpaca market data for US stocks. The free plan returns bars from all US
 * exchanges (SIP) when the end of the period is at least 15 minutes old, with
 * history since 2016. Bars are split-adjusted, like TradingView.
 * Docs: GET /v2/stocks/bars (keys in the APCA-API-KEY-ID / APCA-API-SECRET-KEY headers).
 */
import { MINUTE, ProviderError, cleanCandles, type Candle, type CandleRequest, type DataFetch } from "./types";

export type AlpacaKeys = { keyId: string; secret: string };

/** Free plan: the end of the period must be at least 15 minutes old (1 minute of margin). */
export const ALPACA_FREE_DELAY_MS = 16 * MINUTE;

const PAGE_LIMIT = 10_000;
const MAX_PAGES = 10;

const TIMEFRAME: Record<CandleRequest["interval"], string> = {
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "1h": "1Hour",
  "1D": "1Day",
  "1W": "1Week",
  "1M": "1Month",
};

export function alpacaHeaders(keys: AlpacaKeys) {
  return { "APCA-API-KEY-ID": keys.keyId, "APCA-API-SECRET-KEY": keys.secret };
}

export async function alpacaCandles(
  req: CandleRequest,
  keys: AlpacaKeys,
  fetchJson: DataFetch,
  baseUrl: string,
  now: number
): Promise<Candle[]> {
  const end = Math.min(req.to, now - ALPACA_FREE_DELAY_MS);
  const start = Math.max(req.from, Date.UTC(2015, 0, 1)); // Alpaca history starts in 2016
  if (end <= start) return [];

  const collected: Candle[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      symbols: req.symbol,
      timeframe: TIMEFRAME[req.interval],
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      adjustment: "split",
      feed: "sip",
      limit: String(PAGE_LIMIT),
      sort: "asc",
    });
    if (pageToken) params.set("page_token", pageToken);
    const raw = await fetchJson(`${baseUrl}/v2/stocks/bars?${params}`, alpacaHeaders(keys));
    if (!raw || typeof raw !== "object") throw new ProviderError(502, "Alpaca: resposta inesperada");
    const bars = raw.bars?.[req.symbol];
    if (Array.isArray(bars)) {
      for (const b of bars) collected.push({ t: Date.parse(b?.t), o: b?.o, h: b?.h, l: b?.l, c: b?.c, v: b?.v });
    }
    pageToken = typeof raw.next_page_token === "string" && raw.next_page_token ? raw.next_page_token : null;
    if (!pageToken) break;
  }
  return cleanCandles(collected);
}
