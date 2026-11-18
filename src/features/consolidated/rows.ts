import { assetTypeOfTicker, isCryptoTicker } from "../../../shared/assetTypes";
import { calculatePosition } from "../../../shared/positions";
import { manualPrice } from "../../../shared/manualAssets";
import { defaultClassification } from "../../../shared/classification";
import { isCurrency, type CurrencyCode, type RateTable } from "../../../shared/currencies";
import { convertTrades, positionIn } from "../../../shared/fxPositions";
import { defaultTargetDays, localToday, maturityOf, replayTranches, type MaturityBucket } from "../../../shared/tranches";
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
 *
 * An illiquid asset is priced by its latest valuation up to `today` (or its
 * average cost while it has none) and a cash account at 1: neither has a quote.
 */
export function buildRows(
  stocks: Stock[],
  transactions: Transaction[],
  prices: Record<string, StockPrice>,
  currency: CurrencyCode = "USD",
  live?: RateTable | null,
  today: string = localToday()
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
    const assetType = s.asset_type ?? assetTypeOfTicker(s.ticker);
    const trades = byAsset.get(key) ?? [];
    // Average cost in the asset's own currency (for an illiquid asset not valued yet).
    const costOf = () => calculatePosition(convertTrades(trades, assetCurrency, assetCurrency, live).trades, 0).avgCost;
    const manual = manualPrice(assetType, s.valuations, assetType === "illiquid" ? costOf() : 0, today);
    const nativePrice = manual ? manual.price : prices[s.ticker]?.price || 0;
    const p = positionIn(trades, assetCurrency, nativePrice, currency, live);
    if (!p) continue;
    const defaults = defaultClassification(assetType);
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
      assetType,
      manualPrice: manual,
      liquidity: s.liquidity ?? defaults.liquidity,
      horizon: s.horizon === undefined ? defaults.horizon : s.horizon,
      jurisdiction: s.jurisdiction === undefined ? defaults.jurisdiction : s.jurisdiction,
      custody: s.custody === undefined ? defaults.custody : s.custody,
      approxTrades: p.approx,
      missingTrades: p.missing,
    });
  }
  return rows;
}

/**
 * How many assets buildRows leaves out for lack of today's rates: those whose
 * own currency is not the one shown (an asset in reais, euros or francs while
 * the rates have not loaded). The screen must say so, never just a smaller total.
 */
export function assetsLeftOut(stocks: Stock[], currency: CurrencyCode, live?: RateTable | null) {
  if (live) return 0;
  return stocks.filter((s) => (isCurrency(s.currency) ? s.currency : "USD") !== currency).length;
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

/**
 * Value by maturity: each open tranche of each shown row falls in the horizon
 * of the days left to its target (or "Maturada" / "Não definido"). The sum per
 * row is the row's market value (tranches add up to the position).
 */
export function maturityAllocation(
  rows: PortfolioItem[],
  stocks: Stock[],
  transactions: Transaction[],
  today: string,
  live?: RateTable | null
): Map<MaturityBucket, number> {
  const tradesOf = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const k = `${t.portfolio_id ?? 0}:${t.ticker}`;
    const list = tradesOf.get(k) ?? [];
    list.push(t);
    tradesOf.set(k, list);
  }
  const stockOf = new Map(stocks.map((s) => [`${s.portfolio_id ?? 0}:${s.ticker}`, s]));
  const totals = new Map<MaturityBucket, number>();
  for (const r of rows) {
    const s = stockOf.get(r.key);
    // Cash is available at any time: it has no tranches to mature, it sits in the
    // range of its thesis (Curtíssimo by default).
    if (r.assetType === "cash") {
      const bucket: MaturityBucket = r.horizon ?? "none";
      totals.set(bucket, (totals.get(bucket) ?? 0) + r.marketValue);
      continue;
    }
    const target = s?.target_days === undefined ? defaultTargetDays(r.horizon) : s.target_days;
    // the same trades the position used (a trade left out for lack of a rate stays out here too)
    const used = convertTrades(tradesOf.get(r.key) ?? [], r.assetCurrency, r.currency, live).trades;
    for (const t of replayTranches(used, target).open) {
      const { bucket } = maturityOf(t.targetDate, today);
      totals.set(bucket, (totals.get(bucket) ?? 0) + t.remainingNumber * r.currentPrice);
    }
  }
  return totals;
}
