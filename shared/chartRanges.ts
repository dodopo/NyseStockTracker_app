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
  "3A": { label: "3A", title: "3 anos", auto: "1W", allowed: ["1D", "1W", "1M"] },
  "5A": { label: "5A", title: "5 anos", auto: "1W", allowed: ["1D", "1W", "1M"] },
  "10A": { label: "10A", title: "10 anos", auto: "1W", allowed: ["1D", "1W", "1M"] },
  MAX: { label: "Máx", title: "Todo o histórico disponível", auto: "1W", allowed: ["1D", "1W", "1M"] },
} as const satisfies Record<string, { label: string; title: string; auto: ChartIntervalId; allowed: readonly ChartIntervalId[] }>;

export type ChartRangeId = keyof typeof CHART_RANGES;

/** Custom period ("De" / "Até"): dates as YYYY-MM-DD, interpreted in UTC. */
export const CUSTOM_RANGE = "CUSTOM";
export const CUSTOM_MIN_DATE = "1990-01-01";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Candle sizes for a custom period, by its length. Minute candles only for short
 * periods, so a request never needs dozens of provider calls.
 */
export function customRangeConfig(fromMs: number, toMs: number): { auto: ChartIntervalId; allowed: ChartIntervalId[] } {
  const days = (toMs - fromMs) / DAY_MS;
  if (days <= 2) return { auto: "5m", allowed: ["5m", "15m", "30m", "1h"] };
  if (days <= 7) return { auto: "30m", allowed: ["5m", "15m", "30m", "1h"] };
  if (days <= 31) return { auto: "1h", allowed: ["30m", "1h", "1D"] };
  if (days <= 92) return { auto: "1D", allowed: ["1h", "1D", "1W"] };
  if (days <= 400) return { auto: "1D", allowed: ["1D", "1W"] };
  return { auto: "1W", allowed: ["1D", "1W", "1M"] };
}

/**
 * Validates a custom period. Returns UTC ms (end of the "Até" day) or an error
 * message in Portuguese. `now` limits the end to today.
 */
export function parseCustomRange(from: unknown, to: unknown, now: number): { from: number; to: number } | { error: string } {
  if (typeof from !== "string" || typeof to !== "string" || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { error: "Informe as datas no formato AAAA-MM-DD" };
  }
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`) + DAY_MS - 1;
  if (!Number.isFinite(f) || !Number.isFinite(t) || new Date(f).toISOString().slice(0, 10) !== from || new Date(t).toISOString().slice(0, 10) !== to) {
    return { error: "Data inválida" };
  }
  if (from < CUSTOM_MIN_DATE) return { error: `A data inicial deve ser a partir de ${CUSTOM_MIN_DATE.split("-").reverse().join("/")}` };
  if (f >= t || from > to) return { error: "A data inicial deve ser antes da final" };
  if (f > now) return { error: "A data inicial não pode estar no futuro" };
  return { from: f, to: Math.min(t, now) };
}

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
