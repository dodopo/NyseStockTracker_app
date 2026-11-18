import { Big, parsePositiveDecimal } from "../../../shared/decimal";
import type { Tranche } from "../../../shared/tranches";

/**
 * What the user typed for each open tranche in the sale form, checked, and the
 * exact total: when tranches are chosen, the quantity sold IS this total.
 */
export function evaluatePicks(openTranches: Tranche[], picked: Record<number, string>) {
  const picks = openTranches.map((t) => {
    const raw = (picked[t.buyId!] ?? "").trim();
    const value = raw === "" ? null : parsePositiveDecimal(raw);
    return { tranche: t, raw, value, invalid: raw !== "" && !value, over: !!value && new Big(value).gt(new Big(t.remaining)) };
  });
  const sum = picks.reduce((acc, p) => (p.value ? acc.plus(new Big(p.value)) : acc), new Big(0));
  return { picks, sum, total: sum.gt(0) ? sum.toFixed() : "" };
}
