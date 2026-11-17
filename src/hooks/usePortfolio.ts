import { useCallback, useEffect, useRef, useState } from "react";
import { portfolioApi, tabsApi } from "../api/endpoints";
import { ApiError } from "../api/client";
import { fetchQuotes, pricesToMap, type StockPrice } from "../services/marketService";
import type { ClassificationChanges, Stock, Tab, Transaction } from "../types";
import type { AssetType } from "../../shared/assetTypes";
import { confirmDestructive } from "../lib/confirm";

/**
 * Data of one portfolio: tabs, assets, transactions and quotes.
 * `portfolioId` is the active portfolio, or null (nothing loaded).
 *
 * Every request names its portfolio explicitly, and every state update is
 * dropped if the user switched to another portfolio meanwhile, so a late
 * response never shows (or lets the user act on) the wrong portfolio.
 * `onMissing` runs when the server no longer knows the portfolio (deleted on
 * another device, or ids changed by a restore).
 */
export function usePortfolio(portfolioId: number | null, onMissing?: () => void) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Which portfolio the current data belongs to; `ready` only once its first load finished.
  const [loadedKey, setLoadedKey] = useState<number | null>(null);
  const keyRef = useRef(portfolioId);
  keyRef.current = portfolioId;
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;

  /** The portfolio a call acts on; throws if none is active. */
  const pinned = () => {
    const pid = keyRef.current;
    if (pid === null) throw new Error("Nenhuma carteira ativa");
    return pid;
  };
  const still = (pid: number) => keyRef.current === pid;

  const loadPrices = useCallback(async (pid: number, tickers: string[]) => {
    const next = tickers.length ? pricesToMap(await fetchQuotes(tickers)) : {};
    if (still(pid)) setPrices(next);
  }, []);

  const reload = useCallback(async () => {
    const pid = keyRef.current;
    if (pid === null) return;
    setLoading(true);
    try {
      const [nextTabs, nextStocks, nextTransactions] = await Promise.all([
        tabsApi.list(pid),
        portfolioApi.stocks(pid),
        portfolioApi.transactions(pid),
      ]);
      if (!still(pid)) return;
      setTabs(nextTabs);
      setStocks(nextStocks);
      setTransactions(nextTransactions);
      await loadPrices(pid, nextStocks.map((s) => s.ticker));
    } catch (error) {
      if (error instanceof ApiError && error.code === "PORTFOLIO_NOT_FOUND" && still(pid)) onMissingRef.current?.();
      else console.error("portfolio load error:", error);
    } finally {
      if (still(pid)) setLoading(false);
    }
  }, [loadPrices]);

  useEffect(() => {
    setLoadedKey(null);
    if (portfolioId === null) {
      setTabs([]);
      setStocks([]);
      setTransactions([]);
      setPrices({});
      return;
    }
    void reload().then(() => {
      if (still(portfolioId)) setLoadedKey(portfolioId);
    });
  }, [portfolioId, reload]);

  const refreshPrices = useCallback(async () => {
    const pid = keyRef.current;
    if (pid === null || !stocks.length) return;
    setRefreshing(true);
    try {
      await loadPrices(pid, stocks.map((s) => s.ticker));
    } finally {
      setRefreshing(false);
    }
  }, [stocks, loadPrices]);

  const reloadTabs = useCallback(async (pid: number) => {
    const next = await tabsApi.list(pid);
    if (still(pid)) setTabs(next);
  }, []);

  const addStock = useCallback(
    async (stock: { ticker: string; name: string; tabId: number }) => {
      const pid = pinned();
      await portfolioApi.addStock(pid, stock);
      const [nextStocks, nextTabs] = await Promise.all([portfolioApi.stocks(pid), tabsApi.list(pid)]);
      if (!still(pid)) return;
      setStocks(nextStocks);
      setTabs(nextTabs);
      await loadPrices(pid, nextStocks.map((s) => s.ticker));
    },
    [loadPrices]
  );

  const addTab = useCallback(async (tab: { name: string; assetType: AssetType; color: string }) => {
    const pid = pinned();
    const created = await tabsApi.create(pid, tab);
    await reloadTabs(pid);
    return created;
  }, [reloadTabs]);

  const updateTab = useCallback(async (id: number, changes: { name?: string; color?: string }) => {
    const pid = pinned();
    await tabsApi.update(pid, id, changes);
    await reloadTabs(pid);
  }, [reloadTabs]);

  const reorderTabs = useCallback(async (ids: number[]) => {
    const pid = pinned();
    const next = await tabsApi.reorder(pid, ids);
    if (still(pid)) setTabs(next);
  }, []);

  // Deletions: each one takes the question shown to the user and does nothing
  // (returns false) unless the user confirms it. See lib/confirm.ts.

  const deleteTab = useCallback(async (id: number, moveTo: number | undefined, question: string) => {
    if (!confirmDestructive(question)) return false;
    const pid = pinned();
    await tabsApi.remove(pid, id, moveTo);
    const [nextTabs, nextStocks] = await Promise.all([tabsApi.list(pid), portfolioApi.stocks(pid)]);
    if (!still(pid)) return true;
    setTabs(nextTabs);
    setStocks(nextStocks);
    return true;
  }, []);

  const deleteStock = useCallback(async (ticker: string, question: string) => {
    if (!confirmDestructive(question)) return false;
    const pid = pinned();
    await portfolioApi.deleteStock(pid, ticker);
    const [nextStocks, nextTransactions] = await Promise.all([portfolioApi.stocks(pid), portfolioApi.transactions(pid)]);
    if (!still(pid)) return true;
    setStocks(nextStocks);
    setTransactions(nextTransactions);
    void reloadTabs(pid);
    setPrices((current) => {
      const { [ticker]: _removed, ...rest } = current;
      return rest;
    });
    return true;
  }, [reloadTabs]);

  const classifyStock = useCallback(async (ticker: string, changes: ClassificationChanges) => {
    const pid = pinned();
    const updated = await portfolioApi.classifyStock(pid, ticker, changes);
    if (still(pid)) setStocks((cur) => cur.map((s) => (s.ticker === ticker ? { ...s, ...updated } : s)));
  }, []);

  /** Overwrites the classification of every asset of the tab: asks first (see lib/confirm.ts). */
  const classifyTab = useCallback(async (tabId: number, changes: ClassificationChanges, question: string) => {
    if (!confirmDestructive(question)) return false;
    const pid = pinned();
    await tabsApi.classify(pid, tabId, changes);
    const next = await portfolioApi.stocks(pid);
    if (still(pid)) setStocks(next);
    return true;
  }, []);

  const addTransaction = useCallback(async (tx: Omit<Transaction, "id" | "sort_order" | "fx">) => {
    const pid = pinned();
    await portfolioApi.addTransaction(pid, tx);
    const next = await portfolioApi.transactions(pid);
    if (still(pid)) setTransactions(next);
  }, []);

  const deleteTransaction = useCallback(async (id: number, question: string) => {
    if (!confirmDestructive(question)) return false;
    const pid = pinned();
    await portfolioApi.deleteTransaction(pid, id);
    const next = await portfolioApi.transactions(pid);
    if (still(pid)) setTransactions(next);
    return true;
  }, []);

  return {
    ready: portfolioId !== null && loadedKey === portfolioId,
    tabs,
    stocks,
    transactions,
    prices,
    loading,
    refreshing,
    reload,
    refreshPrices,
    addStock,
    deleteStock,
    addTab,
    updateTab,
    reorderTabs,
    deleteTab,
    addTransaction,
    deleteTransaction,
    classifyStock,
    classifyTab,
  };
}

export type PortfolioState = ReturnType<typeof usePortfolio>;
