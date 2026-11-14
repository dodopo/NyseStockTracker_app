export interface Stock {
  ticker: string;
  name: string;
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
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

/** Row of the consolidated view. */
export interface PortfolioItem {
  ticker: string;
  name: string;
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
