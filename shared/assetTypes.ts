/**
 * Asset types are defined in code: each one knows how to search, quote and chart
 * its assets. Tabs are defined by the user and point to one asset type.
 */

export const ASSET_TYPES = {
  us_stock: {
    label: "Ação EUA",
    addTitle: "Adicionar ação",
    listTitle: "Minhas ações",
    searchPlaceholder: "Ticker ou nome (ex: AAPL)",
    emptyList: "Nenhuma ação adicionada",
    hours: "regular" as const, // US market session: regular-hours filter applies to intraday charts
  },
  crypto: {
    label: "Cripto",
    addTitle: "Adicionar cripto",
    listTitle: "Minhas criptos",
    searchPlaceholder: "Nome ou símbolo (ex: Bitcoin, ETH)",
    emptyList: "Nenhuma cripto adicionada",
    hours: "24h" as const,
  },
} as const;

export type AssetType = keyof typeof ASSET_TYPES;
export const ASSET_TYPE_IDS = Object.keys(ASSET_TYPES) as AssetType[];

export function isAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && Object.hasOwn(ASSET_TYPES, value);
}

/** Tab colors offered in the UI (validated on the server). */
export const TAB_COLORS = ["#2962ff", "#089981", "#f7931a", "#ab47bc", "#f23645", "#26a69a", "#ffb74d", "#78909c"] as const;

/** Crypto assets are stored in the Massive format, priced in US dollars: X:BTCUSD. */
export const CRYPTO_TICKER_RE = /^X:[A-Z0-9]{2,15}USD$/;

export function isCryptoTicker(ticker: string) {
  return CRYPTO_TICKER_RE.test(ticker);
}

export function assetTypeOfTicker(ticker: string): AssetType {
  return isCryptoTicker(ticker) ? "crypto" : "us_stock";
}

/** What the user sees: "X:BTCUSD" -> "BTC", "AAPL" -> "AAPL". */
export function displaySymbol(ticker: string) {
  return isCryptoTicker(ticker) ? ticker.slice(2, -3) : ticker;
}

/** Live crypto quotes come from Finnhub's Binance USDT pairs (USDT tracks the dollar). */
export function finnhubQuoteSymbol(ticker: string) {
  return isCryptoTicker(ticker) ? `BINANCE:${ticker.slice(2, -3)}USDT` : ticker;
}
