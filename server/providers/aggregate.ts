import { DAY, type Candle } from "./types";

/** Start of the bucket a timestamp belongs to (UTC): 30 minutes, ISO week (Monday) or month. */
export function bucketStart(t: number, bucket: "30m" | "1W" | "1M") {
  if (bucket === "30m") return t - (t % (30 * 60_000));
  const d = new Date(t);
  if (bucket === "1M") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY;
}

/**
 * Builds bigger candles from smaller ones (input sorted by time): open of the
 * first, close of the last, highest high, lowest low, summed volume.
 */
export function aggregateCandles(candles: Candle[], bucket: "30m" | "1W" | "1M"): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const start = bucketStart(c.t, bucket);
    const last = out[out.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else {
      out.push({ t: start, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }
  return out;
}
