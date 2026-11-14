import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
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
import { KeyRound, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { ApiError, errorMessage } from "../../api/client";
import { marketApi } from "../../api/endpoints";
import { Card } from "../../components/ui";
import { cn, formatPercent, formatPrice } from "../../lib/utils";
import type { Candle, Transaction } from "../../types";
import { CHART_INTERVALS, CHART_RANGES, isIntraday, type ChartRangeId } from "../../../shared/chartRanges";

const COLORS = {
  bg: "#1e222d",
  border: "#2a2e39",
  text: "#d1d4dc",
  up: "#089981",
  down: "#f23645",
  accent: "#2962ff",
};

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const fromTime = (time: Time) => (typeof time === "number" ? time * 1000 : 0);

/** US market session date of a timestamp (purchases are recorded per session date). */
const nyDate = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

function formatVolume(v: number) {
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function formatWhen(ms: number, intraday: boolean) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(intraday ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(ms));
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; interval: string; candles: Candle[]; stale: boolean }
  | { status: "error"; message: string; missingKey: boolean };

export function PriceChart({
  symbol,
  transactions,
  avgCost,
  hasPosition,
  onOpenSettings,
}: {
  symbol: string;
  transactions: Transaction[];
  avgCost: number;
  hasPosition: boolean;
  onOpenSettings: () => void;
}) {
  const [range, setRange] = useState<ChartRangeId>("1A");
  const [interval, setCandleSize] = useState<string>("auto");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const pmLineRef = useRef<IPriceLine | null>(null);
  const indexByTimeRef = useRef(new Map<number, number>());
  const intradayRef = useRef(false);

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
          const d = new Date(fromTime(time));
          const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", o).format(d);
          if (type === TickMarkType.Year) return fmt({ year: "numeric" });
          if (type === TickMarkType.Month) return fmt({ month: "short" });
          if (type === TickMarkType.DayOfMonth) return fmt({ day: "2-digit", month: "short" });
          return fmt({ hour: "2-digit", minute: "2-digit" });
        },
      },
      localization: {
        locale: "pt-BR",
        timeFormatter: (time: Time) => formatWhen(fromTime(time), intradayRef.current),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

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
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
      pmLineRef.current = null;
    };
    // Full screen renders the chart in a portal (a new container), so the chart is rebuilt.
  }, [fullscreen]);

  // --- load candles when symbol / period / candle size change -----------------
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setHoverIndex(null);
    marketApi
      .candles(symbol, range, interval)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", interval: data.interval, candles: data.candles, stale: !!data.stale });
      })
      .catch((error) => {
        if (cancelled) return;
        const missingKey = error instanceof ApiError && error.code === "MASSIVE_KEY_MISSING";
        setState({ status: "error", message: errorMessage(error, "Não foi possível carregar o gráfico."), missingKey });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range, interval]);

  const candles = state.status === "ready" ? state.candles : [];
  const activeInterval = state.status === "ready" ? state.interval : CHART_RANGES[range].auto;
  const intraday = isIntraday(activeInterval);

  // --- push data, markers and the average-price line into the chart ------------
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !series || !volume) return;

    intradayRef.current = intraday;
    chart.applyOptions({ timeScale: { timeVisible: intraday } });

    indexByTimeRef.current = new Map(candles.map((c, i) => [toTime(c.t) as number, i]));
    series.setData(candles.map((c) => ({ time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    volume.setData(
      candles.map((c) => ({
        time: toTime(c.t),
        value: c.v,
        color: c.c >= c.o ? "rgba(8,153,129,0.35)" : "rgba(242,54,69,0.35)",
      }))
    );

    // My trades: each one on the last candle that starts on or before its session date.
    const markers: SeriesMarker<Time>[] = [];
    if (candles.length) {
      const sessionDates = candles.map((c) => nyDate(c.t));
      for (const tx of transactions) {
        if (tx.date < sessionDates[0] || tx.date > sessionDates[sessionDates.length - 1]) continue;
        let i = sessionDates.length - 1;
        while (i > 0 && sessionDates[i] > tx.date) i--;
        const buy = tx.type === "BUY";
        markers.push({
          time: toTime(candles[i].t),
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
          color: buy ? COLORS.up : COLORS.down,
          text: `${buy ? "C" : "V"} ${Number(tx.shares).toLocaleString("pt-BR", { maximumFractionDigits: 8 })}`,
        });
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
        title: "Meu PM",
      });
    }

    chart.timeScale().fitContent();
  }, [candles, transactions, avgCost, hasPosition, intraday, fullscreen]);

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
  const prevClose = shownIndex !== null && shownIndex > 0 ? candles[shownIndex - 1].c : shown?.o ?? null;
  const candleChange = shown && prevClose ? { abs: shown.c - prevClose, pct: ((shown.c - prevClose) / prevClose) * 100 } : null;

  const rangeConfig = CHART_RANGES[range];

  const content = (
    <div
      className={cn(fullscreen && "fixed inset-0 z-[95] bg-tv-bg p-4 flex flex-col")}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? `Gráfico de ${symbol} em tela cheia` : undefined}
    >
      <Card className={cn("p-0 overflow-hidden", fullscreen && "flex-1 flex flex-col")}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Período do gráfico">
            {(Object.keys(CHART_RANGES) as ChartRangeId[]).map((id) => (
              <button
                key={id}
                type="button"
                title={CHART_RANGES[id].title}
                aria-pressed={range === id}
                onClick={() => {
                  setRange(id);
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
          </div>

          <div className="flex items-center gap-2">
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

        {/* Legend: values of the candle under the mouse (or the last one). */}
        <div className="px-4 pt-2 pb-1 min-h-[44px] text-xs font-mono flex flex-wrap items-center gap-x-4 gap-y-1">
          {shown ? (
            <>
              <span className="text-tv-text/50">{formatWhen(shown.t, intraday)}</span>
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
              {periodChange.abs.toFixed(2)} ({formatPercent(periodChange.pct)}) · {rangeConfig.title.toLowerCase()}
            </span>
          )}
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
                  <KeyRound size={16} /> Configurar a chave da Massive
                </button>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-white/5 flex flex-wrap justify-between gap-2 text-[10px] text-tv-text/40">
          <span>
            Dados: Massive (com atraso{state.status === "ready" && state.stale ? "; exibindo cache por causa do limite de 5/min" : ""}) ·
            horário local · ▲ minhas compras ▼ minhas vendas{hasPosition ? " · linha azul = meu preço médio" : ""}
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
