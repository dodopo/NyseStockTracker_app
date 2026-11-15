/**
 * Pure helpers for the consolidated view: tab filter and allocation slices.
 * No DOM, no React: easy to test.
 */

/** Filter key of a tab ("12"), or "none" for assets without a tab. */
export type TabFilterKey = string;
export const NO_TAB_KEY = "none";

/**
 * Toggles one tab in the filter. An empty selection means "Todas"; selecting
 * every tab (or the last one off) goes back to "Todas".
 */
export function toggleTabFilter(selected: TabFilterKey[], key: TabFilterKey, allKeys: TabFilterKey[]): TabFilterKey[] {
  const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
  const valid = next.filter((k) => allKeys.includes(k));
  return valid.length === 0 || allKeys.every((k) => valid.includes(k)) ? [] : allKeys.filter((k) => valid.includes(k));
}

/** True when an asset of this tab is shown by the filter. */
export function passesTabFilter(selected: TabFilterKey[], tabKey: TabFilterKey) {
  return selected.length === 0 || selected.includes(tabKey);
}

export type AllocationInput = { key: string; label: string; value: number; color?: string };
export type AllocationSlice = { key: string; label: string; value: number; pct: number; color?: string };

/**
 * Slices for the allocation donut, largest first. Non-positive values are
 * ignored (closed positions). Slices under `minPct` are grouped in "Outros",
 * unless only one would be grouped (then it is shown as is).
 */
export function allocationSlices(items: AllocationInput[], minPct = 3): AllocationSlice[] {
  const positive = items.filter((it) => Number.isFinite(it.value) && it.value > 0);
  const total = positive.reduce((sum, it) => sum + it.value, 0);
  if (total <= 0) return [];
  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const big = sorted.filter((it) => (it.value / total) * 100 >= minPct);
  const small = sorted.filter((it) => (it.value / total) * 100 < minPct);
  const shown = small.length > 1 ? big : sorted;
  const slices: AllocationSlice[] = shown.map((it) => ({ ...it, pct: (it.value / total) * 100 }));
  if (small.length > 1) {
    const value = small.reduce((sum, it) => sum + it.value, 0);
    slices.push({ key: "outros", label: `Outros (${small.length})`, value, pct: (value / total) * 100, color: "#5d606b" });
  }
  return slices;
}
