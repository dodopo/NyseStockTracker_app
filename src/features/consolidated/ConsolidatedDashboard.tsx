import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Card } from "../../components/ui";
import { Donut } from "../../components/Donut";
import { useLiveFx } from "../../hooks/useLiveFx";
import { cn, formatCurrency, formatPrice, formatQuantity, type Currency } from "../../lib/utils";
import type { StockPrice } from "../../services/marketService";
import type { ConsolidationMode, Portfolio, PortfolioItem, Stock, Tab, Transaction } from "../../types";
import { assetsLeftOut, buildRows, maturityAllocation } from "./rows";
import { localToday, type MaturityBucket } from "../../../shared/tranches";
import { assetLabel } from "../../../shared/assetTypes";
import { CURRENCIES, isCurrency } from "../../../shared/currencies";
import { CUSTODY, HORIZON, JURISDICTION, LIQUIDITY, NOT_DEFINED } from "../../../shared/classification";
import { NO_TAB_KEY, allocationSlices, passesTabFilter, toggleTabFilter, type TabFilterKey } from "../../../shared/allocation";

const TAB_FILTER_KEY = "nyse.consolidated.tabs";
const CURRENCY_KEY = "nyse.consolidated.currency";
const ALLOC_KEY = "nyse.consolidated.allocBy";
const HORIZON_MODE_KEY = "dam.consolidated.horizonMode";
type HorizonMode = "thesis" | "maturity";
const PORTFOLIO_FILTER_KEY = "dam.global.portfolios";
type AllocBy = "portfolio" | "tab" | "asset" | "liquidity" | "horizon" | "jurisdiction" | "custody" | "currency";
const ALLOC_IDS: AllocBy[] = ["portfolio", "tab", "asset", "liquidity", "horizon", "jurisdiction", "custody", "currency"];
const UNDEFINED_COLOR = "#78909c";
const LIQUIDITY_COLOR = { liquid: "#089981", illiquid: "#f7931a" } as const;
const HORIZON_COLOR = { ultra_short: "#f23645", short: "#ffb74d", medium: "#2962ff", long: "#26a69a", ultra_long: "#ab47bc" } as const;
const JURISDICTION_COLOR = { onshore: "#089981", offshore: "#2962ff" } as const;
const CUSTODY_COLOR = { institution: "#2962ff", self: "#f7931a" } as const;
const CURRENCY_COLOR: Record<string, string> = { BRL: "#089981", USD: "#2962ff", EUR: "#ab47bc", CHF: "#f23645", crypto: "#f7931a" };
const CURRENCY_SYMBOL: Record<Currency, string> = { BRL: "R$", USD: "US$", EUR: "€", CHF: "CHF" };
const MATURITY_LABEL: Record<MaturityBucket, string> = {
  ultra_short: `${HORIZON.ultra_short.label} (${HORIZON.ultra_short.range})`,
  short: `${HORIZON.short.label} (${HORIZON.short.range})`,
  medium: `${HORIZON.medium.label} (${HORIZON.medium.range})`,
  long: `${HORIZON.long.label} (${HORIZON.long.range})`,
  ultra_long: `${HORIZON.ultra_long.label} (${HORIZON.ultra_long.range})`,
  matured: "Maturada (prazo cumprido)",
  none: "Não definido",
};
const MATURITY_COLOR: Record<MaturityBucket, string> = {
  ultra_short: "#f23645",
  short: "#ffb74d",
  medium: "#2962ff",
  long: "#26a69a",
  ultra_long: "#ab47bc",
  matured: "#facc15",
  none: "#78909c",
};
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

