/**
 * Long-term moving averages, computed from daily closes.
 *
 * 200-day: plain average of the last 200 daily closes.
 * 200-week / 50-month: average of the last N weekly (monthly) closes, where the
 * current week (month) counts with the close of the day being drawn. So each day
 * only uses data known on that day (no look-ahead), like TradingView's daily
 * view of a weekly average.
 */

export const MOVING_AVERAGES = {
  "200D": { label: "MM 200 dias", short: "MM200D", period: 200, unit: "day", color: "#f7c948" },
  "200W": { label: "MM 200 semanas", short: "MM200S", period: 200, unit: "week", color: "#e040fb" },
  "50M": { label: "MM 50 meses", short: "MM50M", period: 50, unit: "month", color: "#00bcd4" },
} as const;

export type MovingAverageId = keyof typeof MOVING_AVERAGES;
export const MOVING_AVERAGE_IDS = Object.keys(MOVING_AVERAGES) as MovingAverageId[];

export function isMovingAverageId(value: unknown): value is MovingAverageId {
  return typeof value === "string" && Object.hasOwn(MOVING_AVERAGES, value);
}

export type DailyClose = { t: number; c: number };
export type SeriesPoint = { t: number; v: number };

const DAY = 86_400_000;

/** Bucket of a daily candle: its day, its ISO week (Monday, UTC date) or its month. */
function bucketKey(t: number, unit: "day" | "week" | "month") {
  // Daily candles start at midnight New York (stocks) or 00:00 UTC (crypto): +12 h gives the session date in UTC.
  const d = new Date(t + 12 * 3_600_000);
  if (unit === "month") return d.getUTCFullYear() * 12 + d.getUTCMonth();
  const day = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY);
  if (unit === "day") return day;
  return day - ((d.getUTCDay() + 6) % 7); // Monday of that week
}

/** Moving average for each daily close (only where there is enough history). */
export function movingAverage(daily: DailyClose[], id: MovingAverageId): SeriesPoint[] {
  const { period, unit } = MOVING_AVERAGES[id];
  const out: SeriesPoint[] = [];
  const completed: number[] = []; // closes of finished buckets
  let completedSum = 0;
  let currentKey: number | null = null;
  let currentClose = 0;

  for (const day of daily) {
    const key = bucketKey(day.t, unit);
    if (currentKey !== null && key !== currentKey) {
      completed.push(currentClose);
      completedSum += currentClose;
      if (completed.length > period - 1) completedSum -= completed[completed.length - period];
    }
    currentKey = key;
    currentClose = day.c;
    if (completed.length >= period - 1) {
      out.push({ t: day.t, v: (completedSum + currentClose) / period });
    }
  }
  return out;
}

/**
 * Value of a daily series for each chart candle: the last point at or before the
 * candle's close (the start of the next candle). Works for any candle size.
 */
export function alignToCandles(series: SeriesPoint[], candleTimes: number[]): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  let j = -1;
  for (let i = 0; i < candleTimes.length; i++) {
    const boundary = i + 1 < candleTimes.length ? candleTimes[i + 1] : Number.POSITIVE_INFINITY;
    while (j + 1 < series.length && series[j + 1].t < boundary) j++;
    if (j >= 0) out.push({ t: candleTimes[i], v: series[j].v });
  }
  return out;
}

/** How many daily candles a moving average needs before its first value (approximate, for messages). */
export function daysNeeded(id: MovingAverageId) {
  const { period, unit } = MOVING_AVERAGES[id];
  return unit === "day" ? period : unit === "week" ? period * 7 : period * 30;
}
