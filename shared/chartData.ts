/**
 * Pure helpers for the price chart (no DOM, no chart library): easy to test.
 */

export type ChartCandle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type ChartTrade = { id?: number; type: "BUY" | "SELL"; shares: string; price: string; date: string };

const NY_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyParts(ms: number) {
  const p: Record<string, string> = {};
  for (const part of NY_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** US market session date (New York) of a timestamp. */
export function nySessionDate(ms: number) {
  return nyParts(ms).date;
}

/**
 * Calendar date a candle belongs to. Stock candles follow the New York session;
 * crypto candles start at 00:00 UTC, so their date is the UTC date (in Brazil,
 * 00:00 UTC is still 21:00 of the previous day).
 */
export function candleDate(ms: number, crypto: boolean) {
  return crypto ? new Date(ms).toISOString().slice(0, 10) : nySessionDate(ms);
}

/**
 * Time handed to the chart library. The library places day and month marks in
 * UTC, so intraday candles are shifted to local wall-clock time: marks then fall
 * on local midnights and month starts (otherwise November started at 31/10 21:00
 * in Brazil and was labeled "out."). Daily or longer candles are not shifted:
 * their UTC date already is the candle date (see candleDate).
 */
export function chartTimeMs(ms: number, intraday: boolean, offsetMinutes = new Date(ms).getTimezoneOffset()) {
  return intraday ? ms - offsetMinutes * 60_000 : ms;
}

/** Time zone in which a candle's date must be shown (see candleDate). */
export function candleTimeZone(crypto: boolean) {
  return crypto ? "UTC" : "America/New_York";
}

const INTERVAL_MINUTES: Record<string, number> = { "5m": 5, "15m": 15, "30m": 30, "1h": 60 };
const REGULAR_OPEN = 9 * 60 + 30; // 09:30 New York
const REGULAR_CLOSE = 16 * 60; // 16:00 New York

/**
 * Keeps only candles that overlap the regular session (09:30–16:00 New York).
 * Daily and longer candles are returned unchanged. A 1-hour candle starting at
 * 09:00 is kept because it contains 09:30–10:00.
 */
export function filterRegularSession<T extends { t: number }>(candles: T[], interval: string): T[] {
  const size = INTERVAL_MINUTES[interval];
  if (!size) return candles;
  return candles.filter((c) => {
    const start = nyParts(c.t).minutes;
    return start + size > REGULAR_OPEN && start < REGULAR_CLOSE;
  });
}

export type CandleTrades = { buys: ChartTrade[]; sells: ChartTrade[] };

/**
 * Groups trades by the candle they belong to: the last candle that starts on or
 * before the trade's session date. Trades outside the visible range are left out.
 */
export function groupTradesByCandle(candles: { t: number }[], trades: ChartTrade[], crypto = false) {
  const groups = new Map<number, CandleTrades>();
  if (!candles.length) return groups;

  const dates = candles.map((c) => candleDate(c.t, crypto));
  const first = dates[0];
  const last = dates[dates.length - 1];

  for (const trade of trades) {
    if (trade.date < first || trade.date > last) continue;
    let i = dates.length - 1;
    while (i > 0 && dates[i] > trade.date) i--;
    const group = groups.get(i) ?? { buys: [], sells: [] };
    (trade.type === "BUY" ? group.buys : group.sells).push(trade);
    groups.set(i, group);
  }

  for (const group of groups.values()) {
    const byDate = (a: ChartTrade, b: ChartTrade) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0);
    group.buys.sort(byDate);
    group.sells.sort(byDate);
  }
  return groups;
}
