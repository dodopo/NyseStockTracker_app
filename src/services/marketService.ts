import { api } from "../api/client";

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

/** First Finnhub match for a ticker or company name, or null. */
export async function searchStock(query: string): Promise<{ ticker: string; name: string } | null> {
  const data = await api<{ result?: Array<{ symbol?: string; description?: string }> }>(
    `/api/search?q=${encodeURIComponent(query)}`
  );
  const first = data?.result?.[0];
  if (!first) return null;
  return {
    ticker: String(first.symbol || "").toUpperCase(),
    name: String(first.description || "").trim(),
  };
}

export function pricesToMap(prices: StockPrice[]): Record<string, StockPrice> {
  return Object.fromEntries(prices.map((p) => [p.ticker, p]));
}
