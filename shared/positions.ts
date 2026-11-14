import { Big, toNumber } from "./decimal";
import { compareTransactions } from "./validation";

export type PositionInputTx = {
  id?: number;
  type: "BUY" | "SELL";
  shares: string | number;
  price: string | number;
  date: string;
  sort_order?: number;
};

export type Position = {
  /** Exact quantity held, as a canonical decimal string. */
  quantity: string;
  shares: number;
  avgCost: number;
  openCost: number;
  marketValue: number;
  realizedPnL: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  totalPnL: number;
  totalPnLPct: number;
};

/**
 * Average-price position (broker style, "preço médio"), computed with exact
 * decimals. Buys raise the average; sells realize P/L against the current
 * average and do not change it. A sell larger than the position is ignored
 * (the server already refuses it).
 */
export function calculatePosition(transactions: PositionInputTx[], currentPrice: number): Position {
  let shares = new Big(0);
  let openCost = new Big(0);
  let realized = new Big(0);

  for (const t of [...transactions].sort(compareTransactions)) {
    const qty = new Big(t.shares);
    const px = new Big(t.price);

    if (t.type === "BUY") {
      shares = shares.plus(qty);
      openCost = openCost.plus(qty.times(px));
      continue;
    }

    if (qty.gt(shares)) continue;
    const avg = shares.gt(0) ? openCost.div(shares) : new Big(0);
    realized = realized.plus(px.minus(avg).times(qty));
    shares = shares.minus(qty);
    openCost = shares.eq(0) ? new Big(0) : openCost.minus(avg.times(qty));
  }

  const price = new Big(Number.isFinite(currentPrice) ? currentPrice : 0);
  const avgCost = shares.gt(0) ? openCost.div(shares) : new Big(0);
  const marketValue = shares.times(price);
  const unrealized = marketValue.minus(openCost);
  const total = realized.plus(unrealized);

  return {
    quantity: shares.toFixed(),
    shares: toNumber(shares),
    avgCost: toNumber(avgCost),
    openCost: toNumber(openCost),
    marketValue: toNumber(marketValue),
    realizedPnL: toNumber(realized),
    unrealizedPnL: toNumber(unrealized),
    unrealizedPnLPct: openCost.gt(0) ? toNumber(unrealized.div(openCost).times(100)) : 0,
    totalPnL: toNumber(total),
    totalPnLPct: openCost.gt(0) ? toNumber(total.div(openCost).times(100)) : 0,
  };
}
