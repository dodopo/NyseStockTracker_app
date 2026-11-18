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
import { convertTrades } from "../../../shared/fxPositions";
import { CURRENCIES, CURRENCY_LABEL, isCurrency, type CurrencyCode } from "../../../shared/currencies";
import { ClassificationCard } from "./ClassificationCard";
import { useLiveFx } from "../../hooks/useLiveFx";
import { MaturityLadderCard } from "./MaturityLadderCard";
import { evaluatePicks } from "./tranchePicks";
import { defaultClassification } from "../../../shared/classification";
import { defaultTargetDays, localToday, replayTranches, type LotChoice, type TrancheTrade } from "../../../shared/tranches";
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
            tab={tab}
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
  tab,
  portfolio,
  price,
  transactions,
  onOpenSettings,
}: {
  stock: Stock;
  tab: Tab;
  portfolio: PortfolioState;
  price: PortfolioState["prices"][string] | undefined;
  transactions: PortfolioState["transactions"];
  onOpenSettings: () => void;
}) {
  const currentPrice = price?.price || 0;
  // Everything here is in the asset's own currency; a trade paid in another
  // currency enters at the PTAX frozen on it.
  const assetCurrency: CurrencyCode = isCurrency(stock.currency) ? stock.currency : "USD";
  // Today's rate only as a stand-in for a trade in another currency whose PTAX is not known yet.
  const needsLive = transactions.some((t) => !t.fx && isCurrency(t.currency) && t.currency !== assetCurrency);
  const fx = useLiveFx(needsLive);
  const live = needsLive && fx.status === "ready" ? fx.rates : null;
  const native = useMemo(() => convertTrades(transactions, assetCurrency, assetCurrency, live), [transactions, assetCurrency, live]);
  const position = useMemo(() => calculatePosition(native.trades, currentPrice), [native, currentPrice]);
  const tradeCurrency = (t: { currency?: string }) => (isCurrency(t.currency) ? t.currency : assetCurrency);

  // Tranches: quantities from the real trades, prices in the asset's currency (each at its PTAX).
  const horizon = stock.horizon === undefined ? defaultClassification(assetTypeOf(stock)).horizon : stock.horizon;
  const assetTargetDays = stock.target_days === undefined ? defaultTargetDays(horizon) : stock.target_days;
  const today = localToday();
  const tranches = useMemo(() => {
    // the same trades as the position (a trade left out for lack of a rate stays out here too)
    return replayTranches(native.trades, assetTargetDays);
  }, [native, transactions, assetTargetDays]);
  const buyDate = useMemo(() => new Map(transactions.filter((t) => t.type === "BUY").map((t) => [t.id, t.date])), [transactions]);
  const history = useMemo(() => [...transactions].sort(compareTransactions).reverse(), [transactions]);

  const removeTransaction = async (t: (typeof transactions)[number]) => {
    if (!t.id) return;
    const kind = t.type === "BUY" ? "COMPRA" : "VENDA";
    const question = `Excluir a ${kind} de ${displaySymbol(stock.ticker)} de ${t.date}: ${formatQuantity(t.shares)} un @ ${formatPrice(t.price, tradeCurrency(t))}?`;
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
          <div className="text-2xl font-mono">{formatPrice(currentPrice, assetCurrency)}</div>
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
          transactions={native.trades}
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
          <div className="text-2xl font-bold font-mono">{formatPrice(position.avgCost, assetCurrency)}</div>
        </Card>
        <Card title="Investido (Aberto)">
          <div className="text-2xl font-bold font-mono">{formatCurrency(position.openCost, assetCurrency)}</div>
        </Card>
        <Card title="P/L Não Realizado">
          <div className={cn("text-2xl font-bold font-mono", position.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
            {formatCurrency(position.unrealizedPnL, assetCurrency)}
          </div>
          <div className="text-xs text-tv-text/40">{position.unrealizedPnLPct.toFixed(2)}%</div>
        </Card>
      </div>

      {native.approx > 0 && (
        <p className="text-xs text-amber-400">
          {native.approx === 1 ? "1 operação paga em outra moeda ainda não tem" : `${native.approx} operações pagas em outra moeda ainda não têm`} PTAX
          do Banco Central: convertida(s) pelo câmbio de hoje, aproximado. O app busca a PTAX a cada 30 minutos.
        </p>
      )}
      {native.missing > 0 && (
        <p className="text-xs text-tv-down">
          {native.missing === 1 ? "1 operação paga em outra moeda ficou" : `${native.missing} operações pagas em outra moeda ficaram`} FORA do preço
          médio e da posição: ainda sem PTAX e sem câmbio de hoje para converter. O app tenta de novo a cada 30 minutos.
        </p>
      )}

      <StatsCard symbol={stock.ticker} currentPrice={currentPrice} assetType={assetTypeOf(stock)} />

      <ClassificationCard stock={stock} tab={tab} portfolio={portfolio} />

      <MaturityLadderCard
        tranches={tranches.open}
        today={today}
        currentPrice={currentPrice}
        currency={assetCurrency}
        assetTargetDays={assetTargetDays}
        portfolio={portfolio}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TransactionForm
          ticker={stock.ticker}
          assetCurrency={assetCurrency}
          assetTargetDays={assetTargetDays}
          trades={native.trades}
          portfolio={portfolio}
        />

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
                    {formatQuantity(t.shares)} un @ {formatPrice(t.price, tradeCurrency(t))}
                  </div>
                  <PtaxLine fx={t.fx} />
                  {t.type === "SELL" && (
                    <div className="text-[10px] text-tv-text/40">
                      {t.lots?.length
                        ? `Tranches: ${t.lots.map((l) => `${buyDate.get(l.buyId) ?? "?"} (${formatQuantity(l.shares)})`).join(", ")}`
                        : "Tranches: as mais antigas primeiro"}
                    </div>
                  )}
                  {t.type === "BUY" && t.target_days != null && (
                    <div className="text-[10px] text-tv-text/40">Prazo próprio: {t.target_days.toLocaleString("pt-BR")} dias</div>
                  )}
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

/** The PTAX frozen on a trade (US$ 1 = R$ x, sell), or why there is none yet. */
function PtaxLine({ fx }: { fx: PortfolioState["transactions"][number]["fx"] }) {
  if (fx === undefined) return null;
  if (fx === null) return <div className="text-[10px] text-amber-400">PTAX pendente (Banco Central)</div>;
  const [y, m, d] = fx.date.split("-");
  const usd = Number(fx.sell.USD).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return (
    <div
      className="text-[10px] text-tv-text/40"
      title={`PTAX de fechamento (venda) de ${d}/${m}/${y}: US$ ${fx.sell.USD} · € ${fx.sell.EUR} · CHF ${fx.sell.CHF} em reais`}
    >
      PTAX {d}/{m}/{y}: US$ 1 = R$ {usd}
      {fx.provisional && <span className="text-amber-400"> (provisória)</span>}
    </div>
  );
}

function TransactionForm({
  ticker,
  assetCurrency,
  assetTargetDays,
  trades,
  portfolio,
}: {
  ticker: string;
  assetCurrency: CurrencyCode;
  assetTargetDays: number | null;
  /** The asset's trades (in its currency), to list the tranches open on the sale date. */
  trades: Array<TrancheTrade & { id?: number }>;
  portfolio: PortfolioState;
}) {
  const [type, setType] = useState<TransactionType>("BUY");
  const [targetText, setTargetText] = useState("");
  const [choose, setChoose] = useState(false);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const targetId = useId();
  const [currency, setCurrency] = useState<CurrencyCode>(assetCurrency);
  const currencyId = useId();
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  // Tranches open ON the sale date (a later purchase cannot be chosen; one sold later still can).
  const openTranches = useMemo(
    () => replayTranches(trades.filter((t) => t.date <= date), assetTargetDays).open,
    [trades, date, assetTargetDays]
  );
  // Choosing tranches: the quantity sold IS the sum of what was chosen (exact decimals).
  const choosing = type === "SELL" && choose;
  const { picks, sum: pickedSum, total: pickedTotal } = evaluatePicks(openTranches, picked);
  const effectiveShares = choosing ? pickedTotal : shares;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sharesId = useId();
  const priceId = useId();
  const dateId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const targetDays = type === "BUY" && targetText.trim() ? Number(targetText) : undefined;
    let lots: LotChoice[] | undefined;
    if (choosing) {
      const bad = picks.find((p) => p.invalid || p.over);
      if (bad) {
        setError(
          bad.invalid
            ? `Quantidade inválida na tranche de ${bad.tranche.buy.date}.`
            : `A tranche de ${bad.tranche.buy.date} só tem ${formatQuantity(bad.tranche.remaining)} aberta nessa data.`
        );
        return;
      }
      lots = picks.filter((p) => p.value).map((p) => ({ buyId: p.tranche.buyId!, shares: p.value! }));
      if (!lots.length) {
        setError("Diga quanto sai de cada tranche, ou use 'mais antigas primeiro'.");
        return;
      }
    }
    const check = transactionSchema.safeParse({ ticker, type, shares: effectiveShares, price, date, currency, targetDays, lots });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }

    setSaving(true);
    try {
      await portfolio.addTransaction(check.data);
      setShares("");
      setPrice("");
      setTargetText("");
      setPicked({});
      setChoose(false);
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
              placeholder={choosing ? "soma das tranches" : "ex: 10 ou 0.5"}
              className={cn("tv-input w-full", choosing && "opacity-70 cursor-not-allowed")}
              value={effectiveShares}
              readOnly={choosing}
              aria-readonly={choosing}
              title={choosing ? "Soma das quantidades escolhidas em cada tranche" : undefined}
              onChange={(e) => !choosing && setShares(e.target.value.replace(",", "."))}
              required={!choosing}
            />
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor={priceId}>Preço ({currency})</FieldLabel>
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

        <div className="grid grid-cols-2 gap-4">
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
          <div className="space-y-1">
            <FieldLabel htmlFor={currencyId}>Moeda paga</FieldLabel>
            <select id={currencyId} className="tv-input w-full" value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {type === "BUY" && (
          <div className="space-y-1">
            <FieldLabel htmlFor={targetId}>Prazo-alvo desta tranche (dias)</FieldLabel>
            <input
              id={targetId}
              type="text"
              inputMode="numeric"
              className="tv-input w-full"
              placeholder={assetTargetDays === null ? "sem prazo no ativo" : `em branco = o do ativo (${assetTargetDays.toLocaleString("pt-BR")} dias)`}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        )}

        {type === "SELL" && (
          <fieldset className="space-y-2">
            <legend className="text-[10px] uppercase text-tv-text/40 font-bold">De quais tranches sai</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name={`${targetId}-mode`} checked={!choose} onChange={() => setChoose(false)} /> Mais antigas primeiro
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${targetId}-mode`} checked={choose} onChange={() => setChoose(true)} disabled={!openTranches.length} />
                Escolher tranches
              </label>
            </div>
            {choose && (
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {picks.map(({ tranche: t, raw, invalid, over }) => (
                  <li key={t.buyId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono">
                      {t.buy.date} · aberta {formatQuantity(t.remaining)}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded border border-white/10 text-tv-text/60 hover:bg-white/5"
                        onClick={() => setPicked((cur) => ({ ...cur, [t.buyId!]: t.remaining }))}
                        title={`Vender a tranche inteira (${t.remaining})`}
                      >
                        tudo
                      </button>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`Quantidade a vender da compra de ${t.buy.date}`}
                        aria-invalid={invalid || over}
                        className={cn("tv-input w-28 py-0.5", (invalid || over) && "border-tv-down text-tv-down")}
                        placeholder="0"
                        value={raw}
                        onChange={(e) => setPicked((cur) => ({ ...cur, [t.buyId!]: e.target.value.replace(",", ".") }))}
                      />
                    </span>
                  </li>
                ))}
                <li className="flex justify-between text-xs pt-1 border-t border-white/10">
                  <span className="text-tv-text/60">Total da venda</span>
                  <span className="font-mono font-semibold">{formatQuantity(pickedSum.toFixed())}</span>
                </li>
              </ul>
            )}
          </fieldset>
        )}

        <p className="text-[10px] text-tv-text/40">
          A PTAX (Banco Central) da data fica gravada na operação, para converter o custo em qualquer moeda.
        </p>

        <button type="submit" disabled={saving} className="tv-btn w-full flex items-center justify-center gap-2">
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />} Registrar
        </button>

        <ErrorMessage>{error}</ErrorMessage>
      </form>
    </Card>
  );
}
