export interface StockPrice {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  date: string;
}

export interface HistoricalData {
  date: string;
  price: number;
}

// Mantemos a assinatura para compatibilidade.
// (Preços atuais vamos buscar via Finnhub no App.tsx)
export async function getStockPrices(_tickers: string[]): Promise<StockPrice[]> {
  return [];
}

export async function getHistoricalData(ticker: string, period: string): Promise<HistoricalData[]> {
  const t = ticker.trim().toUpperCase();
  const p = (period || "1m").trim();
  const res = await fetch(
    `/api/ai/history?ticker=${encodeURIComponent(t)}&period=${encodeURIComponent(p)}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch historical data: ${res.status} ${text}`);
  }
  return res.json();
}

export async function searchStock(query: string): Promise<{ ticker: string; name: string } | null> {
  const q = query.trim();
  const res = await fetch(`/api/ai/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to search stock: ${res.status} ${text}`);
  }
  return res.json();
}