/**
 * Tranches (lots) and maturity. Each BUY is a tranche with a target date
 * (purchase date + target days). SELLs consume tranches: the oldest first by
 * default, or the ones the user chose. This only drives the maturity view; the
 * average price and cost stay as in shared/positions.ts.
 *
 * The same replay runs on the server (to refuse impossible choices) and in the
 * browser (to show the ladder), so both always agree.
 */
import { Big, toNumber } from "./decimal";
import { HORIZON_MAX_DAYS, horizonOfDays, type Horizon } from "./classification";
import { compareTransactions } from "./validation";

/** Default target of the open-ended "Longuíssimo" (10 years; editable). */
export const ULTRA_LONG_DEFAULT_DAYS = 3650;
export const TARGET_DAYS_MAX = 36500; // 100 years

/** Target days that a horizon starts with: its upper bound (Longuíssimo: 3,650). */
export function defaultTargetDays(horizon: Horizon | null | undefined): number | null {
  if (!horizon) return null;
  return horizon === "ultra_long" ? ULTRA_LONG_DEFAULT_DAYS : HORIZON_MAX_DAYS[horizon];
}

export type LotChoice = { buyId: number; shares: string };

export type TrancheTrade = {
  id?: number;
  type: "BUY" | "SELL";
  shares: string | number;
  price: string | number;
  date: string;
  sort_order?: number;
  /** BUY: this tranche's own target (null/undefined = the asset's). */
  target_days?: number | null;
  /** SELL: tranches chosen by the user (null/undefined = oldest first). */
  lots?: LotChoice[] | null;
};

export type Tranche<T extends TrancheTrade = TrancheTrade> = {
  buy: T;
  buyId: number | undefined;
  /** Exact remaining quantity (canonical decimal string). */
  remaining: string;
  remainingNumber: number;
  /** Effective target in days (own, else the asset's), or null when none. */
  targetDays: number | null;
  /** YYYY-MM-DD, or null without a target. */
  targetDate: string | null;
};

export type TrancheResult<T extends TrancheTrade = TrancheTrade> = {
  open: Tranche<T>[];
  /** Problems found while replaying (a chosen tranche that does not have the quantity, ...). */
  errors: string[];
};

const DAY_MS = 86_400_000;
export function addDays(iso: string, days: number) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/**
 * Replays the trades of ONE asset. SELLs with `lots` take exactly those
 * quantities from those tranches; the others take from the oldest open ones.
 */
export function replayTranches<T extends TrancheTrade>(trades: T[], assetTargetDays: number | null): TrancheResult<T> {
  type Lot = { buy: T; remaining: Big };
  const lots: Lot[] = [];
  const errors: string[] = [];

  for (const t of [...trades].sort(compareTransactions)) {
    const qty = new Big(t.shares);
    if (t.type === "BUY") {
      lots.push({ buy: t, remaining: qty });
      continue;
    }
    if (t.lots && t.lots.length) {
      let sum = new Big(0);
      for (const choice of t.lots) {
        const take = new Big(choice.shares);
        sum = sum.plus(take);
        const lot = lots.find((l) => l.buy.id === choice.buyId);
        if (!lot) {
          errors.push(`A venda de ${t.date} escolhe uma compra que não existe antes dela`);
          continue;
        }
        if (take.lte(0) || take.gt(lot.remaining)) {
          errors.push(`A venda de ${t.date} tira ${take.toFixed()} da compra de ${lot.buy.date}, que só tem ${lot.remaining.toFixed()} naquele momento`);
          continue;
        }
        lot.remaining = lot.remaining.minus(take);
      }
      if (!sum.eq(qty)) errors.push(`As tranches escolhidas na venda de ${t.date} somam ${sum.toFixed()}, e a venda é de ${qty.toFixed()}`);
      continue;
    }
    // Oldest first.
    let left = qty;
    for (const lot of lots) {
      if (left.lte(0)) break;
      const take = lot.remaining.lt(left) ? lot.remaining : left;
      lot.remaining = lot.remaining.minus(take);
      left = left.minus(take);
    }
    if (left.gt(0)) errors.push(`A venda de ${t.date} é maior que a posição naquele dia`);
  }

  const open = lots
    .filter((l) => l.remaining.gt(0))
    .map((l) => {
      const targetDays = l.buy.target_days ?? assetTargetDays ?? null;
      return {
        buy: l.buy,
        buyId: l.buy.id,
        remaining: l.remaining.toFixed(),
        remainingNumber: toNumber(l.remaining),
        targetDays,
        targetDate: targetDays === null ? null : addDays(l.buy.date, targetDays),
      };
    });
  return { open, errors };
}

export type MaturityBucket = Horizon | "matured" | "none";

/** Where a tranche is today: days to its target and the horizon that fits them. */
export function maturityOf(targetDate: string | null, today: string): { daysLeft: number | null; bucket: MaturityBucket } {
  if (!targetDate) return { daysLeft: null, bucket: "none" };
  const daysLeft = daysBetween(today, targetDate);
  return { daysLeft, bucket: daysLeft <= 0 ? "matured" : horizonOfDays(daysLeft) };
}

/** Today as YYYY-MM-DD in the browser's (or server's) local time. */
export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
