import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  History,
  Plus,
  Search,
  Trash2,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { format } from "date-fns";
import { cn, formatCurrency, formatPercent, formatNumber } from "./lib/utils";
import type { Stock, Transaction, TransactionType, PortfolioItem, ConsolidationMode } from "./types";
import { fetchQuotes, pricesToMap, searchStock, StockPrice } from "./services/marketService";

// -----------------------------
// UI building blocks
// -----------------------------
const TabButton = ({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: any;
  label: string;
}) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-4 py-3 border-b-2 transition-all",
      active
        ? "border-tv-accent text-tv-accent bg-tv-accent/5"
        : "border-transparent text-tv-text/60 hover:text-tv-text hover:bg-white/5"
    )}
  >
    <Icon size={18} />
    <span className="font-medium">{label}</span>
  </button>
);

const Card = ({
  title,
  children,
  className,
  extra,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  extra?: React.ReactNode;
}) => (
  <div className={cn("tv-card p-4", className)}>
    {(title || extra) && (
      <div className="flex justify-between items-center mb-4">
        {title && (
          <h3 className="text-sm font-semibold uppercase tracking-wider text-tv-text/50">
            {title}
          </h3>
        )}
        {extra}
      </div>
    )}
    {children}
  </div>
);

// -----------------------------
// PM calc (padrão corretora)
// -----------------------------
function calculatePMPosition(transactions: Transaction[], currentPrice: number) {
  // Sort chronological (date ASC, id ASC) to ensure correct state
  const txs = [...transactions].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.id || 0) - (b.id || 0);
  });

  let shares = 0;
  let openCost = 0; // custo da posição em aberto
  let realizedPnL = 0;

  for (const t of txs) {
    const qty = Number(t.shares);
    const px = Number(t.price);

    if (t.type === "BUY") {
      shares += qty;
      openCost += qty * px;
    } else {
      // SELL (no-short should already be enforced by backend)
      if (qty > shares) {
        // Defensive: ignore invalid to avoid NaN, but you should never reach here
        continue;
      }
      const avgCost = shares > 0 ? openCost / shares : 0;
      realizedPnL += (px - avgCost) * qty;

      // Reduce position at avg cost
      shares -= qty;
      openCost -= avgCost * qty;
    }
  }

  const avgCost = shares > 0 ? openCost / shares : 0;
  const marketValue = shares * currentPrice;
  const unrealizedPnL = shares * (currentPrice - avgCost);

  const unrealizedPnLPct = openCost > 0 ? (unrealizedPnL / openCost) * 100 : 0;
  const totalPnL = realizedPnL + unrealizedPnL;
  const totalPnLPct = openCost > 0 ? (totalPnL / openCost) * 100 : 0;

  return {
    shares,
    avgCost,
    openCost, // totalInvested (posição aberta)
    marketValue,
    realizedPnL,
    unrealizedPnL,
    unrealizedPnLPct,
    totalPnL,
    totalPnLPct,
  };
}

