import { assetTypeOfTicker, isCryptoTicker } from "../../../shared/assetTypes";
import { defaultClassification } from "../../../shared/classification";
import { isCurrency, type CurrencyCode, type RateTable } from "../../../shared/currencies";
import { positionIn } from "../../../shared/fxPositions";
import type { StockPrice } from "../../services/marketService";
import type { PortfolioItem, Stock, Transaction } from "../../types";

/**
 * One row per asset of a portfolio (in the global view, the same ticker in two
 * portfolios gives two rows). Trades are matched by portfolio and ticker.
 *
 * Values are in `currency`: each trade converted with the PTAX frozen on it,
 * the current price with today's rate (`live`). Assets that cannot be shown in
 * `currency` (no rate yet) are left out; the caller then shows the asset's own
 * currency instead.
 */
export function buildRows(
  stocks: Stock[],
  transactions: Transaction[],
  prices: Record<string, StockPrice>,
  currency: CurrencyCode = "USD",
  live?: RateTable | null
): PortfolioItem[] {
  const byAsset = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const k = `${t.portfolio_id ?? 0}:${t.ticker}`;
    const list = byAsset.get(k) ?? [];
    list.push(t);
    byAsset.set(k, list);
  }
  const rows: PortfolioItem[] = [];
  for (const s of stocks) {
    const key = `${s.portfolio_id ?? 0}:${s.ticker}`;
    const assetCurrency: CurrencyCode = isCurrency(s.currency) ? s.currency : "USD";
    const nativePrice = prices[s.ticker]?.price || 0;
    const p = positionIn(byAsset.get(key) ?? [], assetCurrency, nativePrice, currency, live);
    if (!p) continue;
    const defaults = defaultClassification(s.asset_type ?? assetTypeOfTicker(s.ticker));
    rows.push({
      key,
      ticker: s.ticker,
      name: s.name,
      tabId: s.tab_id ?? null,
      portfolioId: s.portfolio_id ?? null,
      quantity: p.quantity,
      shares: p.shares,
      avgCost: p.avgCost,
      totalInvested: p.openCost,
      currentPrice: p.currentPrice,
      marketValue: p.marketValue,
      unrealizedPnL: p.unrealizedPnL,
      realizedPnL: p.realizedPnL,
      totalPnL: p.totalPnL,
      totalPnLPct: p.totalPnLPct,
      currency,
      assetCurrency,
      isCrypto: isCryptoTicker(s.ticker),
      liquidity: s.liquidity ?? defaults.liquidity,
      horizon: s.horizon === undefined ? defaults.horizon : s.horizon,
      jurisdiction: s.jurisdiction === undefined ? defaults.jurisdiction : s.jurisdiction,
      approxTrades: p.approx,
      missingTrades: p.missing,
    });
  }
  return rows;
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
