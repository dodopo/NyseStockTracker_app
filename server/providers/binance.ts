/**
 * Binance public market data (no key), fallback for crypto that Coinbase does
 * not list. Priced in USDT (a dollar stablecoin), BTCUSDT since August 2017.
 * Docs: GET /api/v3/klines, at most 1000 candles per request.
 */
import { ProviderError, cleanCandles, type Candle, type CandleRequest, type DataFetch } from "./types";

const PER_REQUEST = 1000;
const MAX_PAGES = 20;

const INTERVAL: Record<CandleRequest["interval"], string> = {
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1D": "1d",
  "1W": "1w",
  "1M": "1M",
};

export function binanceSymbol(symbol: string) {
  // X:BTCUSD -> BTCUSDT
  return `${symbol.slice(2, -3)}USDT`;
}

export async function binanceCandles(req: CandleRequest, fetchJson: DataFetch, baseUrl: string): Promise<Candle[]> {
  const collected: Candle[] = [];
  let start = req.from;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${baseUrl}/api/v3/klines?symbol=${binanceSymbol(req.symbol)}&interval=${INTERVAL[req.interval]}` +
      `&startTime=${start}&endTime=${req.to}&limit=${PER_REQUEST}`;
    const raw = await fetchJson(url);
    if (!Array.isArray(raw)) throw new ProviderError(502, "Binance: resposta inesperada");
    for (const k of raw) {
      if (Array.isArray(k)) collected.push({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    if (raw.length < PER_REQUEST) break;
    start = Number(raw[raw.length - 1][0]) + 1;
  }
  return cleanCandles(collected);
}
