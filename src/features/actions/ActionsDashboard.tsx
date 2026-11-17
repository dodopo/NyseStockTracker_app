import React, { Suspense, lazy, useId, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, History, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { format } from "date-fns";
import { ApiError, errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel } from "../../components/ui";
import { cn, formatCurrency, formatPercent, formatPrice, formatQuantity } from "../../lib/utils";
import { searchAssets, type SearchHit } from "../../services/marketService";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { Stock, Tab, TransactionType } from "../../types";
import { ASSET_TYPES, displaySymbol, type AssetType } from "../../../shared/assetTypes";
import { calculatePosition } from "../../../shared/positions";
import { firstIssue, transactionSchema } from "../../../shared/schemas";
import { compareTransactions } from "../../../shared/validation";
// The chart library is large: load it only when an asset is opened.
const PriceChart = lazy(() => import("../chart/PriceChart").then((m) => ({ default: m.PriceChart })));
import { StatsCard } from "../chart/StatsCard";

export function ActionsDashboard({
  tab,
  portfolio,
  selectedTicker,
  onSelect,
  onOpenSettings,
}: {
  tab: Tab;
  portfolio: PortfolioState;
  selectedTicker: string | null;
  onSelect: (ticker: string | null) => void;
  onOpenSettings: () => void;
}) {
  const { transactions, prices } = portfolio;
  const stocks = portfolio.stocks.filter((s) => s.tab_id === tab.id);
  const currentStock = stocks.find((s) => s.ticker === selectedTicker) ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="space-y-6">
        <AddStockCard key={tab.id} tab={tab} portfolio={portfolio} onAdded={onSelect} onOpenSettings={onOpenSettings} />
        <StockListCard
          tab={tab}
          stocks={stocks}
          portfolio={portfolio}
          selectedTicker={selectedTicker}
          onSelect={onSelect}
        />
      </div>

      <div className="lg:col-span-2 space-y-6">
        {currentStock ? (
          <StockDetail
            key={currentStock.ticker}
            stock={currentStock}
            portfolio={portfolio}
            price={prices[currentStock.ticker]}
            transactions={transactions.filter((t) => t.ticker === currentStock.ticker)}
            onOpenSettings={onOpenSettings}
          />
        ) : (
          <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-tv-text/20 space-y-4">
            <History size={64} />
            <p className="text-xl font-medium">
              {stocks.length ? "Selecione um ativo para ver detalhes" : `${ASSET_TYPES[tab.assetType].addTitle} para começar`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddStockCard({
  tab,
  portfolio,
  onAdded,
  onOpenSettings,
}: {
  tab: Tab;
  portfolio: PortfolioState;
  onAdded: (ticker: string) => void;
  onOpenSettings: () => void;
}) {
  const type = ASSET_TYPES[tab.assetType];
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [missingKey, setMissingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    setMessage(null);
    setMissingKey(false);
    setHits([]);
    try {
      const result = await searchAssets(q, tab.assetType);
      if (!result.length) setMessage(`Nenhum ativo encontrado para "${q}".`);
      else setHits(result);
    } catch (err) {
      setMissingKey(err instanceof ApiError && err.code === "MASSIVE_KEY_MISSING");
      setMessage(errorMessage(err, "Erro ao buscar ativo. Tente novamente."));
    } finally {
      setSearching(false);
    }
  };

  const add = async (hit: SearchHit) => {
    setError(null);
    try {
      await portfolio.addStock({ ticker: hit.ticker, name: hit.name, tabId: tab.id });
      onAdded(hit.ticker);
      setHits([]);
      setQuery("");
      setMessage(null);
    } catch (err) {
      setError(errorMessage(err, "Erro ao adicionar ativo"));
    }
  };

  return (
    <Card title={type.addTitle}>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={type.searchPlaceholder}
          aria-label={type.searchPlaceholder}
          className="tv-input flex-1 min-w-0"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button type="button" onClick={search} className="tv-btn px-3" disabled={searching} aria-label="Buscar">
          {searching ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
        </button>
      </div>

      {message && (
        <div className="mt-3 text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded p-2 space-y-2">
          <div>{message}</div>
          {missingKey && (
            <button type="button" onClick={onOpenSettings} className="underline hover:no-underline">
              Abrir Configurações
            </button>
          )}
        </div>
      )}

      {hits.length > 0 && (
        <motion.ul initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-2">
          {hits.map((hit) => (
            <li key={hit.ticker} className="p-3 bg-white/5 rounded border border-white/10 flex justify-between items-center gap-3">
              <div className="min-w-0">
                <div className="font-bold text-tv-accent">{hit.displaySymbol}</div>
                <div className="text-xs text-tv-text/60 truncate">{hit.name}</div>
              </div>
              <button type="button" onClick={() => void add(hit)} className="tv-btn py-1 px-3 text-sm shrink-0">
                Adicionar
              </button>
            </li>
          ))}
        </motion.ul>
      )}

      {error && <div className="mt-3"><ErrorMessage>{error}</ErrorMessage></div>}
    </Card>
  );
}

function StockListCard({
  tab,
  stocks,
  portfolio,
  selectedTicker,
  onSelect,
}: {
  tab: Tab;
  stocks: Stock[];
  portfolio: PortfolioState;
  selectedTicker: string | null;
  onSelect: (ticker: string | null) => void;
}) {
  const type = ASSET_TYPES[tab.assetType];

  const remove = async (ticker: string) => {
    const count = portfolio.transactions.filter((t) => t.ticker === ticker).length;
    const question =
      count > 0
        ? `Excluir ${displaySymbol(ticker)} e ${count === 1 ? "a transação dele" : `as ${count} transações dele`}?`
        : `Excluir ${displaySymbol(ticker)}?`;
    try {
      if (!(await portfolio.deleteStock(ticker, question))) return;
      if (selectedTicker === ticker) {
        onSelect(stocks.find((s) => s.ticker !== ticker)?.ticker ?? null);
      }
    } catch (err) {
      window.alert(errorMessage(err, "Não foi possível excluir a ação."));
    }
  };

  return (
    <Card title={type.listTitle}>
      <ul className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
        {stocks.map((stock) => (
          <li key={stock.ticker}>
            <div
              role="button"
              tabIndex={0}
              aria-current={selectedTicker === stock.ticker ? "true" : undefined}
              onClick={() => onSelect(stock.ticker)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(stock.ticker))}
              className={cn(
                "p-3 rounded cursor-pointer transition-all flex justify-between items-center group focus:outline-none focus:ring-2 focus:ring-tv-accent/50",
                selectedTicker === stock.ticker
                  ? "bg-tv-accent/20 border border-tv-accent/50"
                  : "bg-white/5 border border-transparent hover:border-white/20"
              )}
            >
              <div>
                <div className="font-bold">{displaySymbol(stock.ticker)}</div>
                <div className="text-xs text-tv-text/60 truncate max-w-[150px]">{stock.name}</div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(stock.ticker);
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-tv-down hover:scale-110 transition-all"
                title={`Excluir ${displaySymbol(stock.ticker)}`}
                aria-label={`Excluir ${displaySymbol(stock.ticker)}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </li>
        ))}
        {stocks.length === 0 && (
          <li className="text-center py-8 text-tv-text/40 italic">{type.emptyList}</li>
        )}
      </ul>
    </Card>
  );
}

function assetTypeOf(stock: Stock): AssetType {
  return stock.asset_type ?? (stock.ticker.startsWith("X:") ? "crypto" : "us_stock");
}

function StockDetail({
  stock,
  portfolio,
  price,
  transactions,
  onOpenSettings,
}: {
  stock: Stock;
  portfolio: PortfolioState;
  price: PortfolioState["prices"][string] | undefined;
  transactions: PortfolioState["transactions"];
  onOpenSettings: () => void;
}) {
  const currentPrice = price?.price || 0;
  const position = useMemo(() => calculatePosition(transactions, currentPrice), [transactions, currentPrice]);
  const history = useMemo(() => [...transactions].sort(compareTransactions).reverse(), [transactions]);

  const removeTransaction = async (t: (typeof transactions)[number]) => {
    if (!t.id) return;
    const kind = t.type === "BUY" ? "COMPRA" : "VENDA";
    const question = `Excluir a ${kind} de ${displaySymbol(stock.ticker)} de ${t.date}: ${formatQuantity(t.shares)} un @ ${formatPrice(t.price)}?`;
    try {
      await portfolio.deleteTransaction(t.id, question);
    } catch (err) {
      window.alert(errorMessage(err, "Não foi possível excluir a operação."));
    }
  };

  return (
    <>
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold">{displaySymbol(stock.ticker)}</h2>
          <p className="text-tv-text/60">{stock.name}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono">{formatPrice(currentPrice)}</div>
          <div
            className={cn(
              "text-sm font-medium flex items-center justify-end gap-1",
              (price?.change || 0) >= 0 ? "text-tv-up" : "text-tv-down"
            )}
          >
            {(price?.change || 0) >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {formatPercent(price?.changePercent || 0)}
          </div>
        </div>
      </div>

      <Suspense
        fallback={
          <Card className="h-[520px] flex items-center justify-center text-sm text-tv-text/40">Carregando gráfico…</Card>
        }
      >
        <PriceChart
          symbol={stock.ticker}
          assetType={assetTypeOf(stock)}
          transactions={transactions}
          avgCost={position.avgCost}
          hasPosition={position.shares > 0}
          livePrice={currentPrice}
          liveChangePct={price?.changePercent}
          name={stock.name}
          onOpenSettings={onOpenSettings}
        />
      </Suspense>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card title="Posição (Qtd)">
          <div className="text-2xl font-bold font-mono">{formatQuantity(position.quantity)}</div>
        </Card>
        <Card title="Preço Médio (PM)">
          <div className="text-2xl font-bold font-mono">{formatPrice(position.avgCost)}</div>
        </Card>
        <Card title="Investido (Aberto)">
          <div className="text-2xl font-bold font-mono">{formatCurrency(position.openCost)}</div>
        </Card>
        <Card title="P/L Não Realizado">
          <div className={cn("text-2xl font-bold font-mono", position.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
            {formatCurrency(position.unrealizedPnL)}
          </div>
          <div className="text-xs text-tv-text/40">{position.unrealizedPnLPct.toFixed(2)}%</div>
        </Card>
      </div>

      <StatsCard symbol={stock.ticker} currentPrice={currentPrice} assetType={assetTypeOf(stock)} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TransactionForm ticker={stock.ticker} portfolio={portfolio} />

        <Card title="Histórico de Transações">
          <ul className="space-y-3 max-h-[340px] overflow-y-auto pr-2">
            {history.map((t) => (
              <li
                key={t.id}
                className="flex justify-between items-center p-2 bg-white/5 rounded border border-white/5"
              >
                <div>
                  <div className={cn("text-xs font-bold", t.type === "BUY" ? "text-tv-up" : "text-tv-down")}>
                    {t.type === "BUY" ? "COMPRA" : "VENDA"}
                  </div>
                  <div className="text-sm font-mono">
                    {formatQuantity(t.shares)} un @ {formatPrice(t.price)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-tv-text/40">{t.date}</div>
                  <button
                    type="button"
                    onClick={() => void removeTransaction(t)}
                    className="text-tv-text/20 hover:text-tv-down transition-colors"
                    title="Excluir transação"
                    aria-label={`Excluir ${t.type === "BUY" ? "compra" : "venda"} de ${t.date}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
            {history.length === 0 && <li className="text-center py-10 text-tv-text/40 italic">Nenhuma transação</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}

function TransactionForm({ ticker, portfolio }: { ticker: string; portfolio: PortfolioState }) {
  const [type, setType] = useState<TransactionType>("BUY");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sharesId = useId();
  const priceId = useId();
  const dateId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const check = transactionSchema.safeParse({ ticker, type, shares, price, date });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }

    setSaving(true);
    try {
      await portfolio.addTransaction(check.data);
      setShares("");
      setPrice("");
    } catch (err) {
      setError(errorMessage(err, "Erro ao registrar transação"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Nova Transação">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-2 p-1 bg-white/5 rounded" role="radiogroup" aria-label="Tipo de operação">
          {(["BUY", "SELL"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={cn(
                "flex-1 py-1 rounded text-sm font-bold transition-all",
                type === t ? (t === "BUY" ? "bg-tv-up text-white" : "bg-tv-down text-white") : "text-tv-text/40"
              )}
            >
              {t === "BUY" ? "COMPRA" : "VENDA"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <FieldLabel htmlFor={sharesId}>Quantidade</FieldLabel>
            <input
              id={sharesId}
              type="text"
              inputMode="decimal"
              placeholder="ex: 10 ou 0.5"
              className="tv-input w-full"
              value={shares}
              onChange={(e) => setShares(e.target.value.replace(",", "."))}
              required
            />
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor={priceId}>Preço ($)</FieldLabel>
            <input
              id={priceId}
              type="text"
              inputMode="decimal"
              placeholder="ex: 162.85"
              className="tv-input w-full"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(",", "."))}
              required
            />
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor={dateId}>Data</FieldLabel>
          <input
            id={dateId}
            type="date"
            className="tv-input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>

        <button type="submit" disabled={saving} className="tv-btn w-full flex items-center justify-center gap-2">
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />} Registrar
        </button>

        <ErrorMessage>{error}</ErrorMessage>
      </form>
    </Card>
  );
}
