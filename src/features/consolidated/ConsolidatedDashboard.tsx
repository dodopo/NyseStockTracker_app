import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Card } from "../../components/ui";
import { Donut } from "../../components/Donut";
import { marketApi } from "../../api/endpoints";
import { errorMessage } from "../../api/client";
import { cn, formatCurrency, formatPrice, formatQuantity, type Currency } from "../../lib/utils";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { ConsolidationMode, PortfolioItem } from "../../types";
import { calculatePosition } from "../../../shared/positions";
import { displaySymbol } from "../../../shared/assetTypes";
import { NO_TAB_KEY, allocationSlices, passesTabFilter, toggleTabFilter, type TabFilterKey } from "../../../shared/allocation";

const TAB_FILTER_KEY = "nyse.consolidated.tabs";
const CURRENCY_KEY = "nyse.consolidated.currency";
const ALLOC_KEY = "nyse.consolidated.allocBy";
/** Colors for "Por ativo" slices (tab slices use the tab color). */
const ASSET_COLORS = ["#2962ff", "#089981", "#f7931a", "#ab47bc", "#f23645", "#26a69a", "#ffb74d", "#ec407a", "#7e57c2", "#78909c"];
const NO_TAB_COLOR = "#78909c";

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or blocked storage: the choice just is not remembered
  }
}

type FxState =
  | { status: "idle" | "loading" }
  | { status: "ready"; rate: number; fetchedAt: string; stale?: boolean }
  | { status: "error"; message: string };

