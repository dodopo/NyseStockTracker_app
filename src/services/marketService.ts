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

// -----------------------------
// Buscar preço de UM ativo
// -----------------------------
export async function fetchQuote(symbol: string): Promise<StockPrice | null> {
  try {
    const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error("Failed to fetch quote");

    const data = await res.json();

    return {
      ticker: data.symbol,
      price: Number(data.price ?? 0),
      change: Number(data.change ?? 0),
      changePercent: Number(data.changePct ?? 0),
      open: Number(data.open ?? 0),
      high: Number(data.high ?? 0),
      low: Number(data.low ?? 0),
      volume: Number(data.raw?.v ?? 0),
      date: new Date().toISOString().slice(0, 10),
    };
  } catch (error) {
    console.error("fetchQuote error:", error);
    return null;
  }
}

// -----------------------------
// Buscar preços em lote
// -----------------------------
export async function fetchQuotes(symbols: string[]): Promise<StockPrice[]> {
  if (symbols.length === 0) return [];

  try {
    const res = await fetch(`/api/prices?symbols=${symbols.join(",")}`);
    if (!res.ok) throw new Error("Failed to fetch prices");

    const data = await res.json();

    const result: StockPrice[] = [];
    for (const symbol of Object.keys(data)) {
      const q = data[symbol];
      if (!q || q.price == null) continue;

      result.push({
        ticker: symbol,
        price: Number(q.price ?? 0),
        change: Number(q.change ?? 0),
        changePercent: Number(q.changePct ?? 0),
        open: Number(q.open ?? 0),
        high: Number(q.high ?? 0),
        low: Number(q.low ?? 0),
        volume: Number(q.raw?.v ?? 0),
        date: new Date().toISOString().slice(0, 10),
      });
    }

    return result;
  } catch (error) {
    console.error("fetchQuotes error:", error);
    return [];
  }
}

// -----------------------------
// Busca ticker por nome
// -----------------------------
export async function searchStock(query: string): Promise<{ ticker: string; name: string } | null> {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error("Search failed");

    const data = await res.json();
    if (!data.result || data.result.length === 0) return null;

    const first = data.result[0];

    return {
      ticker: String(first.symbol || "").toUpperCase(),
      name: String(first.description || "").trim(),
    };
  } catch (error) {
    console.error("searchStock error:", error);
    return null;
  }
}

// -----------------------------
// Helper: transforma array em map
// -----------------------------
export function pricesToMap(prices: StockPrice[]): Record<string, StockPrice> {
  const map: Record<string, StockPrice> = {};
  prices.forEach((p) => {
    map[p.ticker] = p;
  });
  return map;
}