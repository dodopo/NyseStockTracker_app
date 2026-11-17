/**
 * Columns of assets and trades as the API returns them, in one place, so the
 * single-portfolio routes, the global view and the backup never drift apart.
 */
import { parseFxSnapshot } from "../shared/currencies";

export const STOCK_COLUMNS = `id, ticker, name, created_at, asset_type, tab_id, liquidity, horizon, jurisdiction, currency`;

// Canonical decimal strings come from the *_dec columns (exact); REAL columns are legacy.
export const TX_COLUMNS = `id, ticker, type, shares_dec AS shares, price_dec AS price, date, created_at, sort_order, currency, fx`;

/** `fx` is stored as JSON text: returned parsed (null while the PTAX is not known yet). */
export function txOut<T extends { fx?: unknown }>(row: T) {
  return { ...row, fx: parseFxSnapshot(row.fx) };
}

export function txListOut<T extends { fx?: unknown }>(rows: T[]) {
  return rows.map(txOut);
}