export function ConsolidatedDashboard({
  data,
  portfolios,
  mode,
  onModeChange,
  onOpenAsset,
}: {
  /** Assets of the active portfolio, or of every active portfolio in the global view. */
  data: { stocks: Stock[]; transactions: Transaction[]; prices: Record<string, StockPrice>; tabs: Tab[] };
  /** Given only in the global view: rows are then grouped and filtered by portfolio. */
  portfolios?: Portfolio[];
  mode: ConsolidationMode;
  onModeChange: (mode: ConsolidationMode) => void;
  onOpenAsset: (ticker: string, tabId: number | null, portfolioId: number | null) => void;
}) {
  const { stocks, transactions, prices, tabs } = data;
  const isGlobal = portfolios !== undefined;

  // View choices, remembered in this browser only.
  const [tabFilter, setTabFilter] = useState<TabFilterKey[]>(() => {
    const saved = readStored<unknown>(TAB_FILTER_KEY, []);
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  });
  const [portfolioFilter, setPortfolioFilter] = useState<TabFilterKey[]>(() => {
    const saved = readStored<unknown>(PORTFOLIO_FILTER_KEY, []);
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  });
  const [currency, setCurrency] = useState<Currency>(() => {
    const saved = readStored<unknown>(CURRENCY_KEY, "USD");
    return isCurrency(saved) ? saved : "USD";
  });
  const [allocChoice, setAllocBy] = useState<AllocBy>(() => {
    const saved = readStored<string>(ALLOC_KEY, "tab");
    return (ALLOC_IDS as string[]).includes(saved) ? (saved as AllocBy) : "tab";
  });
  const allocBy: AllocBy = allocChoice === "portfolio" && !isGlobal ? "tab" : allocChoice;
  const [horizonMode, setHorizonMode] = useState<HorizonMode>(() =>
    readStored<string>(HORIZON_MODE_KEY, "maturity") === "thesis" ? "thesis" : "maturity"
  );
  useEffect(() => writeStored(HORIZON_MODE_KEY, horizonMode), [horizonMode]);
  const fx = useLiveFx();

  useEffect(() => writeStored(TAB_FILTER_KEY, tabFilter), [tabFilter]);
  useEffect(() => writeStored(PORTFOLIO_FILTER_KEY, portfolioFilter), [portfolioFilter]);
  useEffect(() => writeStored(CURRENCY_KEY, currency), [currency]);
  useEffect(() => writeStored(ALLOC_KEY, allocChoice), [allocChoice]);

  // Costs use the PTAX frozen on each trade; today's rate only converts current prices
  // (and trades whose PTAX is not known yet). Without today's rate: dollars.
  const live = fx.status === "ready" ? fx.rates : null;
  const shownCurrency: Currency = currency === "USD" || live ? currency : "USD";
  const money = (v: number) => formatCurrency(v, shownCurrency);
  const price = (v: number | string) => formatPrice(Number(v), shownCurrency);

  const rows: PortfolioItem[] = useMemo(
    () => buildRows(stocks, transactions, prices, shownCurrency, live),
    [stocks, transactions, prices, shownCurrency, live]
  );
  const approxTrades = rows.reduce((sum, r) => sum + r.approxTrades, 0);
  const missingTrades = rows.reduce((sum, r) => sum + r.missingTrades, 0);
  const leftOut = assetsLeftOut(stocks, shownCurrency, live);

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const tabKeyOf = (r: PortfolioItem) => {
    const tab = r.tabId !== null ? tabById.get(r.tabId) : undefined;
    // a tab only counts when it belongs to the row's portfolio
    return tab && (!isGlobal || tab.portfolioId === r.portfolioId) ? String(tab.id) : NO_TAB_KEY;
  };

  // Filter chips: by tab in one portfolio, by portfolio in the global view.
  const hasOrphans = rows.some((r) => tabKeyOf(r) === NO_TAB_KEY);
  const chipOptions: Array<{ key: TabFilterKey; label: string; color: string }> = isGlobal
    ? portfolios.filter((p) => rows.some((r) => r.portfolioId === p.id)).map((p) => ({ key: String(p.id), label: p.name, color: p.color }))
    : [
        ...tabs.filter((t) => rows.some((r) => r.tabId === t.id)).map((t) => ({ key: String(t.id), label: t.name, color: t.color })),
        ...(hasOrphans ? [{ key: NO_TAB_KEY, label: "Sem aba", color: NO_TAB_COLOR }] : []),
      ];
  const allKeys = chipOptions.map((c) => c.key);
  const filter = isGlobal ? portfolioFilter : tabFilter;
  const setFilter = isGlobal ? setPortfolioFilter : setTabFilter;
  const activeFilter = filter.filter((key) => allKeys.includes(key));
  const shownRows = rows.filter((r) => passesTabFilter(activeFilter, isGlobal ? String(r.portfolioId) : tabKeyOf(r)));

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

  // Table sections: one per tab (one portfolio) or one per portfolio (global), in the user's order.
  type Section = { key: string; label: string; color: string; items: PortfolioItem[] };
  const tabOrder = (r: PortfolioItem) => (r.tabId !== null ? tabById.get(r.tabId)?.sortOrder ?? 999 : 999);
  const sections: Section[] = isGlobal
    ? portfolios
        .map((p) => ({
          key: `p${p.id}`,
          label: p.name,
          color: p.color,
          items: shownRows.filter((r) => r.portfolioId === p.id).sort((a, b) => tabOrder(a) - tabOrder(b) || a.ticker.localeCompare(b.ticker)),
        }))
        .filter((sec) => sec.items.length > 0)
    : [
        ...tabs.map((tab) => ({ key: `t${tab.id}`, label: tab.name, color: tab.color, items: shownRows.filter((r) => tabKeyOf(r) === String(tab.id)) })),
        { key: "sem-aba", label: "Sem aba", color: NO_TAB_COLOR, items: shownRows.filter((r) => tabKeyOf(r) === NO_TAB_KEY) },
      ].filter((sec) => sec.items.length > 0);

  // Allocation by market value (open positions only).
  const portfolioName = (id: number | null) => portfolios?.find((p) => p.id === id)?.name ?? "";
  const sumBy = (keyOf: (r: PortfolioItem) => string, labelOf: (r: PortfolioItem) => string, colorOf?: (r: PortfolioItem) => string) => {
    const acc = new Map<string, { key: string; label: string; value: number; color?: string }>();
    for (const r of shownRows) {
      const k = keyOf(r);
      const cur = acc.get(k) ?? { key: k, label: labelOf(r), value: 0, color: colorOf?.(r) };
      cur.value += r.marketValue;
      acc.set(k, cur);
    }
    return allocationSlices([...acc.values()]);
  };
  const slices =
    allocBy === "portfolio"
      ? allocationSlices(sections.map((sec) => ({ key: sec.key, label: sec.label, color: sec.color, value: sec.items.reduce((sum, it) => sum + it.marketValue, 0) })))
      : allocBy === "tab"
        ? sumBy(
            (r) => `${r.portfolioId ?? 0}:${tabKeyOf(r)}`,
            (r) => {
              const tabName = tabKeyOf(r) === NO_TAB_KEY ? "Sem aba" : tabById.get(r.tabId!)!.name;
              return isGlobal ? `${portfolioName(r.portfolioId)} · ${tabName}` : tabName;
            },
            (r) => (tabKeyOf(r) === NO_TAB_KEY ? NO_TAB_COLOR : tabById.get(r.tabId!)!.color)
          )
        : allocBy === "asset"
          ? // the same asset in two portfolios counts once, summed
            sumBy((r) => r.ticker, (r) => assetLabel(r))
          : allocBy === "liquidity"
            ? sumBy((r) => r.liquidity, (r) => LIQUIDITY[r.liquidity], (r) => LIQUIDITY_COLOR[r.liquidity])
            : allocBy === "horizon" && horizonMode === "maturity"
              ? allocationSlices(
                  [...maturityAllocation(shownRows, stocks, transactions, localToday(), live).entries()].map(([bucket, value]) => ({
                    key: bucket,
                    label: MATURITY_LABEL[bucket],
                    value,
                    color: MATURITY_COLOR[bucket],
                  }))
                )
              : allocBy === "horizon"
              ? sumBy(
                  (r) => r.horizon ?? "none",
                  (r) => (r.horizon ? `${HORIZON[r.horizon].label} (${HORIZON[r.horizon].range})` : NOT_DEFINED),
                  (r) => (r.horizon ? HORIZON_COLOR[r.horizon] : UNDEFINED_COLOR)
                )
              : allocBy === "jurisdiction"
                ? sumBy(
                    (r) => r.jurisdiction ?? "none",
                    (r) => (r.jurisdiction ? JURISDICTION[r.jurisdiction] : NOT_DEFINED),
                    (r) => (r.jurisdiction ? JURISDICTION_COLOR[r.jurisdiction] : UNDEFINED_COLOR)
                  )
                : allocBy === "custody"
                  ? sumBy(
                      (r) => r.custody ?? "none",
                      (r) => (r.custody ? CUSTODY[r.custody] : NOT_DEFINED),
                      (r) => (r.custody ? CUSTODY_COLOR[r.custody] : UNDEFINED_COLOR)
                    )
                : // exposure: the asset's own currency; crypto is its own risk, shown apart
                  sumBy(
                    (r) => (r.isCrypto ? "crypto" : r.assetCurrency),
                    (r) => (r.isCrypto ? "Cripto (cotada em US$)" : CURRENCY_SYMBOL[r.assetCurrency] + " · " + r.assetCurrency),
                    (r) => CURRENCY_COLOR[r.isCrypto ? "crypto" : r.assetCurrency]
                  );
  const sliceColor = (i: number, color?: string) => color ?? ASSET_COLORS[i % ASSET_COLORS.length];
  const allocOptions: Array<[AllocBy, string]> = [
    ...(isGlobal ? ([["portfolio", "Por carteira"]] as Array<[AllocBy, string]>) : []),
    ["tab", "Por aba"],
    ["asset", "Por ativo"],
    ["liquidity", "Por liquidez"],
    ["horizon", "Por prazo"],
    ["jurisdiction", "Por jurisdição"],
    ["custody", "Por custódia"],
    ["currency", "Por moeda"],
  ];
  const allocLabel = (allocOptions.find(([v]) => v === allocBy)?.[1] ?? "").toLowerCase();

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
        onClick={() => setFilter(key === null ? [] : toggleTabFilter(activeFilter, key, allKeys))}
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
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={isGlobal ? "Filtrar por carteira" : "Filtrar por aba"}>
          {filterChip(null, "Todas")}
          {chipOptions.map((c) => filterChip(c.key, c.label, c.color))}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {currency !== "USD" && fx.status === "loading" && <Loader2 size={14} className="animate-spin text-tv-text/40" />}
            {segmented<Currency>("Moeda", currency, CURRENCIES.map((c) => [c, c] as [Currency, string]), setCurrency)}
          </div>
          {shownCurrency !== "USD" && fx.status === "ready" && (
            <span className="text-[10px] text-tv-text/40 text-right">
              Hoje: US$ 1 = {CURRENCY_SYMBOL[shownCurrency]}{" "}
              {(Number(fx.rates.USD) / (shownCurrency === "BRL" ? 1 : Number(fx.rates[shownCurrency]))).toLocaleString("pt-BR", {
                minimumFractionDigits: 4,
                maximumFractionDigits: 4,
              })}{" "}
              · Coinbase, {new Date(fx.fetchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              {fx.stale ? " (último disponível)" : ""}
              <br />
              Custo e resultado realizado: PTAX (venda) da data de cada operação
            </span>
          )}
          {approxTrades > 0 && (
            <span className="text-[10px] text-amber-400 text-right">
              {approxTrades === 1 ? "1 operação ainda sem PTAX: convertida" : `${approxTrades} operações ainda sem PTAX: convertidas`} pelo câmbio de hoje
            </span>
          )}
          {missingTrades > 0 && (
            <span className="text-[10px] text-tv-down text-right">
              {missingTrades === 1 ? "1 operação em outra moeda ficou" : `${missingTrades} operações em outra moeda ficaram`} fora dos valores: sem PTAX e
              sem câmbio de hoje
            </span>
          )}
          {leftOut > 0 && (
            <span className="text-[10px] text-tv-down text-right">
              {leftOut === 1 ? "1 ativo em outra moeda ficou" : `${leftOut} ativos em outra moeda ficaram`} FORA dos valores:{" "}
              {fx.status === "loading" ? "carregando o câmbio de hoje" : "sem o câmbio de hoje"}
            </span>
          )}
          {currency !== "USD" && fx.status === "error" && (
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
          extra={
            <div className="flex items-center gap-2">
            {allocBy === "horizon" &&
              segmented<HorizonMode>("Prazo por", horizonMode, [["thesis", "Tese"], ["maturity", "Maturação"]], setHorizonMode)}
            <select
              aria-label="Alocação por"
              className="tv-input py-1 text-xs font-semibold"
              value={allocBy}
              onChange={(e) => setAllocBy(e.target.value as AllocBy)}
            >
              {allocOptions.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
            </div>
          }
        >
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <Donut
              slices={slices.map((s, i) => ({ key: s.key, label: s.label, pct: s.pct, color: sliceColor(i, s.color) }))}
              ariaLabel={`Alocação ${allocLabel}: ${slices
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

      <Card title={isGlobal ? "Visão Global" : "Consolidado da Carteira"}>
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
              {sections.map(({ key: sectionKey, label, color, items }) => {
                const market = items.reduce((sum, it) => sum + it.marketValue, 0);
                const pnl = items.reduce((sum, it) => sum + it.totalPnL, 0);
                return (
                  <React.Fragment key={sectionKey}>
                    <tr className="bg-white/[0.03]">
                      <td colSpan={mode === "SEPARATED" ? 9 : 7} className="py-2 pl-2 pr-2 font-sans">
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="flex items-center gap-2 font-semibold uppercase tracking-wider text-tv-text/70">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                            {label}
                          </span>
                          <span className="font-mono text-tv-text/60">
                            {money(market)} · <span className={pnl >= 0 ? "text-tv-up" : "text-tv-down"}>{money(pnl)}</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {items.map((it) => (
                      <tr
                        key={it.key}
                        tabIndex={0}
                        role="link"
                        aria-label={`Abrir ${assetLabel(it)} em ${label}`}
                        title={`Abrir ${assetLabel(it)}`}
                        onClick={() => onOpenAsset(it.ticker, it.tabId, it.portfolioId)}
                        onKeyDown={(e) => e.key === "Enter" && onOpenAsset(it.ticker, it.tabId, it.portfolioId)}
                        className="group border-b border-tv-border/50 hover:bg-white/5 cursor-pointer transition-colors focus:outline-none focus:bg-white/5 focus:ring-2 focus:ring-inset focus:ring-tv-accent/40"
                      >
                        <td className="py-4 pl-2 font-bold">
                          <div className="flex items-center gap-1">
                            {assetLabel(it)}
                            <ChevronRight
                              size={14}
                              className="text-tv-accent opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity"
                            />
                          </div>
                          <div className="text-[10px] text-tv-text/40 font-normal">
                            {it.manualPrice ? <ManualPriceNote mp={it.manualPrice} /> : it.name}
                            {isGlobal && tabKeyOf(it) !== NO_TAB_KEY && <> · {tabById.get(it.tabId!)!.name}</>}
                          </div>
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

/** Where the price of an illiquid asset or cash account comes from (no market quote). */
function ManualPriceNote({ mp }: { mp: NonNullable<PortfolioItem["manualPrice"]> }) {
  if (mp.source === "cash") return <>Caixa</>;
  if (mp.source === "cost") return <span className="text-amber-400">sem avaliação: pelo custo</span>;
  const date = mp.date!.split("-").reverse().join("/");
  return <span className={mp.stale ? "text-amber-400" : undefined}>avaliado em {date}{mp.stale ? " (antiga)" : ""}</span>;
}