// -----------------------------
// Main App
// -----------------------------
export default function App() {
  const [activeTab, setActiveTab] = useState<"acoes" | "consolidado">("consolidado");

  const [stocks, setStocks] = useState<Stock[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Consolidado view toggle
  const [mode, setMode] = useState<ConsolidationMode>("SEPARATED");

  const loadPrices = async (tickers: string[]) => {
    if (!tickers.length) return;
    const arr = await fetchQuotes(tickers);
    setPrices(pricesToMap(arr));
  };

  const fetchData = async () => {
    try {
      const [stocksRes, transRes] = await Promise.all([
        fetch("/api/stocks"),
        fetch("/api/transactions?order=desc"),
      ]);

      const stocksData = await stocksRes.json();
      const transData = await transRes.json();

      setStocks(stocksData);
      setTransactions(transData);

      await loadPrices(stocksData.map((s: Stock) => s.ticker));
    } catch (e) {
      console.error("fetchData error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const refreshPrices = async () => {
    if (!stocks.length) return;
    setRefreshing(true);
    try {
      await loadPrices(stocks.map((s) => s.ticker));
    } finally {
      setRefreshing(false);
    }
  };

  // -----------------------------
  // AÇÕES
  // -----------------------------
  const ActionsDashboard = () => {
    const [searchQuery, setSearchQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [newStock, setNewStock] = useState<Stock | null>(null);

    const [selectedStock, setSelectedStock] = useState<string | null>(stocks[0]?.ticker || null);

    const [transForm, setTransForm] = useState<{
      type: TransactionType;
      shares: string;
      price: string;
      date: string;
    }>({
      type: "BUY",
      shares: "",
      price: "",
      date: format(new Date(), "yyyy-MM-dd"),
    });

    const [apiError, setApiError] = useState<string | null>(null);

    // Keep selection valid if stocks list changes
    useEffect(() => {
      if (!selectedStock && stocks[0]?.ticker) setSelectedStock(stocks[0].ticker);
      if (selectedStock && !stocks.some((s) => s.ticker === selectedStock)) {
        setSelectedStock(stocks[0]?.ticker || null);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stocks]);

    const handleSearch = async () => {
      if (!searchQuery) return;
      setSearching(true);
      setApiError(null);
      try {
        const result = await searchStock(searchQuery);
        setNewStock(result);
      } catch (e) {
        setNewStock(null);
      } finally {
        setSearching(false);
      }
    };

    const addStock = async () => {
      if (!newStock) return;

      const res = await fetch("/api/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newStock),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setApiError(err?.error || "Erro ao adicionar ação");
        return;
      }

      const updated = await (await fetch("/api/stocks")).json();
      setStocks(updated);
      setNewStock(null);
      setSearchQuery("");
      setSelectedStock(newStock.ticker);
      await loadPrices(updated.map((s: Stock) => s.ticker));
    };

    const deleteStock = async (ticker: string) => {
      if (!confirm(`Delete ${ticker} e todas as transações?`)) return;
      await fetch(`/api/stocks/${ticker}`, { method: "DELETE" });

      const updatedStocks = await (await fetch("/api/stocks")).json();
      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();

      setStocks(updatedStocks);
      setTransactions(updatedTrans);

      if (selectedStock === ticker) setSelectedStock(updatedStocks[0]?.ticker || null);
    };

    const addTransaction = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedStock) return;

      setApiError(null);

      const payload = {
        ticker: selectedStock,
        type: transForm.type,
        shares: Number(transForm.shares),
        price: Number(transForm.price),
        date: transForm.date,
      };

      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setApiError(err?.error || "Erro ao registrar transação");
        return;
      }

      // Refresh transactions
      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();
      setTransactions(updatedTrans);

      // clear inputs
      setTransForm((s) => ({ ...s, shares: "", price: "" }));
    };

    const deleteTransaction = async (id?: number) => {
      if (!id) return;
      await fetch(`/api/transactions/${id}`, { method: "DELETE" });
      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();
      setTransactions(updatedTrans);
    };

    const currentStock = stocks.find((s) => s.ticker === selectedStock);
    const currentPrice = selectedStock ? (prices[selectedStock]?.price || 0) : 0;

    const txForSelected = useMemo(() => {
      if (!selectedStock) return [];
      return transactions.filter((t) => t.ticker === selectedStock);
    }, [transactions, selectedStock]);

    const pm = useMemo(() => {
      if (!selectedStock) return null;
      // for accurate PM we need chronological; our calc sorts internally.
      return calculatePMPosition(txForSelected, currentPrice);
    }, [txForSelected, currentPrice, selectedStock]);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Search + Stock list */}
        <div className="space-y-6">
          <Card title="Adicionar Ação">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Ticker ou Nome (ex: AAPL)"
                className="tv-input flex-1"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button onClick={handleSearch} className="tv-btn px-3" disabled={searching}>
                {searching ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
              </button>
            </div>

            {newStock && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-3 bg-white/5 rounded border border-white/10 flex justify-between items-center"
              >
                <div>
                  <div className="font-bold text-tv-accent">{newStock.ticker}</div>
                  <div className="text-xs text-tv-text/60">{newStock.name}</div>
                </div>
                <button onClick={addStock} className="tv-btn py-1 px-3 text-sm">
                  Adicionar
                </button>
              </motion.div>
            )}

            {apiError && (
              <div className="mt-3 text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                {apiError}
              </div>
            )}
          </Card>

          <Card title="Minhas Ações">
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
              {stocks.map((stock) => (
                <div
                  key={stock.ticker}
                  onClick={() => setSelectedStock(stock.ticker)}
                  className={cn(
                    "p-3 rounded cursor-pointer transition-all flex justify-between items-center group",
                    selectedStock === stock.ticker
                      ? "bg-tv-accent/20 border border-tv-accent/50"
                      : "bg-white/5 border border-transparent hover:border-white/20"
                  )}
                >
                  <div>
                    <div className="font-bold">{stock.ticker}</div>
                    <div className="text-xs text-tv-text/60 truncate max-w-[150px]">{stock.name}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteStock(stock.ticker);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-tv-down hover:scale-110 transition-all"
                    title="Excluir ação"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {stocks.length === 0 && (
                <div className="text-center py-8 text-tv-text/40 italic">Nenhuma ação adicionada</div>
              )}
            </div>
          </Card>
        </div>

        {/* Right: Selected stock + transactions */}
        <div className="lg:col-span-2 space-y-6">
          {selectedStock ? (
            <>
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-bold">{currentStock?.ticker}</h2>
                  <p className="text-tv-text/60">{currentStock?.name}</p>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-mono">{formatCurrency(currentPrice)}</div>
                  <div
                    className={cn(
                      "text-sm font-medium flex items-center justify-end gap-1",
                      (prices[selectedStock]?.change || 0) >= 0 ? "text-tv-up" : "text-tv-down"
                    )}
                  >
                    {(prices[selectedStock]?.change || 0) >= 0 ? (
                      <ArrowUpRight size={14} />
                    ) : (
                      <ArrowDownRight size={14} />
                    )}
                    {formatPercent(prices[selectedStock]?.changePercent || 0)}
                  </div>
                </div>
              </div>

              {/* Quick PM Summary */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <Card title="Posição (Qtd)">
                  <div className="text-2xl font-bold font-mono">{pm ? pm.shares : 0}</div>
                </Card>
                <Card title="Preço Médio (PM)">
                  <div className="text-2xl font-bold font-mono">{formatCurrency(pm?.avgCost || 0)}</div>
                </Card>
                <Card title="Investido (Aberto)">
                  <div className="text-2xl font-bold font-mono">{formatCurrency(pm?.openCost || 0)}</div>
                </Card>
                <Card title="P/L Não Realizado">
                  <div className={cn("text-2xl font-bold font-mono", (pm?.unrealizedPnL || 0) >= 0 ? "text-tv-up" : "text-tv-down")}>
                    {formatCurrency(pm?.unrealizedPnL || 0)}
                  </div>
                  <div className="text-xs text-tv-text/40">{(pm?.unrealizedPnLPct || 0).toFixed(2)}%</div>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Transaction form */}
                <Card title="Nova Transação">
                  <form onSubmit={addTransaction} className="space-y-4">
                    <div className="flex gap-2 p-1 bg-white/5 rounded">
                      <button
                        type="button"
                        onClick={() => setTransForm((s) => ({ ...s, type: "BUY" }))}
                        className={cn(
                          "flex-1 py-1 rounded text-sm font-bold transition-all",
                          transForm.type === "BUY" ? "bg-tv-up text-white" : "text-tv-text/40"
                        )}
                      >
                        COMPRA
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransForm((s) => ({ ...s, type: "SELL" }))}
                        className={cn(
                          "flex-1 py-1 rounded text-sm font-bold transition-all",
                          transForm.type === "SELL" ? "bg-tv-down text-white" : "text-tv-text/40"
                        )}
                      >
                        VENDA
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase text-tv-text/40 font-bold">Quantidade</label>
                        <input
                          type="number"
                          step="any"
                          className="tv-input w-full"
                          value={transForm.shares}
                          onChange={(e) => setTransForm((s) => ({ ...s, shares: e.target.value }))}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase text-tv-text/40 font-bold">Preço ($)</label>
                        <input
                          type="number"
                          step="any"
                          className="tv-input w-full"
                          value={transForm.price}
                          onChange={(e) => setTransForm((s) => ({ ...s, price: e.target.value }))}
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] uppercase text-tv-text/40 font-bold">Data</label>
                      <input
                        type="date"
                        className="tv-input w-full"
                        value={transForm.date}
                        onChange={(e) => setTransForm((s) => ({ ...s, date: e.target.value }))}
                        required
                      />
                    </div>

                    <button type="submit" className="tv-btn w-full flex items-center justify-center gap-2">
                      <Plus size={18} /> Registrar
                    </button>

                    {apiError && (
                      <div className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                        {apiError}
                      </div>
                    )}
                  </form>
                </Card>

                {/* Transactions list */}
                <Card title="Histórico de Transações">
                  <div className="space-y-3 max-h-[340px] overflow-y-auto pr-2">
                    {txForSelected
                      .slice()
                      .sort((a, b) => {
                        const d = b.date.localeCompare(a.date);
                        if (d !== 0) return d;
                        return (b.id || 0) - (a.id || 0);
                      })
                      .map((t) => (
                        <div
                          key={t.id}
                          className="flex justify-between items-center p-2 bg-white/5 rounded border border-white/5"
                        >
                          <div>
                            <div className={cn("text-xs font-bold", t.type === "BUY" ? "text-tv-up" : "text-tv-down")}>
                              {t.type === "BUY" ? "COMPRA" : "VENDA"}
                            </div>
                            <div className="text-sm font-mono">
                              {t.shares} un @ {formatCurrency(t.price)}
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-xs text-tv-text/40">{t.date}</div>
                            <button
                              onClick={() => deleteTransaction(t.id)}
                              className="text-tv-text/20 hover:text-tv-down transition-colors"
                              title="Excluir transação"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}

                    {txForSelected.length === 0 && (
                      <div className="text-center py-10 text-tv-text/40 italic">Nenhuma transação</div>
                    )}
                  </div>
                </Card>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-tv-text/20 space-y-4">
              <History size={64} />
              <p className="text-xl font-medium">Selecione uma ação para ver detalhes</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // -----------------------------
  // CONSOLIDADO (with toggle)
  // -----------------------------
  const consolidated: PortfolioItem[] = useMemo(() => {
    return stocks.map((s) => {
      const txs = transactions.filter((t) => t.ticker === s.ticker);
      const currentPrice = prices[s.ticker]?.price || 0;

      const pm = calculatePMPosition(txs, currentPrice);

      return {
        ticker: s.ticker,
        name: s.name,

        shares: pm.shares,
        avgCost: pm.avgCost,
        totalInvested: pm.openCost,

        currentPrice,
        marketValue: pm.marketValue,

        unrealizedPnL: pm.unrealizedPnL,
        realizedPnL: pm.realizedPnL,
        totalPnL: pm.totalPnL,
        totalPnLPct: pm.totalPnLPct,
      };
    });
  }, [stocks, transactions, prices]);

  const totals = useMemo(() => {
    return consolidated.reduce(
      (acc, it) => {
        acc.invested += it.totalInvested;
        acc.market += it.marketValue;
        acc.realized += it.realizedPnL;
        acc.unrealized += it.unrealizedPnL;
        acc.total += it.totalPnL;
        return acc;
      },
      { invested: 0, market: 0, realized: 0, unrealized: 0, total: 0 }
    );
  }, [consolidated]);

  const ConsolidatedDashboard = () => {
    const totalPct = totals.invested > 0 ? (totals.total / totals.invested) * 100 : 0;

    const modeToggle = (
  <div className="flex items-center gap-3">
    <span className={cn("text-xs transition-opacity", mode === "UNIFIED" ? "opacity-100" : "opacity-50")}>
      Unificado
    </span>

    <button
      type="button"
      role="switch"
      aria-checked={mode === "SEPARATED"}
      onClick={() => setMode((m) => (m === "UNIFIED" ? "SEPARATED" : "UNIFIED"))}
      className={cn(
        "relative inline-flex h-7 w-14 items-center rounded-full border transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-tv-accent/40",
        "bg-white/5 border-white/20"
      )}
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

    return (
      <div className="space-y-6">
        {/* Summary */}
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
            <div className={cn("text-xs", totalPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
              {totalPct.toFixed(2)}%
            </div>
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
                <div
                  className={cn("text-lg font-bold font-mono", totals.unrealized >= 0 ? "text-tv-up" : "text-tv-down")}
                >
                  {formatCurrency(totals.unrealized)}
                </div>
              </div>
            ) : (
              <div className="text-xs text-tv-text/60">
                Modo unificado: tabela mostra apenas um resultado (Total).
              </div>
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
                  {mode === "SEPARATED" ? (
                    <>
                      <th className="pb-3">P/L Real.</th>
                      <th className="pb-3">P/L Não Real.</th>
                      <th className="pb-3 pr-2 text-right">P/L Total</th>
                    </>
                  ) : (
                    <th className="pb-3 pr-2 text-right">P/L Total</th>
                  )}
                </tr>
              </thead>

              <tbody className="text-sm font-mono">
                {consolidated.map((it) => (
                  <tr key={it.ticker} className="border-b border-tv-border/50 hover:bg-white/5 transition-colors">
                    <td className="py-4 pl-2 font-bold">
                      <div>{it.ticker}</div>
                      <div className="text-[10px] text-tv-text/40 font-normal">{it.name}</div>
                    </td>

                    <td className="py-4">{formatCurrency(it.currentPrice)}</td>
                    <td className="py-4 text-tv-text/60">{formatCurrency(it.avgCost)}</td>
                    <td className="py-4">{it.shares}</td>
                    <td className="py-4 font-bold">{formatCurrency(it.marketValue)}</td>
                    <td className="py-4 text-tv-text/60">{formatCurrency(it.totalInvested)}</td>

                    {mode === "SEPARATED" ? (
                      <>
                        <td className={cn("py-4", it.realizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.realizedPnL)}
                        </td>
                        <td className={cn("py-4", it.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.unrealizedPnL)}
                        </td>
                        <td className="py-4 pr-2 text-right">
                          <div className={cn("font-bold", it.totalPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                            {formatCurrency(it.totalPnL)}
                          </div>
                          <div className={cn("text-[10px]", it.totalPnLPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
                            {it.totalPnLPct.toFixed(2)}%
                          </div>
                        </td>
                      </>
                    ) : (
                      <td className="py-4 pr-2 text-right">
                        <div className={cn("font-bold", it.totalPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.totalPnL)}
                        </div>
                        <div className={cn("text-[10px]", it.totalPnLPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
                          {it.totalPnLPct.toFixed(2)}%
                        </div>
                      </td>
                    )}
                  </tr>
                ))}

                {consolidated.length === 0 && (
                  <tr>
                    <td colSpan={mode === "SEPARATED" ? 9 : 7} className="py-12 text-center text-tv-text/20 italic">
                      Adicione ações e transações para ver o consolidado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  };

  // -----------------------------
  // Render
  // -----------------------------
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-tv-bg text-tv-accent">
        <Loader2 className="animate-spin" size={48} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-tv-bg text-tv-text flex flex-col">
      {/* Header */}
      <header className="tv-card border-x-0 border-t-0 rounded-none px-6 py-4 flex justify-between items-center sticky top-0 z-50 backdrop-blur-md bg-tv-bg/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-tv-accent rounded flex items-center justify-center text-white">
            <TrendingUp size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-none">NYSE Tracker</h1>
            <span className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">
              Portfolio + Trades (PM)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={refreshPrices}
            className={cn(
              "p-2 rounded hover:bg-white/5 transition-all text-tv-text/60",
              refreshing && "animate-spin text-tv-accent"
            )}
            title="Atualizar preços"
          >
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      {/* Navigation */}
      <nav className="px-6 border-b border-tv-border flex overflow-x-auto no-scrollbar">
        <TabButton
          active={activeTab === "consolidado"}
          onClick={() => setActiveTab("consolidado")}
          icon={LayoutDashboard}
          label="CONSOLIDADO"
        />
        <TabButton
          active={activeTab === "acoes"}
          onClick={() => setActiveTab("acoes")}
          icon={History}
          label="AÇÕES"
        />
      </nav>

      {/* Main */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === "acoes" && <ActionsDashboard />}
            {activeTab === "consolidado" && <ConsolidatedDashboard />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="p-6 text-center text-[10px] text-tv-text/20 uppercase tracking-widest font-bold">
        NYSE Portfolio Tracker &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}