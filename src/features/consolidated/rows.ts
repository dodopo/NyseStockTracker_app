import { calculatePosition } from "../../../shared/positions";
import type { StockPrice } from "../../services/marketService";
import type { PortfolioItem, Stock, Transaction } from "../../types";

/**
 * One row per asset of a portfolio (in the global view, the same ticker in two
 * portfolios gives two rows). Trades are matched by portfolio and ticker.
 */
export function buildRows(stocks: Stock[], transactions: Transaction[], prices: Record<string, StockPrice>): PortfolioItem[] {
  const byAsset = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const k = `${t.portfolio_id ?? 0}:${t.ticker}`;
    const list = byAsset.get(k) ?? [];
    list.push(t);
    byAsset.set(k, list);
  }
  return stocks.map((s) => {
    const key = `${s.portfolio_id ?? 0}:${s.ticker}`;
    const currentPrice = prices[s.ticker]?.price || 0;
    const p = calculatePosition(byAsset.get(key) ?? [], currentPrice);
    return {
      key,
      ticker: s.ticker,
      name: s.name,
      tabId: s.tab_id ?? null,
      portfolioId: s.portfolio_id ?? null,
      quantity: p.quantity,
      shares: p.shares,
      avgCost: p.avgCost,
      totalInvested: p.openCost,
      currentPrice,
      marketValue: p.marketValue,
      unrealizedPnL: p.unrealizedPnL,
      realizedPnL: p.realizedPnL,
      totalPnL: p.totalPnL,
      totalPnLPct: p.totalPnLPct,
    };
  });
}

/** Market value of each portfolio (open positions), for the portfolio switcher. */
export function valueByPortfolio(rows: PortfolioItem[]) {
  const totals = new Map<number, number>();
  for (const r of rows) {
    if (r.portfolioId === null) continue;
    totals.set(r.portfolioId, (totals.get(r.portfolioId) ?? 0) + r.marketValue);
  }
  return totals;
}
