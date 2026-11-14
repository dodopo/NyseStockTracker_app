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
  MAX: { label: "Máx", title: "Máximo do plano grátis (2 anos)", auto: "1W", allowed: ["1D", "1W", "1M"] },
} as const satisfies Record<string, { label: string; title: string; auto: ChartIntervalId; allowed: readonly ChartIntervalId[] }>;

export type ChartRangeId = keyof typeof CHART_RANGES;

const INTRADAY: readonly string[] = ["5m", "15m", "30m", "1h"];

/** True for candle sizes smaller than one day (the chart then shows the time of day). */
export function isIntraday(interval: string) {
  return INTRADAY.includes(interval);
}
