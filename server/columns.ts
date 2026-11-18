/**
 * Columns of assets and trades as the API returns them, in one place, so the
 * single-portfolio routes, the global view and the backup never drift apart.
 */
import type { DB } from "./db";
import { parseFxSnapshot } from "../shared/currencies";

export const STOCK_COLUMNS = `id, ticker, name, created_at, asset_type, tab_id, liquidity, horizon, jurisdiction, currency, target_days, custody`;

// Canonical decimal strings come from the *_dec columns (exact); REAL columns are legacy.
export const TX_COLUMNS = `id, ticker, type, shares_dec AS shares, price_dec AS price, date, created_at, sort_order, currency, fx, target_days`;

export type LotOut = { buyId: number; shares: string };

/**
 * Trades as returned: `fx` parsed (null while the PTAX is not known) and, on a
 * SELL, the tranches the user chose (`lots`; null = oldest first).
 */
export function createTxOut(db: DB) {
  const lotsOfUser = db.prepare(
    `SELECT l.sell_id, l.buy_id, l.shares FROM sell_lots l JOIN transactions s ON s.id = l.sell_id
     WHERE s.user_id = ? ORDER BY l.sell_id, l.buy_id`
  );
  return function txOut<T extends { id: number; type: string; fx?: unknown }>(rows: T[], userId: number) {
    const bySell = new Map<number, LotOut[]>();
    for (const l of lotsOfUser.all(userId) as Array<{ sell_id: number; buy_id: number; shares: string }>) {
      const list = bySell.get(l.sell_id) ?? [];
      list.push({ buyId: l.buy_id, shares: l.shares });
      bySell.set(l.sell_id, list);
    }
    return rows.map((r) => ({ ...r, fx: parseFxSnapshot(r.fx), lots: r.type === "SELL" ? bySell.get(r.id) ?? null : null }));
  };
}

export type ValuationOut = { id: number; date: string; price: string; note: string };

/**
 * Assets as returned: an illiquid asset carries its valuations (oldest first),
 * so every screen values it the same way; other assets carry none.
 */
export function createStockOut(db: DB) {
  const valuationsOfUser = db.prepare(
    `SELECT v.id, v.stock_id, v.date, v.price, v.note FROM valuations v JOIN stocks s ON s.id = v.stock_id
     WHERE s.user_id = ? ORDER BY v.stock_id, v.date, v.id`
  );
  return function stockOut<T extends { id: number; asset_type?: string }>(rows: T[], userId: number) {
    const byStock = new Map<number, ValuationOut[]>();
    if (rows.some((r) => r.asset_type === "illiquid")) {
      for (const v of valuationsOfUser.all(userId) as Array<ValuationOut & { stock_id: number }>) {
        const list = byStock.get(v.stock_id) ?? [];
        list.push({ id: v.id, date: v.date, price: v.price, note: v.note });
        byStock.set(v.stock_id, list);
      }
    }
    return rows.map((r) => (r.asset_type === "illiquid" ? { ...r, valuations: byStock.get(r.id) ?? [] } : r));
  };
}
