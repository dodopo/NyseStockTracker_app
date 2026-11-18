/**
 * Assets without a market quote (v0.16.0):
 * - illiquid: valued by the user with dated valuations (price per unit, in the
 *   asset's own currency). Today's value is the latest valuation on or before
 *   today; with none yet, the asset is valued at its average cost ("pelo custo").
 * - cash: one unit = 1 of its own currency, so the quantity is the balance.
 * The same rules run in the browser (every screen) and in the tests.
 */
import { daysBetween } from "./tranches";
import type { AssetType } from "./assetTypes";

/** A valuation older than this is flagged on screen (an annual appraisal; decided 18/11/2026). */
export const STALE_VALUATION_DAYS = 365;
export const VALUATION_NOTE_MAX = 200;
/** Valuations kept per asset (one per date). */
export const VALUATIONS_PER_ASSET_MAX = 1000;
/** Valuations kept per account: never more than a backup of the account can restore. */
export const VALUATIONS_PER_ACCOUNT_MAX = 20_000;

export type Valuation = { id: number; date: string; price: string; note: string };

export type ManualPrice = {
  /** Price of one unit in the asset's own currency. */
  price: number;
  source: "valuation" | "cost" | "cash";
  /** Date of the valuation used (source "valuation"). */
  date: string | null;
  /** Days since that valuation (source "valuation"). */
  ageDays: number | null;
  stale: boolean;
};

/** Latest valuation on or before `today` (a future-dated one does not count yet). */
export function latestValuation<V extends { date: string; id?: number }>(valuations: readonly V[] | null | undefined, today: string): V | null {
  let best: V | null = null;
  for (const v of valuations ?? []) {
    if (v.date > today) continue;
    if (!best || v.date > best.date || (v.date === best.date && (v.id ?? 0) > (best.id ?? 0))) best = v;
  }
  return best;
}

/**
 * Today's price of a manual asset, or null for a market asset (its quote comes
 * from the market). `avgCost` is the position's average cost in the asset's
 * own currency (used when an illiquid asset has no valuation yet).
 */
export function manualPrice(
  assetType: AssetType,
  valuations: readonly Valuation[] | null | undefined,
  avgCost: number,
  today: string
): ManualPrice | null {
  if (assetType === "cash") return { price: 1, source: "cash", date: null, ageDays: null, stale: false };
  if (assetType !== "illiquid") return null;
  const v = latestValuation(valuations, today);
  if (!v) return { price: Number.isFinite(avgCost) ? avgCost : 0, source: "cost", date: null, ageDays: null, stale: false };
  const ageDays = daysBetween(v.date, today);
  return { price: Number(v.price), source: "valuation", date: v.date, ageDays, stale: ageDays > STALE_VALUATION_DAYS };
}
