import { useCallback, useEffect, useRef, useState } from "react";
import { portfoliosApi } from "../api/endpoints";
import { fetchQuotes, pricesToMap, type StockPrice } from "../services/marketService";
import type { GlobalData } from "../types";

const EMPTY: GlobalData = { portfolios: [], tabs: [], stocks: [], transactions: [] };

/**
 * Every active portfolio at once, with quotes for each distinct ticker.
 * `key` is any value that changes when the data should be loaded again
 * (null = not loaded).
 */
export function useGlobalPortfolio(key: string | number | null) {
  const [data, setData] = useState<GlobalData>(EMPTY);
  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [loadedKey, setLoadedKey] = useState<string | number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  const loadPrices = useCallback(async (tickers: string[]) => {
    const unique = [...new Set(tickers)];
    return unique.length ? pricesToMap(await fetchQuotes(unique)) : {};
  }, []);

  const reload = useCallback(async () => {
    const wanted = keyRef.current;
    if (wanted === null) return;
    try {
      const next = await portfoliosApi.global();
      const nextPrices = await loadPrices(next.stocks.map((s) => s.ticker));
      if (keyRef.current !== wanted) return; // switched away meanwhile
      setData(next);
      setPrices(nextPrices);
    } catch (error) {
      console.error("global load error:", error);
    } finally {
      if (keyRef.current === wanted) setLoadedKey(wanted);
    }
  }, [loadPrices]);

  useEffect(() => {
    setLoadedKey(null);
    if (key === null) {
      setData(EMPTY);
      setPrices({});
      return;
    }
    void reload();
  }, [key, reload]);

  const refreshPrices = useCallback(async () => {
    setRefreshing(true);
    try {
      setPrices(await loadPrices(data.stocks.map((s) => s.ticker)));
    } finally {
      setRefreshing(false);
    }
  }, [data.stocks, loadPrices]);

  return { ...data, prices, ready: key !== null && loadedKey === key, refreshing, reload, refreshPrices };
}

export type GlobalPortfolioState = ReturnType<typeof useGlobalPortfolio>;
