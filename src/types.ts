import type { AssetType } from "../shared/assetTypes";

export interface Stock {
  ticker: string;
  name: string;
  /** Present on assets loaded from the server (v0.8.0+). */
  asset_type?: AssetType;
  tab_id?: number | null;
}

export interface Tab {
  id: number;
  name: string;
  assetType: AssetType;
  color: string;
  sortOrder: number;
  assetCount: number;
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
}

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
  ticker: string;
  name: string;
  tabId: number | null;
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
