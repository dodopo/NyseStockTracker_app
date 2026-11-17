/**
 * Coinbase Exchange public market data (no key): crypto candles in US dollars,
 * up to the current minute, BTC-USD since July 2015.
 * Docs: GET /products/{product_id}/candles, at most 300 candles per request,
 * sizes 1m, 5m, 15m, 1h, 6h, 1d. 30 min, week and month are built here.
 */
import { aggregateCandles } from "./aggregate";
import { ProviderError, cleanCandles, type Candle, type CandleRequest, type DataFetch } from "./types";

const PER_REQUEST = 300;
const MAX_PAGES = 40; // ~33 years of daily candles; protects against loops

const SOURCE: Record<CandleRequest["interval"], { seconds: number; aggregate?: "30m" | "1W" | "1M" }> = {
  "5m": { seconds: 300 },
  "15m": { seconds: 900 },
  "30m": { seconds: 900, aggregate: "30m" },
  "1h": { seconds: 3600 },
  "1D": { seconds: 86_400 },
  "1W": { seconds: 86_400, aggregate: "1W" },
  "1M": { seconds: 86_400, aggregate: "1M" },
};

export function coinbaseProduct(symbol: string) {
  // X:BTCUSD -> BTC-USD
  return `${symbol.slice(2, -3)}-USD`;
}

export async function coinbaseCandles(req: CandleRequest, fetchJson: DataFetch, baseUrl: string): Promise<Candle[]> {
  const src = SOURCE[req.interval];
  const step = src.seconds * 1000 * PER_REQUEST;
  const product = coinbaseProduct(req.symbol);
  const collected: Candle[] = [];

  // Walks backwards from `to` until `from` (or until Coinbase has no older data).
  let end = req.to;
  for (let page = 0; page < MAX_PAGES && end > req.from; page++) {
    const start = Math.max(req.from, end - step);
    const url =
      `${baseUrl}/products/${encodeURIComponent(product)}/candles` +
      `?granularity=${src.seconds}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const raw = await fetchJson(url);
    if (!Array.isArray(raw)) throw new ProviderError(502, "Coinbase: resposta inesperada");
    if (raw.length === 0) break; // before the product was listed
    for (const r of raw) {
      if (Array.isArray(r)) collected.push({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5] });
    }
    end = start;
  }

  const candles = cleanCandles(collected).filter((c) => c.t >= req.from - src.seconds * 1000 && c.t <= req.to);
  return src.aggregate ? aggregateCandles(candles, src.aggregate) : candles;
}

/** Well-known names Coinbase does not use (it calls ETH "Ether"). */
const NAME_ALIASES: Record<string, string[]> = { ETH: ["Ethereum"] };

export type CryptoAsset = { symbol: string; description: string; displaySymbol: string; aliases: string[] };

/**
 * Every crypto Coinbase trades against the US dollar, with its name, in our
 * format (X:BTCUSD). Two public calls (products + currencies), no key.
 */
export async function coinbaseUsdAssets(fetchJson: DataFetch, baseUrl: string): Promise<CryptoAsset[]> {
  const [products, currencies] = await Promise.all([fetchJson(`${baseUrl}/products`), fetchJson(`${baseUrl}/currencies`)]);
  if (!Array.isArray(products) || !Array.isArray(currencies)) throw new ProviderError(502, "Coinbase: resposta inesperada");
  const names = new Map<string, string>();
  for (const c of currencies) if (typeof c?.id === "string" && typeof c?.name === "string") names.set(c.id, c.name);

  const out: CryptoAsset[] = [];
  for (const p of products) {
    if (p?.quote_currency !== "USD" || p?.status !== "online" || p?.trading_disabled === true) continue;
    const base = String(p?.base_currency ?? "").toUpperCase();
    const symbol = `X:${base}USD`;
    if (!/^X:[A-Z0-9]{2,15}USD$/.test(symbol)) continue;
    out.push({ symbol, description: names.get(base) ?? base, displaySymbol: base, aliases: NAME_ALIASES[base] ?? [] });
  }
  return out;
}

/**
 * Live rates in reais per 1 USD, EUR and CHF, from Coinbase's public exchange
 * rates (no key). Docs: GET https://api.coinbase.com/v2/exchange-rates?currency=USD
 * (rates there are "units per 1 USD"; reais per EUR = BRL / EUR).
 */
export async function coinbaseLiveRates(fetchJson: DataFetch, baseUrl: string): Promise<Record<"USD" | "EUR" | "CHF", string>> {
  const raw = await fetchJson(`${baseUrl}/v2/exchange-rates?currency=USD`);
  const perUsd = (code: string) => Number(raw?.data?.rates?.[code]);
  const brl = perUsd("BRL");
  const eur = perUsd("EUR");
  const chf = perUsd("CHF");
  // Sanity ranges: protect the portfolio values from a broken answer.
  if (!Number.isFinite(brl) || brl < 1 || brl > 50) throw new ProviderError(502, "Coinbase: câmbio inválido");
  for (const v of [eur, chf]) {
    if (!Number.isFinite(v) || v < 0.2 || v > 5) throw new ProviderError(502, "Coinbase: câmbio inválido");
  }
  const fixed = (n: number) => n.toFixed(6);
  return { USD: fixed(brl), EUR: fixed(brl / eur), CHF: fixed(brl / chf) };
}
