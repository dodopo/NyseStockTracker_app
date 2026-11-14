import React, { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "../../components/ui";
import { cn, formatCurrency, formatPrice, formatQuantity } from "../../lib/utils";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { ConsolidationMode, PortfolioItem } from "../../types";
import { calculatePosition } from "../../../shared/positions";
import { displaySymbol } from "../../../shared/assetTypes";

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

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, it) => ({
          invested: acc.invested + it.totalInvested,
          market: acc.market + it.marketValue,
          realized: acc.realized + it.realizedPnL,
          unrealized: acc.unrealized + it.unrealizedPnL,
          total: acc.total + it.totalPnL,
        }),
        { invested: 0, market: 0, realized: 0, unrealized: 0, total: 0 }
      ),
    [rows]
  );
  const totalPct = totals.invested > 0 ? (totals.total / totals.invested) * 100 : 0;

  // One section per tab, in the user's tab order; assets without a tab go last.
  const sections = useMemo(() => {
    const byTab = tabs
      .map((tab) => ({ tab, items: rows.filter((r) => r.tabId === tab.id) }))
      .filter((sec) => sec.items.length > 0);
    const orphans = rows.filter((r) => !tabs.some((t) => t.id === r.tabId));
    return orphans.length ? [...byTab, { tab: null, items: orphans }] : byTab;
  }, [tabs, rows]);

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
      <div className={cn("font-bold", value >= 0 ? "text-tv-up" : "text-tv-down")}>{formatCurrency(value)}</div>
      <div className={cn("text-[10px]", pct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>{pct.toFixed(2)}%</div>
    </td>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="bg-tv-accent/10 border-tv-accent/30">
          <div className="text-[10px] uppercase text-tv-accent font-bold mb-1">Patrimônio (Aberto)</div>
          <div className="text-2xl font-bold font-mono">{formatCurrency(totals.market)}</div>
        </Card>

        <Card>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Investido (Aberto)</div>
          <div className="text-2xl font-bold font-mono">{formatCurrency(totals.invested)}</div>
        </Card>

        <Card>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">P/L Total</div>
          <div className={cn("text-2xl font-bold font-mono", totals.total >= 0 ? "text-tv-up" : "text-tv-down")}>
            {formatCurrency(totals.total)}
          </div>
          <div className={cn("text-xs", totalPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>{totalPct.toFixed(2)}%</div>
        </Card>

        <Card extra={modeToggle}>
          <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Detalhes</div>
          {mode === "SEPARATED" ? (
            <div className="space-y-1">
              <div className="text-xs text-tv-text/50">Realizado</div>
              <div className={cn("text-lg font-bold font-mono", totals.realized >= 0 ? "text-tv-up" : "text-tv-down")}>
                {formatCurrency(totals.realized)}
              </div>
              <div className="text-xs text-tv-text/50">Não Realizado</div>
              <div className={cn("text-lg font-bold font-mono", totals.unrealized >= 0 ? "text-tv-up" : "text-tv-down")}>
                {formatCurrency(totals.unrealized)}
              </div>
            </div>
          ) : (
            <div className="text-xs text-tv-text/60">Modo unificado: tabela mostra apenas um resultado (Total).</div>
          )}
        </Card>
      </div>

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
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: tab?.color ?? "#78909c" }} />
                            {tab?.name ?? "Sem aba"}
                          </span>
                          <span className="font-mono text-tv-text/60">
                            {formatCurrency(market)} ·{" "}
                            <span className={pnl >= 0 ? "text-tv-up" : "text-tv-down"}>{formatCurrency(pnl)}</span>
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
                        <td className="py-4">{formatPrice(it.currentPrice)}</td>
                        <td className="py-4 text-tv-text/60">{formatPrice(it.avgCost)}</td>
                        <td className="py-4">{formatQuantity(it.quantity)}</td>
                        <td className="py-4 font-bold">{formatCurrency(it.marketValue)}</td>
                        <td className="py-4 text-tv-text/60">{formatCurrency(it.totalInvested)}</td>
                        {mode === "SEPARATED" && (
                          <>
                            <td className={cn("py-4", it.realizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                              {formatCurrency(it.realizedPnL)}
                            </td>
                            <td className={cn("py-4", it.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                              {formatCurrency(it.unrealizedPnL)}
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
