import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { CalendarRange, KeyRound, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { ApiError, errorMessage } from "../../api/client";
import { marketApi } from "../../api/endpoints";
import { Card } from "../../components/ui";
import { cn, formatPercent, formatPrice, formatQuantity } from "../../lib/utils";
import type { Candle, Transaction } from "../../types";
import {
  CHART_INTERVALS,
  CHART_RANGES,
  CUSTOM_MIN_DATE,
  CUSTOM_RANGE,
  DATA_SOURCES,
  INTERVAL_MS,
  customRangeConfig,
  isChartStale,
  isIntraday,
  parseCustomRange,
  type ChartRangeId,
} from "../../../shared/chartRanges";
import { MOVING_AVERAGES, MOVING_AVERAGE_IDS, alignToCandles, daysNeeded, type MovingAverageId } from "../../../shared/indicators";
import { candleTimeZone, chartTimeMs, filterRegularSession, groupTradesByCandle, type ChartTrade } from "../../../shared/chartData";
import { ASSET_TYPES, displaySymbol, type AssetType } from "../../../shared/assetTypes";

const COLORS = {
  bg: "#1e222d",
  border: "#2a2e39",
  text: "#d1d4dc",
  up: "#089981",
  down: "#f23645",
  accent: "#2962ff",
  live: "#ff9800",
};

const MA_STORAGE_KEY = "nyse.chart.movingAverages";

/** Moving averages the user turned on (remembered in this browser only). */
function loadEnabledMAs(): MovingAverageId[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MA_STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? MOVING_AVERAGE_IDS.filter((id) => saved.includes(id)) : [];
  } catch {
    return [];
  }
}

function saveEnabledMAs(ids: MovingAverageId[]) {
  try {
    window.localStorage.setItem(MA_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // private window or blocked storage: the choice just is not remembered
  }
}

type MaState =
  | { status: "idle" | "loading" }
  | { status: "ready"; series: Partial<Record<MovingAverageId, Array<{ t: number; v: number }>>>; firstDay: number | null }
  | { status: "error"; message: string };

/** Chart time (seconds) for a candle; intraday candles shifted to local time (see chartTimeMs). */
const toChartTime = (ms: number, intraday: boolean) => Math.floor(chartTimeMs(ms, intraday) / 1000) as UTCTimestamp;
const fromTime = (time: Time) => (typeof time === "number" ? time * 1000 : 0);

function formatVolume(v: number) {
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

/**
 * Date (and time, for intraday candles) of a candle. Intraday: local time.
 * Daily or longer: the candle's own date (UTC for crypto, New York for stocks),
 * otherwise a crypto candle of 31/10 (00:00 UTC) shows as 30/10 in Brazil.
 */
function formatWhen(ms: number, intraday: boolean, crypto: boolean) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(intraday ? { hour: "2-digit", minute: "2-digit" } : { timeZone: candleTimeZone(crypto) }),
  }).format(new Date(ms));
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; interval: string; candles: Candle[]; stale: boolean; source: string; fallbackFrom?: string; requestedFrom?: number }
  | { status: "error"; message: string; missingKey: boolean };

