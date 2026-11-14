import { useCallback, useEffect, useState } from "react";
import { portfolioApi } from "../api/endpoints";
import { fetchQuotes, pricesToMap, type StockPrice } from "../services/marketService";
import type { Stock, Transaction } from "../types";

/**
 * Portfolio data of the logged-in user: assets, transactions and quotes.
 * `userKey` is the user id when the portfolio can be loaded, or null.
 */
export function usePortfolio(userKey: number | null) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Which user the current data belongs to; `ready` only once that user's first load finished.
  const [loadedKey, setLoadedKey] = useState<number | null>(null);

  const loadPrices = useCallback(async (tickers: string[]) => {
    if (!tickers.length) {
      setPrices({});
      return;
    }
    setPrices(pricesToMap(await fetchQuotes(tickers)));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStocks, nextTransactions] = await Promise.all([
        portfolioApi.stocks(),
        portfolioApi.transactions(),
      ]);
      setStocks(nextStocks);
      setTransactions(nextTransactions);
      await loadPrices(nextStocks.map((s) => s.ticker));
    } catch (error) {
      console.error("portfolio load error:", error);
    } finally {
      setLoading(false);
    }
  }, [loadPrices]);

  const reloadTransactions = useCallback(async () => {
    setTransactions(await portfolioApi.transactions());
  }, []);

  useEffect(() => {
    setLoadedKey(null);
    if (userKey === null) {
      setStocks([]);
      setTransactions([]);
      setPrices({});
      return;
    }
    let cancelled = false;
    void reload().then(() => {
      if (!cancelled) setLoadedKey(userKey);
    });
    return () => {
      cancelled = true;
    };
  }, [userKey, reload]);

  const refreshPrices = useCallback(async () => {
    if (!stocks.length) return;
    setRefreshing(true);
    try {
      await loadPrices(stocks.map((s) => s.ticker));
    } finally {
      setRefreshing(false);
    }
  }, [stocks, loadPrices]);

  const addStock = useCallback(
    async (stock: Stock) => {
      await portfolioApi.addStock(stock);
      const nextStocks = await portfolioApi.stocks();
      setStocks(nextStocks);
      await loadPrices(nextStocks.map((s) => s.ticker));
    },
    [loadPrices]
  );

  const deleteStock = useCallback(async (ticker: string) => {
    await portfolioApi.deleteStock(ticker);
    const [nextStocks, nextTransactions] = await Promise.all([
      portfolioApi.stocks(),
      portfolioApi.transactions(),
    ]);
    setStocks(nextStocks);
    setTransactions(nextTransactions);
    setPrices((current) => {
      const { [ticker]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const addTransaction = useCallback(
    async (tx: Omit<Transaction, "id" | "sort_order">) => {
      await portfolioApi.addTransaction(tx);
      await reloadTransactions();
    },
    [reloadTransactions]
  );

  const deleteTransaction = useCallback(
    async (id: number) => {
      await portfolioApi.deleteTransaction(id);
      await reloadTransactions();
    },
    [reloadTransactions]
  );

  return {
    ready: userKey !== null && loadedKey === userKey,
    stocks,
    transactions,
    prices,
    loading,
    refreshing,
    reload,
    refreshPrices,
    addStock,
    deleteStock,
    addTransaction,
    deleteTransaction,
  };
}

export type PortfolioState = ReturnType<typeof usePortfolio>;
