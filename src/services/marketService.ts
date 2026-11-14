import { api } from "../api/client";
import { displaySymbol, type AssetType } from "../../shared/assetTypes";

export interface StockPrice {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  date: string; // YYYY-MM-DD
}

type QuoteDto = {
  symbol: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  raw?: { v?: number };
};

function toStockPrice(symbol: string, q: QuoteDto): StockPrice {
  return {
    ticker: symbol,
    price: Number(q.price ?? 0),
    change: Number(q.change ?? 0),
    changePercent: Number(q.changePct ?? 0),
    open: Number(q.open ?? 0),
    high: Number(q.high ?? 0),
    low: Number(q.low ?? 0),
    volume: Number(q.raw?.v ?? 0),
    date: new Date().toISOString().slice(0, 10),
  };
}

/** Quotes for up to 50 symbols in one request. Failed symbols are simply absent. */
export async function fetchQuotes(symbols: string[]): Promise<StockPrice[]> {
  if (symbols.length === 0) return [];
  try {
    const query = symbols.map(encodeURIComponent).join(",");
    const data = await api<Record<string, QuoteDto>>(`/api/prices?symbols=${query}`);
    return Object.entries(data)
      .filter(([, q]) => q && q.price != null)
      .map(([symbol, q]) => toStockPrice(symbol, q));
  } catch (error) {
    console.error("fetchQuotes error:", error);
    return [];
  }
}

export type SearchHit = { ticker: string; name: string; displaySymbol: string };

/**
 * Up to 5 matches. US stocks: Finnhub search. Crypto: Massive reference data (USD pairs).
 * Throws ApiError (e.g. MASSIVE_KEY_MISSING) so the screen can explain what to do.
 */
export async function searchAssets(query: string, assetType: AssetType): Promise<SearchHit[]> {
  const typeParam = assetType === "crypto" ? "&type=crypto" : "";
  const data = await api<{ result?: Array<{ symbol?: string; description?: string; displaySymbol?: string; type?: string }> }>(
    `/api/search?q=${encodeURIComponent(query)}${typeParam}`
  );
  return (data?.result ?? [])
    .filter((r) => r.symbol)
    .slice(0, 5)
    .map((r) => {
      const ticker = String(r.symbol).toUpperCase();
      return { ticker, name: String(r.description || ticker).trim(), displaySymbol: displaySymbol(ticker) };
    });
}

export function pricesToMap(prices: StockPrice[]): Record<string, StockPrice> {
  return Object.fromEntries(prices.map((p) => [p.ticker, p]));
}
