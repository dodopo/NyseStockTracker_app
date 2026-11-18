import type { AssetType } from "../shared/assetTypes";
import type { Horizon, Jurisdiction, Liquidity } from "../shared/classification";
import type { CurrencyCode, FxSnapshot } from "../shared/currencies";
import type { LotChoice } from "../shared/tranches";

export interface Stock {
  ticker: string;
  name: string;
  /** Present on assets loaded from the server (v0.8.0+). */
  asset_type?: AssetType;
  tab_id?: number | null;
  /** Present in the global view (all portfolios). */
  portfolio_id?: number;
  /** v0.14.0+: classification and the currency the asset is quoted in. */
  liquidity?: Liquidity;
  horizon?: Horizon | null;
  jurisdiction?: Jurisdiction | null;
  currency?: CurrencyCode;
  /** v0.15.0+: the thesis target in days (null = none). */
  target_days?: number | null;
}

export type ClassificationChanges = {
  liquidity?: Liquidity;
  horizon?: Horizon | null;
  jurisdiction?: Jurisdiction | null;
  targetDays?: number | null;
};

export interface Tab {
  id: number;
  name: string;
  assetType: AssetType;
  color: string;
  sortOrder: number;
  assetCount: number;
  /** Present in the global view (all portfolios). */
  portfolioId?: number;
}

/** A portfolio (carteira) of the logged-in user. */
export interface Portfolio {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  assetCount: number;
}

/** Every active portfolio at once (GET /api/global). */
export interface GlobalData {
  portfolios: Portfolio[];
  tabs: Tab[];
  stocks: Stock[];
  transactions: Transaction[];
}

export type TransactionType = "BUY" | "SELL";

export interface Transaction {
  id?: number;
  ticker: string;
  type: TransactionType;
  /** Exact decimal string (up to 8 decimal places). */
  shares: string;
  /** Exact decimal string (up to 8 decimal places). */
  price: string;
  date: string; // YYYY-MM-DD
  sort_order?: number;
  /** Present in the global view (all portfolios). */
  portfolio_id?: number;
  /** v0.14.0+: currency paid (default: the asset's) and the PTAX frozen on the trade (null = not known yet). */
  currency?: CurrencyCode;
  fx?: FxSnapshot | null;
  /** v0.15.0+ BUY: this tranche's own target in days (null = the asset's). */
  target_days?: number | null;
  /** v0.15.0+ SELL: tranches chosen (null = oldest first). */
  lots?: LotChoice[] | null;
}

/** A new trade as the form sends it. */
export type NewTransaction = Omit<Transaction, "id" | "sort_order" | "fx" | "target_days" | "lots"> & {
  targetDays?: number | null;
  lots?: LotChoice[];
};

/** Today's rates, reais per 1 unit (GET /api/fx). */
export type LiveFx = { base: "BRL"; rates: Record<"USD" | "EUR" | "CHF", string>; source: string; fetchedAt: string; stale?: boolean };

export type AuthUser = {
  id: number;
  email: string;
  displayName: string | null;
  hasPassword: boolean;
  hasFinnhubKey: boolean;
  hasMassiveKey: boolean;
  hasAlpacaKey?: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

/** Row of the consolidated view. */
export interface PortfolioItem {
  /** Unique row key: portfolio and ticker. */
  key: string;
  ticker: string;
  name: string;
  tabId: number | null;
  portfolioId: number | null;
  quantity: string;
  shares: number;
  avgCost: number;
  totalInvested: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalPnL: number;
  totalPnLPct: number;
  /** Values above are in this currency. */
  currency: CurrencyCode;
  /** The asset's own currency (exposure). */
  assetCurrency: CurrencyCode;
  isCrypto: boolean;
  liquidity: Liquidity;
  horizon: Horizon | null;
  jurisdiction: Jurisdiction | null;
  /** Trades converted at today's rate because their PTAX is not known yet. */
  approxTrades: number;
  /** Trades left out (no PTAX and no rate to convert them). */
  missingTrades: number;
}

export type ConsolidationMode = "UNIFIED" | "SEPARATED";

export type BackupFileData = {
  app?: string;
  version?: number;
  exportedAt?: string;
  user?: {
    email?: string;
    display_name?: string | null;
    finnhub_key?: string | null;
  };
  settings?: Record<string, unknown>;
  stocks?: Array<{ ticker?: string; name?: string; created_at?: string }>;
  transactions?: Array<{
    ticker?: string;
    type?: string;
    shares?: number | string;
    price?: number | string;
    date?: string;
    created_at?: string;
    sort_order?: number;
  }>;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type CandlesResponse = {
  symbol: string;
  range: string;
  interval: string;
  source: string;
  /** Set when the main provider failed and a fallback answered. */
  fallbackFrom?: string;
  /** Start of the requested period (ms); data may start later. */
  requestedFrom?: number;
  candles: Candle[];
  cached?: boolean;
  stale?: boolean;
};

export type IndicatorsResponse = {
  symbol: string;
  source: string;
  firstDay: number | null;
  days: number;
  series: Partial<Record<string, Array<{ t: number; v: number }>>>;
};

export type StockStats = {
  symbol: string;
  high52w: number | null;
  high52wDate: string | null;
  low52w: number | null;
  low52wDate: string | null;
  avgVolume10d: number | null;
  avgVolume3m: number | null;
  marketCap: number | null;
  beta: number | null;
};