export function PriceChart({
  symbol,
  assetType,
  transactions,
  avgCost,
  hasPosition,
  livePrice,
  liveChangePct,
  name,
  onOpenSettings,
}: {
  symbol: string;
  assetType: AssetType;
  transactions: Transaction[];
  avgCost: number;
  hasPosition: boolean;
  /** Current quote (Finnhub/Binance), drawn as the "Agora" line. */
  livePrice?: number;
  /** Change of the live quote (%), shown with the price in full screen. */
  liveChangePct?: number;
  /** Asset name (e.g. "APPLE INC"), shown in full screen. */
  name?: string;
  onOpenSettings: () => void;
}) {
  const [range, setRange] = useState<ChartRangeId | typeof CUSTOM_RANGE>("1A");
  // Custom period: the applied dates, and the draft being edited in the date fields.
  const today = new Date().toISOString().slice(0, 10);
  const [customDates, setCustomDates] = useState<{ from: string; to: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({
    from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  }));
  const [customError, setCustomError] = useState<string | null>(null);
  const [interval, setCandleSize] = useState<string>("auto");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Intraday: regular session only (09:30–16:00 New York) unless the user asks for extended hours.
  const [extended, setExtended] = useState(false);
  const [enabledMAs, setEnabledMAs] = useState<MovingAverageId[]>(loadEnabledMAs);
  const [ma, setMa] = useState<MaState>({ status: "idle" });

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const pmLineRef = useRef<IPriceLine | null>(null);
  const liveLineRef = useRef<IPriceLine | null>(null);
  const livePriceRef = useRef<number | null>(null);
  // The "Agora" line only widens the price scale when the chart reaches today.
  const reachesNowRef = useRef(true);
  const maSeriesRef = useRef(new Map<MovingAverageId, ISeriesApi<"Line">>());
  const indexByTimeRef = useRef(new Map<number, number>());
  const intradayRef = useRef(false);
  // Crypto candles are dated in UTC, stock candles in New York (see formatWhen).
  const cryptoRef = useRef(false);
  cryptoRef.current = ASSET_TYPES[assetType].hours !== "regular";
  const chartTime = (ms: number) => toChartTime(ms, intradayRef.current);

  // --- create the chart once -------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        attributionLogo: true, // TradingView link required by the Lightweight Charts license
      },
      grid: { vertLines: { color: COLORS.border }, horzLines: { color: COLORS.border } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: {
        borderColor: COLORS.border,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          // Chart times are local wall-clock (intraday) or the candle date (daily+), both read in UTC.
          const d = new Date(fromTime(time));
          const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { ...o, timeZone: "UTC" }).format(d);
          if (type === TickMarkType.Year) return fmt({ year: "numeric" });
          if (type === TickMarkType.Month) return fmt({ month: "short" });
          if (type === TickMarkType.DayOfMonth) return fmt({ day: "2-digit", month: "short" });
          return fmt({ hour: "2-digit", minute: "2-digit" });
        },
      },
      localization: {
        locale: "pt-BR",
        timeFormatter: (time: Time) =>
          new Intl.DateTimeFormat("pt-BR", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            ...(intradayRef.current ? { hour: "2-digit", minute: "2-digit" } : {}),
            timeZone: "UTC",
          }).format(new Date(fromTime(time))),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    // Small bottom margin: on long periods starting near zero a bigger one showed negative prices on the axis.
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.02 } });
    // Keep the "Agora" line inside the visible price range.
    candles.applyOptions({
      autoscaleInfoProvider: (original: () => any) => {
        const res = original();
        const p = livePriceRef.current;
        if (!res || !p || !reachesNowRef.current) return res;
        return { ...res, priceRange: { minValue: Math.min(res.priceRange.minValue, p), maxValue: Math.max(res.priceRange.maxValue, p) } };
      },
    });

    for (const id of MOVING_AVERAGE_IDS) {
      const line = chart.addSeries(LineSeries, {
        color: MOVING_AVERAGES[id].color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: "", // names go to the legend, so they never cover the candles
        visible: false,
        // Intraday: long averages can be far from today's prices; the scale follows the candles.
        autoscaleInfoProvider: (original: () => any) => (intradayRef.current ? null : original()),
      });
      maSeriesRef.current.set(id, line);
    }

    // Volume in its own pane below the prices (sharing the price area made the axis show negative prices).
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false },
      1
    );
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    const sizeVolumePane = () => chart.panes()[1]?.setHeight(Math.max(56, Math.round(el.clientHeight * 0.18)));
    sizeVolumePane();
    const resize = new ResizeObserver(() => sizeVolumePane());
    resize.observe(el);

    const onMove = (param: MouseEventParams<Time>) => {
      if (!param.time || !param.point) {
        setHoverIndex(null);
        return;
      }
      const idx = indexByTimeRef.current.get(param.time as number);
      setHoverIndex(idx ?? null);
    };
    chart.subscribeCrosshairMove(onMove);

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    volumeSeriesRef.current = volume;
    markersRef.current = createSeriesMarkers(candles, []);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
      pmLineRef.current = null;
      liveLineRef.current = null;
      maSeriesRef.current = new Map();
    };
    // Full screen renders the chart in a portal (a new container), so the chart is rebuilt.
  }, [fullscreen]);

  // --- load candles when symbol / period / candle size change -----------------
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setHoverIndex(null);
    marketApi
      .candles(symbol, range, interval, range === CUSTOM_RANGE && customDates ? customDates : undefined)
      .then((data) => {
        if (!cancelled) {
          setState({
            status: "ready",
            interval: data.interval,
            candles: data.candles,
            stale: !!data.stale,
            source: data.source,
            fallbackFrom: data.fallbackFrom,
            requestedFrom: data.requestedFrom,
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const missingKey = error instanceof ApiError && (error.code === "CHART_KEY_MISSING" || error.code === "MASSIVE_KEY_MISSING");
        setState({ status: "error", message: errorMessage(error, "Não foi possível carregar o gráfico."), missingKey });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range, interval, customDates]);

  // Allowed candle sizes for the current period (custom: by its length).
  const rangeConfig = useMemo(() => {
    if (range !== CUSTOM_RANGE || !customDates) return CHART_RANGES[range === CUSTOM_RANGE ? "1A" : range];
    const span = parseCustomRange(customDates.from, customDates.to, Date.now());
    return "error" in span ? CHART_RANGES["1A"] : customRangeConfig(span.from, span.to);
  }, [range, customDates]);

  const activeInterval = state.status === "ready" ? state.interval : rangeConfig.auto;
  const intraday = isIntraday(activeInterval);
  // US stocks have a regular session; crypto trades 24/7.
  const hasSession = ASSET_TYPES[assetType].hours === "regular";
  const sessionFilter = intraday && hasSession && !extended;
  const candles = useMemo(() => {
    const all = state.status === "ready" ? state.candles : [];
    return sessionFilter ? filterRegularSession(all, activeInterval) : all;
  }, [state, sessionFilter, activeInterval]);

  // --- moving averages: fetched for the chart's first date when any is turned on ---
  const firstT = candles[0]?.t ?? null;
  const enabledKey = enabledMAs.join(",");
  useEffect(() => {
    if (!enabledKey || firstT === null) {
      setMa({ status: "idle" });
      return;
    }
    let cancelled = false;
    setMa({ status: "loading" });
    marketApi
      .indicators(symbol, enabledKey.split(","), firstT)
      .then((data) => !cancelled && setMa({ status: "ready", series: data.series, firstDay: data.firstDay }))
      .catch((error) => !cancelled && setMa({ status: "error", message: errorMessage(error, "Não foi possível calcular as médias.") }));
    return () => {
      cancelled = true;
    };
  }, [symbol, enabledKey, firstT]);

  const maAligned = useMemo(() => {
    const out = new Map<MovingAverageId, Array<{ t: number; v: number }>>();
    if (ma.status !== "ready") return out;
    const times = candles.map((c) => c.t);
    const size = state.status === "ready" ? INTERVAL_MS[state.interval] : undefined;
    for (const id of enabledMAs) out.set(id, alignToCandles(ma.series[id] ?? [], times, size));
    return out;
  }, [ma, candles, enabledMAs, state]);

  const toggleMA = (id: MovingAverageId) => {
    setEnabledMAs((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : MOVING_AVERAGE_IDS.filter((x) => x === id || current.includes(x));
      saveEnabledMAs(next);
      return next;
    });
  };

  // Trades grouped by candle: one arrow per candle and type; details go to the legend.
  const tradesByCandle = useMemo(() => groupTradesByCandle(candles, transactions as ChartTrade[], !hasSession), [candles, transactions, hasSession]);

  // --- push data, markers and the average-price line into the chart ------------
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !series || !volume) return;

    intradayRef.current = intraday;
    chart.applyOptions({ timeScale: { timeVisible: intraday } });

    indexByTimeRef.current = new Map(candles.map((c, i) => [chartTime(c.t) as number, i]));
    series.setData(candles.map((c) => ({ time: chartTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    volume.setData(
      candles.map((c) => ({
        time: chartTime(c.t),
        value: c.v,
        color: c.c >= c.o ? "rgba(8,153,129,0.35)" : "rgba(242,54,69,0.35)",
      }))
    );

    // My trades: arrows only (labels collided when trades were close); details in the legend.
    const markers: SeriesMarker<Time>[] = [];
    for (const [index, group] of tradesByCandle) {
      const time = chartTime(candles[index].t);
      if (group.buys.length) {
        markers.push({ time, position: "belowBar", shape: "arrowUp", color: COLORS.up, id: `buy-${index}` });
      }
      if (group.sells.length) {
        markers.push({ time, position: "aboveBar", shape: "arrowDown", color: COLORS.down, id: `sell-${index}` });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current?.setMarkers(markers);

    if (pmLineRef.current) {
      series.removePriceLine(pmLineRef.current);
      pmLineRef.current = null;
    }
    if (hasPosition && avgCost > 0) {
      pmLineRef.current = series.createPriceLine({
        price: avgCost,
        color: COLORS.accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "", // shown in the legend
      });
    }

    chart.timeScale().fitContent();
  }, [candles, tradesByCandle, avgCost, hasPosition, intraday, fullscreen]);

  // --- moving average lines -----------------------------------------------------
  useEffect(() => {
    for (const id of MOVING_AVERAGE_IDS) {
      const line = maSeriesRef.current.get(id);
      if (!line) continue;
      const points = maAligned.get(id) ?? [];
      line.setData(points.map((p) => ({ time: chartTime(p.t), value: p.v })));
      line.applyOptions({ visible: enabledMAs.includes(id) && points.length > 0 });
    }
  }, [maAligned, enabledMAs, fullscreen]);

  // --- "Agora": the live quote, so a delayed chart is obvious ---------------------
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    livePriceRef.current = livePrice && livePrice > 0 ? livePrice : null;
    reachesNowRef.current = range !== CUSTOM_RANGE || !customDates || customDates.to >= new Date().toISOString().slice(0, 10);
    if (liveLineRef.current) {
      series.removePriceLine(liveLineRef.current);
      liveLineRef.current = null;
    }
    if (livePriceRef.current) {
      liveLineRef.current = series.createPriceLine({
        price: livePriceRef.current,
        color: COLORS.live,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "", // shown in the legend
      });
    }
  }, [livePrice, candles, fullscreen, range, customDates]);

  // Esc leaves full screen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const periodChange = useMemo(() => {
    if (candles.length < 1) return null;
    const first = candles[0].o;
    const last = candles[candles.length - 1].c;
    return { abs: last - first, pct: first ? ((last - first) / first) * 100 : 0 };
  }, [candles]);

  const shownIndex = hoverIndex ?? (candles.length ? candles.length - 1 : null);
  const shown = shownIndex !== null ? candles[shownIndex] : null;
  const shownTrades = shownIndex !== null ? tradesByCandle.get(shownIndex) : undefined;
  const tradeLines = shownTrades ? [...shownTrades.buys, ...shownTrades.sells].sort((a, b) => a.date.localeCompare(b.date)) : [];
  const prevClose = shownIndex !== null && shownIndex > 0 ? candles[shownIndex - 1].c : shown?.o ?? null;
  const candleChange = shown && prevClose ? { abs: shown.c - prevClose, pct: ((shown.c - prevClose) / prevClose) * 100 } : null;

  const source = state.status === "ready" ? state.source : null;
  const brDate = (iso: string) => iso.split("-").reverse().join("/");
  const rangeTitle = (id: ChartRangeId | typeof CUSTOM_RANGE) => {
    if (id === CUSTOM_RANGE) return customDates ? `${brDate(customDates.from)} a ${brDate(customDates.to)}` : "Período personalizado";
    if (id === "1D" && !hasSession) return source === "massive" ? "Últimas 24 h disponíveis" : "Últimas 24 h";
    if (id === "MAX" && source === "massive") return "Máximo do plano grátis da Massive (2 anos)";
    return CHART_RANGES[id].title;
  };
  const lastCandle = candles.length ? candles[candles.length - 1] : null;
  // A custom period that ends in the past is old on purpose: no "Dados até" warning.
  const reachesNow = range !== CUSTOM_RANGE || !customDates || customDates.to >= today;
  const dataStale = reachesNow && !!lastCandle && isChartStale(lastCandle.t, activeInterval, !hasSession, Date.now());
  const maValues = shownIndex !== null
    ? enabledMAs.map((id) => ({ id, point: (maAligned.get(id) ?? []).find((p) => p.t === candles[shownIndex]?.t) }))
    : [];
  const maMissing = ma.status === "ready" ? enabledMAs.filter((id) => !(ma.series[id]?.length)) : [];
  // The period asked for starts before the data the provider has (e.g. 10A for a stock listed later).
  const requestedFrom = state.status === "ready" ? state.requestedFrom : undefined;
  const dataStartsLater =
    range !== "MAX" && !!requestedFrom && candles.length > 0 && candles[0].t - requestedFrom > 7 * 86_400_000 ? candles[0].t : null;

  const applyCustom = () => {
    const span = parseCustomRange(draft.from, draft.to, Date.now());
    if ("error" in span) {
      setCustomError(span.error);
      return;
    }
    setCustomError(null);
    setCustomDates({ ...draft });
    setRange(CUSTOM_RANGE);
    setCandleSize("auto");
    setCustomOpen(false);
  };

  const content = (
    <div
      className={cn(fullscreen && "fixed inset-0 z-[95] bg-tv-bg p-4 flex flex-col")}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? `Gráfico de ${displaySymbol(symbol)} em tela cheia` : undefined}
    >
      <Card className={cn("p-0 overflow-hidden", fullscreen && "flex-1 flex flex-col")}>
        {/* Full screen hides the page header: show which asset this is. */}
        {fullscreen && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4" data-testid="chart-fullscreen-title">
            <div className="flex items-baseline gap-3 min-w-0">
              <h2 className="text-2xl font-bold">{displaySymbol(symbol)}</h2>
              {name && <span className="text-sm text-tv-text/60 truncate">{name}</span>}
            </div>
            {!!livePrice && livePrice > 0 && (
              <div className="flex items-baseline gap-2 font-mono">
                <span className="text-xl">{formatPrice(livePrice)}</span>
                {liveChangePct !== undefined && (
                  <span className={cn("text-sm", liveChangePct >= 0 ? "text-tv-up" : "text-tv-down")}>{formatPercent(liveChangePct)}</span>
                )}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Período do gráfico">
            {(Object.keys(CHART_RANGES) as ChartRangeId[]).map((id) => (
              <button
                key={id}
                type="button"
                title={rangeTitle(id)}
                aria-pressed={range === id}
                onClick={() => {
                  setRange(id);
                  setCustomOpen(false);
                  setCandleSize("auto");
                }}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold transition-all",
                  range === id ? "bg-tv-accent text-white" : "text-tv-text/60 hover:bg-white/5 hover:text-tv-text"
                )}
              >
                {CHART_RANGES[id].label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={range === CUSTOM_RANGE}
              aria-expanded={customOpen}
              onClick={() => setCustomOpen((o) => !o)}
              title={range === CUSTOM_RANGE ? `Período personalizado: ${rangeTitle(CUSTOM_RANGE)}` : "Período personalizado"}
              aria-label="Período personalizado"
              className={cn(
                "px-2 py-1 rounded transition-all",
                range === CUSTOM_RANGE ? "bg-tv-accent text-white" : "text-tv-text/60 hover:bg-white/5 hover:text-tv-text"
              )}
            >
              <CalendarRange size={15} />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1" role="group" aria-label="Médias móveis">
              {MOVING_AVERAGE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={enabledMAs.includes(id)}
                  onClick={() => toggleMA(id)}
                  title={`${MOVING_AVERAGES[id].label}: ligar/desligar`}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold border transition-all",
                    enabledMAs.includes(id) ? "border-white/30 bg-white/10 text-tv-text" : "border-white/10 text-tv-text/50 hover:bg-white/5"
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: MOVING_AVERAGES[id].color, opacity: enabledMAs.includes(id) ? 1 : 0.4 }} />
                  {MOVING_AVERAGES[id].short}
                </button>
              ))}
              {ma.status === "loading" && <Loader2 size={14} className="animate-spin text-tv-text/40" />}
            </div>
            <label className="text-[10px] uppercase text-tv-text/40 font-bold" htmlFor={`interval-${symbol}`}>
              Vela
            </label>
            <select
              id={`interval-${symbol}`}
              value={interval}
              onChange={(e) => setCandleSize(e.target.value)}
              className="tv-input py-1 text-xs"
            >
              <option value="auto">Auto ({CHART_INTERVALS[rangeConfig.auto]})</option>
              {rangeConfig.allowed.map((id) => (
                <option key={id} value={id}>
                  {CHART_INTERVALS[id]}
                </option>
              ))}
            </select>
            {intraday && hasSession && (
              <button
                type="button"
                aria-pressed={extended}
                onClick={() => setExtended((v) => !v)}
                title="Incluir pré-mercado e pós-mercado (4h–20h de NY)"
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold border transition-all",
                  extended ? "border-tv-accent/60 bg-tv-accent/15 text-tv-text" : "border-white/10 text-tv-text/60 hover:bg-white/5"
                )}
              >
                Estendido
              </button>
            )}
            <button
              type="button"
              onClick={() => setFullscreen((f) => !f)}
              className="p-2 rounded hover:bg-white/5 text-tv-text/60 hover:text-tv-text"
              title={fullscreen ? "Sair da tela cheia (Esc)" : "Tela cheia"}
              aria-label={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
            >
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </div>

        {customOpen && (
          <form
            className="mx-4 mt-3 p-3 rounded border border-white/10 bg-white/[0.02] flex flex-wrap items-end gap-3 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              applyCustom();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="uppercase text-[10px] font-bold text-tv-text/50">De</span>
              <input
                type="date"
                className="tv-input py-1 text-xs"
                min={CUSTOM_MIN_DATE}
                max={today}
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="uppercase text-[10px] font-bold text-tv-text/50">Até</span>
              <input
                type="date"
                className="tv-input py-1 text-xs"
                min={CUSTOM_MIN_DATE}
                max={today}
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                required
              />
            </label>
            <button type="submit" className="tv-btn py-1 px-3 text-xs">
              Aplicar
            </button>
            {customError && <span className="text-tv-down">{customError}</span>}
          </form>
        )}

        {/* Legend: values of the candle under the mouse (or the last one). */}
        <div className="px-4 pt-2 pb-1 min-h-[44px] text-xs font-mono flex flex-wrap items-center gap-x-4 gap-y-1">
          {shown ? (
            <>
              <span className="text-tv-text/50">{formatWhen(shown.t, intraday, !hasSession)}</span>
              <span>
                O <span className="text-tv-text">{formatPrice(shown.o)}</span>
              </span>
              <span>
                H <span className="text-tv-text">{formatPrice(shown.h)}</span>
              </span>
              <span>
                L <span className="text-tv-text">{formatPrice(shown.l)}</span>
              </span>
              <span>
                C <span className="text-tv-text">{formatPrice(shown.c)}</span>
              </span>
              {candleChange && (
                <span className={candleChange.abs >= 0 ? "text-tv-up" : "text-tv-down"}>
                  {candleChange.abs >= 0 ? "+" : ""}
                  {candleChange.abs.toFixed(2)} ({formatPercent(candleChange.pct)})
                </span>
              )}
              <span className="text-tv-text/50">Vol {formatVolume(shown.v)}</span>
            </>
          ) : (
            <span className="text-tv-text/40">&nbsp;</span>
          )}
          {periodChange && (
            <span
              className={cn("ml-auto font-sans font-semibold", periodChange.abs >= 0 ? "text-tv-up" : "text-tv-down")}
              title="Variação entre a abertura da primeira vela e o fechamento da última"
            >
              {periodChange.abs >= 0 ? "+" : ""}
              {periodChange.abs.toFixed(2)} ({formatPercent(periodChange.pct)}) ·{" "}
              {range === CUSTOM_RANGE ? rangeTitle(range) : rangeTitle(range).toLowerCase()}
              {sessionFilter ? " · pregão regular" : ""}
            </span>
          )}
          {dataStartsLater && (
            <span className="w-full text-right font-sans text-amber-400">
              Dados disponíveis a partir de {new Date(dataStartsLater).toLocaleDateString("pt-BR")}
            </span>
          )}
        </div>

        {(maValues.length > 0 || maMissing.length > 0 || ma.status === "error" || !!livePrice || (hasPosition && avgCost > 0)) && (
          <div className="px-4 pb-1 text-xs font-mono flex flex-wrap gap-x-4 gap-y-1">
            {!!livePrice && livePrice > 0 && (
              <span style={{ color: COLORS.live }} title="Preço agora (linha pontilhada laranja)">
                Agora {formatPrice(livePrice)}
              </span>
            )}
            {hasPosition && avgCost > 0 && (
              <span style={{ color: COLORS.accent }} title="Meu preço médio (linha tracejada azul)">
                Meu PM {formatPrice(avgCost)}
              </span>
            )}
            {maValues.map(({ id, point }) =>
              point ? (
                <span key={id} style={{ color: MOVING_AVERAGES[id].color }}>
                  {MOVING_AVERAGES[id].short} {formatPrice(point.v)}
                </span>
              ) : null
            )}
            {maMissing.map((id) => (
              <span key={`missing-${id}`} className="font-sans text-tv-text/50">
                {MOVING_AVERAGES[id].label}: histórico insuficiente (precisa de ~{Math.round(daysNeeded(id) / 365)} anos
                {ma.status === "ready" && ma.firstDay ? `; dados desde ${new Date(ma.firstDay).toLocaleDateString("pt-BR")}` : ""})
              </span>
            ))}
            {ma.status === "error" && <span className="font-sans text-tv-down">{ma.message}</span>}
          </div>
        )}

        {/* My trades on the candle under the mouse (or the last one). */}
        <div className="px-4 pb-1 min-h-[20px] text-xs flex flex-wrap gap-x-4 gap-y-1" aria-live="polite">
          {tradeLines.slice(0, 4).map((t, i) => (
            <span key={`${t.date}-${t.type}-${i}`} className={t.type === "BUY" ? "text-tv-up" : "text-tv-down"}>
              {t.type === "BUY" ? "▲ Compra" : "▼ Venda"} {formatQuantity(t.shares)} @ {formatPrice(t.price)}
              <span className="text-tv-text/40"> · {new Date(`${t.date}T12:00:00Z`).toLocaleDateString("pt-BR")}</span>
            </span>
          ))}
          {tradeLines.length > 4 && <span className="text-tv-text/40">+{tradeLines.length - 4} operações</span>}
        </div>

        <div className={cn("relative", fullscreen ? "flex-1 min-h-0" : "h-[420px]")}>
          <div ref={containerRef} className="absolute inset-0" />

          {state.status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-tv-card/60">
              <Loader2 className="animate-spin text-tv-accent" size={28} />
            </div>
          )}

          {state.status === "ready" && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-tv-text/50">
              Sem dados para este período.
            </div>
          )}

          {state.status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-tv-card p-6 text-center">
              <p className="text-sm text-tv-text/70 max-w-md">{state.message}</p>
              {state.missingKey && (
                <button type="button" onClick={onOpenSettings} className="tv-btn flex items-center gap-2">
                  <KeyRound size={16} /> Configurar as chaves dos gráficos
                </button>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-white/5 flex flex-wrap justify-between gap-2 text-[10px] text-tv-text/40">
          <span>
            {source && DATA_SOURCES[source] ? (
              <>
                Dados: {DATA_SOURCES[source].label} ({DATA_SOURCES[source].delay}
                {state.status === "ready" && state.stale ? "; exibindo cache, a fonte não respondeu" : ""})
              </>
            ) : (
              "Dados: carregando"
            )}
            {state.status === "ready" && state.fallbackFrom && (
              <span className="text-amber-400 font-semibold">
                {" "}
                · {DATA_SOURCES[state.fallbackFrom]?.label ?? state.fallbackFrom} indisponível agora, usando a reserva
              </span>
            )}
            {dataStale && lastCandle && (
              <span className="text-amber-400 font-semibold"> · Dados até {formatWhen(lastCandle.t, intraday, !hasSession)}</span>
            )}{" "}
            · horário local · ▲ minhas compras ▼ minhas vendas (detalhes ao passar o mouse) · nomes e valores das linhas na legenda acima
          </span>
          <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener" className="hover:text-tv-text/70">
            Gráfico: TradingView Lightweight Charts™
          </a>
        </div>
      </Card>
    </div>
  );

  // Full screen goes to <body>: an animated ancestor (transform) would otherwise trap position:fixed.
  return fullscreen ? createPortal(content, document.body) : content;
}