export function ConsolidatedDashboard({
  portfolio,
  mode,
  onModeChange,
  onOpenAsset,
}: {
  portfolio: PortfolioState;
  mode: ConsolidationMode;
  onModeChange: (mode: ConsolidationMode) => void;
  onOpenAsset: (ticker: string, tabId: number | null) => void;
}) {
  const { stocks, transactions, prices, tabs } = portfolio;

  // View choices, remembered in this browser only.
  const [tabFilter, setTabFilter] = useState<TabFilterKey[]>(() => {
    const saved = readStored<unknown>(TAB_FILTER_KEY, []);
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  });
  const [currency, setCurrency] = useState<Currency>(() => (readStored<string>(CURRENCY_KEY, "USD") === "BRL" ? "BRL" : "USD"));
  const [allocBy, setAllocBy] = useState<"tab" | "asset">(() => (readStored<string>(ALLOC_KEY, "tab") === "asset" ? "asset" : "tab"));
  const [fx, setFx] = useState<FxState>({ status: "idle" });

  useEffect(() => writeStored(TAB_FILTER_KEY, tabFilter), [tabFilter]);
  useEffect(() => writeStored(CURRENCY_KEY, currency), [currency]);
  useEffect(() => writeStored(ALLOC_KEY, allocBy), [allocBy]);

  // Exchange rate only when reais are asked for; refreshed every 10 minutes while open.
  useEffect(() => {
    if (currency !== "BRL") return;
    let cancelled = false;
    const load = () => {
      setFx((f) => (f.status === "ready" ? f : { status: "loading" }));
      marketApi
        .usdBrl()
        .then((d) => !cancelled && setFx({ status: "ready", rate: d.rate, fetchedAt: d.fetchedAt, stale: d.stale }))
        .catch((err) => !cancelled && setFx({ status: "error", message: errorMessage(err, "Não foi possível obter o câmbio.") }));
    };
    load();
    const timer = window.setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currency]);

  // Values are kept in dollars; reais only for display, at the current rate.
  const inBrl = currency === "BRL" && fx.status === "ready";
  const k = inBrl ? fx.rate : 1;
  const shownCurrency: Currency = inBrl ? "BRL" : "USD";
  const money = (v: number) => formatCurrency(v * k, shownCurrency);
  const price = (v: number | string) => formatPrice(Number(v) * k, shownCurrency);

  const rows: PortfolioItem[] = useMemo(
    () =>
      stocks.map((s) => {
        const currentPrice = prices[s.ticker]?.price || 0;
        const p = calculatePosition(
          transactions.filter((t) => t.ticker === s.ticker),
          currentPrice
        );
        return {
          ticker: s.ticker,
          name: s.name,
          tabId: s.tab_id ?? null,
          quantity: p.quantity,
          shares: p.shares,
          avgCost: p.avgCost,
          totalInvested: p.openCost,
          currentPrice,
          marketValue: p.marketValue,
          unrealizedPnL: p.unrealizedPnL,
          realizedPnL: p.realizedPnL,
          totalPnL: p.totalPnL,
          totalPnLPct: p.totalPnLPct,
        };
      }),
    [stocks, transactions, prices]
  );

  // Tab filter: keys of tabs that have assets, plus "Sem aba" when needed.
  const tabKeyOf = (tabId: number | null) => (tabId !== null && tabs.some((t) => t.id === tabId) ? String(tabId) : NO_TAB_KEY);
  const hasOrphans = rows.some((r) => tabKeyOf(r.tabId) === NO_TAB_KEY);
  const allKeys = [
    ...tabs.filter((t) => rows.some((r) => r.tabId === t.id)).map((t) => String(t.id)),
    ...(hasOrphans ? [NO_TAB_KEY] : []),
  ];
  const activeFilter = tabFilter.filter((key) => allKeys.includes(key));
  const shownRows = rows.filter((r) => passesTabFilter(activeFilter, tabKeyOf(r.tabId)));

  const totals = shownRows.reduce(
    (acc, it) => ({
      invested: acc.invested + it.totalInvested,
      market: acc.market + it.marketValue,
      realized: acc.realized + it.realizedPnL,
      unrealized: acc.unrealized + it.unrealizedPnL,
      total: acc.total + it.totalPnL,
    }),
    { invested: 0, market: 0, realized: 0, unrealized: 0, total: 0 }
  );
  const totalPct = totals.invested > 0 ? (totals.total / totals.invested) * 100 : 0;

  // One section per tab, in the user's tab order; assets without a tab go last.
  const byTab = tabs
    .map((tab) => ({ tab, items: shownRows.filter((r) => r.tabId === tab.id) }))
    .filter((sec) => sec.items.length > 0);
  const orphans = shownRows.filter((r) => tabKeyOf(r.tabId) === NO_TAB_KEY);
  const sections: Array<{ tab: (typeof tabs)[number] | null; items: PortfolioItem[] }> = orphans.length
    ? [...byTab, { tab: null, items: orphans }]
    : byTab;

  // Allocation by market value (open positions only).
  const slices =
    allocBy === "tab"
      ? allocationSlices(
          sections.map(({ tab, items }) => ({
            key: String(tab?.id ?? NO_TAB_KEY),
            label: tab?.name ?? "Sem aba",
            value: items.reduce((sum, it) => sum + it.marketValue, 0),
            color: tab?.color ?? NO_TAB_COLOR,
          }))
        )
      : allocationSlices(shownRows.map((r) => ({ key: r.ticker, label: displaySymbol(r.ticker), value: r.marketValue })));
  const sliceColor = (i: number, color?: string) => color ?? ASSET_COLORS[i % ASSET_COLORS.length];

  const segmented = <T extends string>(
    label: string,
    value: T,
    options: Array<[T, string]>,
    onChange: (v: T) => void
  ) => (
    <div className="flex rounded border border-white/10 overflow-hidden text-xs font-semibold" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn("px-3 py-1 transition-all", value === v ? "bg-tv-accent text-white" : "text-tv-text/60 hover:bg-white/5")}
        >
          {text}
        </button>
      ))}
    </div>
  );

  const filterChip = (key: TabFilterKey | null, label: string, color?: string) => {
    const active = key === null ? activeFilter.length === 0 : activeFilter.includes(key);
    return (
      <button
        key={key ?? "all"}
        type="button"
        aria-pressed={active}
        onClick={() => setTabFilter(key === null ? [] : toggleTabFilter(activeFilter, key, allKeys))}
        className={cn(
          "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-all",
          active ? "border-tv-accent/60 bg-tv-accent/15 text-tv-text" : "border-white/10 text-tv-text/60 hover:bg-white/5"
        )}
      >
        {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
        {label}
      </button>
    );
  };

  const modeToggle = (
    <div className="flex items-center gap-3">
      <span className={cn("text-xs transition-opacity", mode === "UNIFIED" ? "opacity-100" : "opacity-50")}>
        Unificado
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={mode === "SEPARATED"}
        aria-label="Mostrar resultado separado em realizado e não realizado"
        onClick={() => onModeChange(mode === "UNIFIED" ? "SEPARATED" : "UNIFIED")}
        className="relative inline-flex h-7 w-14 items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-tv-accent/40 bg-white/5 border-white/20"
        title="Alternar visualização"
      >
        <span
          className={cn(
            "inline-block h-6 w-6 transform rounded-full transition-transform bg-tv-text/90",
            mode === "SEPARATED" ? "translate-x-7" : "translate-x-1"
          )}
        />
      </button>
      <span className={cn("text-xs transition-opacity", mode === "SEPARATED" ? "opacity-100" : "opacity-50")}>
        Separado
      </span>
    </div>
  );

  const pnlCell = (value: number, pct: number) => (
    <td className="py-4 pr-2 text-right">
      <div className={cn("font-bold", value >= 0 ? "text-tv-up" : "text-tv-down")}>{money(value)}</div>
      <div className={cn("text-[10px]", pct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>{pct.toFixed(2)}%</div>
    </td>
  );

  return (
    <div className="space-y-6">
      {/* Filter by tab and display currency. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por aba">
          {filterChip(null, "Todas")}
          {tabs.filter((t) => allKeys.includes(String(t.id))).map((t) => filterChip(String(t.id), t.name, t.color))}
          {hasOrphans && filterChip(NO_TAB_KEY, "Sem aba", NO_TAB_COLOR)}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {currency === "BRL" && fx.status === "loading" && <Loader2 size={14} className="animate-spin text-tv-text/40" />}
            {segmented<Currency>("Moeda", currency, [["USD", "USD"], ["BRL", "BRL"]], setCurrency)}
          </div>
          {currency === "BRL" && fx.status === "ready" && (
            <span className="text-[10px] text-tv-text/40">
              US$ 1 = R$ {fx.rate.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} · Coinbase,{" "}
              {new Date(fx.fetchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              {fx.stale ? " (último disponível)" : ""}
            </span>
          )}
          {currency === "BRL" && fx.status === "error" && (
            <span className="text-[10px] text-tv-down">{fx.message} Mostrando em dólar.</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="bg-tv-accent/10 border-tv-accent/30">
          <div className="text-[10px] uppercase text-tv-accent font-bold mb-1">Patrimônio (Aberto)</div>
          <div className="text-2xl font-bold font-mono">{money(totals.market)}</div>
        </Card>

        <Card>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Investido (Aberto)</div>
          <div className="text-2xl font-bold font-mono">{money(totals.invested)}</div>
        </Card>

        <Card>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">P/L Total</div>
          <div className={cn("text-2xl font-bold font-mono", totals.total >= 0 ? "text-tv-up" : "text-tv-down")}>
            {money(totals.total)}
          </div>
          <div className={cn("text-xs", totalPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>{totalPct.toFixed(2)}%</div>
        </Card>

        <Card extra={modeToggle}>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Detalhes</div>
          {mode === "SEPARATED" ? (
            <div className="space-y-1">
              <div className="text-xs text-tv-text/50">Realizado</div>
              <div className={cn("text-lg font-bold font-mono", totals.realized >= 0 ? "text-tv-up" : "text-tv-down")}>
                {money(totals.realized)}
              </div>
              <div className="text-xs text-tv-text/50">Não Realizado</div>
              <div className={cn("text-lg font-bold font-mono", totals.unrealized >= 0 ? "text-tv-up" : "text-tv-down")}>
                {money(totals.unrealized)}
              </div>
            </div>
          ) : (
            <div className="text-xs text-tv-text/60">Modo unificado: tabela mostra apenas um resultado (Total).</div>
          )}
        </Card>
      </div>

      {slices.length > 0 && (
        <Card
          title="Alocação"
          extra={segmented<"tab" | "asset">("Alocação por", allocBy, [["tab", "Por aba"], ["asset", "Por ativo"]], setAllocBy)}
        >
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <Donut
              slices={slices.map((s, i) => ({ key: s.key, label: s.label, pct: s.pct, color: sliceColor(i, s.color) }))}
              ariaLabel={`Alocação ${allocBy === "tab" ? "por aba" : "por ativo"}: ${slices
                .map((s) => `${s.label} ${s.pct.toFixed(1)}%`)
                .join(", ")}`}
              center={
                <>
                  <span className="text-[10px] uppercase text-tv-text/40 font-bold">Patrimônio</span>
                  <span className="text-sm font-bold font-mono">{money(totals.market)}</span>
                </>
              }
            />
            <ul className="flex-1 w-full space-y-2 text-sm">
              {slices.map((s, i) => (
                <li key={s.key} className="flex items-center gap-3">
                  <span className="h-3 w-3 rounded-sm shrink-0" style={{ background: sliceColor(i, s.color) }} />
                  <span className="flex-1 truncate">{s.label}</span>
                  <span className="font-mono text-tv-text/60">{money(s.value)}</span>
                  <span className="font-mono font-semibold w-16 text-right">{s.pct.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card title="Consolidado da Carteira">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase text-tv-text/40 font-bold border-b border-tv-border">
                <th className="pb-3 pl-2">Ticker</th>
                <th className="pb-3">Preço</th>
                <th className="pb-3">PM</th>
                <th className="pb-3">Qtd</th>
                <th className="pb-3">Valor</th>
                <th className="pb-3">Investido</th>
                {mode === "SEPARATED" && (
                  <>
                    <th className="pb-3">P/L Real.</th>
                    <th className="pb-3">P/L Não Real.</th>
                  </>
                )}
                <th className="pb-3 pr-2 text-right">P/L Total</th>
              </tr>
            </thead>

            <tbody className="text-sm font-mono">
              {sections.map(({ tab, items }) => {
                const market = items.reduce((sum, it) => sum + it.marketValue, 0);
                const pnl = items.reduce((sum, it) => sum + it.totalPnL, 0);
                return (
                  <React.Fragment key={tab?.id ?? "sem-aba"}>
                    <tr className="bg-white/[0.03]">
                      <td colSpan={mode === "SEPARATED" ? 9 : 7} className="py-2 pl-2 pr-2 font-sans">
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="flex items-center gap-2 font-semibold uppercase tracking-wider text-tv-text/70">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: tab?.color ?? NO_TAB_COLOR }} />
                            {tab?.name ?? "Sem aba"}
                          </span>
                          <span className="font-mono text-tv-text/60">
                            {money(market)} · <span className={pnl >= 0 ? "text-tv-up" : "text-tv-down"}>{money(pnl)}</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {items.map((it) => (
                      <tr
                        key={it.ticker}
                        tabIndex={0}
                        role="link"
                        aria-label={`Abrir ${displaySymbol(it.ticker)} na aba ${tab?.name ?? ""}`}
                        title={`Abrir ${displaySymbol(it.ticker)}`}
                        onClick={() => onOpenAsset(it.ticker, it.tabId)}
                        onKeyDown={(e) => e.key === "Enter" && onOpenAsset(it.ticker, it.tabId)}
                        className="group border-b border-tv-border/50 hover:bg-white/5 cursor-pointer transition-colors focus:outline-none focus:bg-white/5 focus:ring-2 focus:ring-inset focus:ring-tv-accent/40"
                      >
                        <td className="py-4 pl-2 font-bold">
                          <div className="flex items-center gap-1">
                            {displaySymbol(it.ticker)}
                            <ChevronRight
                              size={14}
                              className="text-tv-accent opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity"
                            />
                          </div>
                          <div className="text-[10px] text-tv-text/40 font-normal">{it.name}</div>
                        </td>
                        <td className="py-4">{price(it.currentPrice)}</td>
                        <td className="py-4 text-tv-text/60">{price(it.avgCost)}</td>
                        <td className="py-4">{formatQuantity(it.quantity)}</td>
                        <td className="py-4 font-bold">{money(it.marketValue)}</td>
                        <td className="py-4 text-tv-text/60">{money(it.totalInvested)}</td>
                        {mode === "SEPARATED" && (
                          <>
                            <td className={cn("py-4", it.realizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                              {money(it.realizedPnL)}
                            </td>
                            <td className={cn("py-4", it.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                              {money(it.unrealizedPnL)}
                            </td>
                          </>
                        )}
                        {pnlCell(it.totalPnL, it.totalPnLPct)}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={mode === "SEPARATED" ? 9 : 7} className="py-12 text-center text-tv-text/20 italic">
                    Adicione ativos e transações para ver o consolidado
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
