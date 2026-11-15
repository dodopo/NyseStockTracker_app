/**
 * Chart periods and candle sizes, shared by server (validation) and browser
 * (buttons). Each period has a default candle size, like TradingView, and the
 * sizes the user may pick instead.
 */
export const CHART_INTERVALS = {
  "5m": "5 min",
  "15m": "15 min",
  "30m": "30 min",
  "1h": "1 hora",
  "1D": "1 dia",
  "1W": "1 semana",
  "1M": "1 mês",
} as const;

export type ChartIntervalId = keyof typeof CHART_INTERVALS;

export const CHART_RANGES = {
  "1D": { label: "1D", title: "Último pregão", auto: "5m", allowed: ["5m", "15m", "30m", "1h"] },
  "1S": { label: "1S", title: "1 semana", auto: "30m", allowed: ["5m", "15m", "30m", "1h"] },
  "1M": { label: "1M", title: "1 mês", auto: "1h", allowed: ["15m", "30m", "1h", "1D"] },
  "3M": { label: "3M", title: "3 meses", auto: "1D", allowed: ["1h", "1D", "1W"] },
  YTD: { label: "YTD", title: "No ano", auto: "1D", allowed: ["1D", "1W"] },
  "1A": { label: "1A", title: "1 ano", auto: "1D", allowed: ["1D", "1W", "1M"] },
  MAX: { label: "Máx", title: "Todo o histórico disponível", auto: "1W", allowed: ["1D", "1W", "1M"] },
} as const satisfies Record<string, { label: string; title: string; auto: ChartIntervalId; allowed: readonly ChartIntervalId[] }>;

export type ChartRangeId = keyof typeof CHART_RANGES;

const INTRADAY: readonly string[] = ["5m", "15m", "30m", "1h"];

/** True for candle sizes smaller than one day (the chart then shows the time of day). */
export function isIntraday(interval: string) {
  return INTRADAY.includes(interval);
}

/** Where the chart data came from (shown under the chart). */
export const DATA_SOURCES: Record<string, { label: string; delay: string }> = {
  alpaca: { label: "Alpaca", delay: "todas as bolsas dos EUA, 15 min de atraso; histórico desde 2016" },
  coinbase: { label: "Coinbase", delay: "tempo real; histórico desde a listagem" },
  binance: { label: "Binance", delay: "tempo real, par em USDT" },
  massive: { label: "Massive", delay: "plano grátis: até o dia anterior, 2 anos de histórico" },
};

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "1D": 86_400_000,
  "1W": 7 * 86_400_000,
  "1M": 31 * 86_400_000,
};

/** True while the regular US session is open (09:30–16:00 New York, Monday to Friday). */
export function isUsMarketOpen(now: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/**
 * True when the last candle is older than the data source promises: crypto is
 * real time (24/7); stocks are expected up to ~15 min behind while the market is
 * open (outside the session the last candle is naturally older).
 */
export function isChartStale(lastCandleT: number, interval: string, crypto: boolean, now: number) {
  const size = INTERVAL_MS[interval] ?? 86_400_000;
  const lag = now - (lastCandleT + size); // time since the last candle closed
  if (crypto) return lag > 30 * 60_000;
  return isUsMarketOpen(now) && lag > 45 * 60_000;
}
