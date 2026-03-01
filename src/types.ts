export interface Stock {
  ticker: string;
  name: string;
}

export type TransactionType = "BUY" | "SELL";

export interface Transaction {
  id?: number;
  ticker: string;
  type: TransactionType;
  shares: number;
  price: number;
  date: string; // YYYY-MM-DD
}

/**
 * Métricas calculadas da posição (PM padrão de corretoras)
 */
export interface PositionMetrics {
  ticker: string;
  name: string;

  shares: number;            // posição atual
  avgCost: number;           // preço médio
  totalInvested: number;     // custo da posição aberta

  currentPrice: number;
  marketValue: number;

  unrealizedPnL: number;
  unrealizedPnLPct: number;

  realizedPnL: number;       // ganhos realizados com vendas
  totalPnL: number;          // realized + unrealized
}

/**
 * Item usado na tela CONSOLIDADO
 */
export interface PortfolioItem {
  ticker: string;
  name: string;

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

/**
 * Modo de visualização (toggle)
 */
export type ConsolidationMode = "UNIFIED" | "SEPARATED";