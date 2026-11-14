import { useCallback, useEffect, useState } from "react";
import { TICKER_RE } from "../../shared/validation";

/**
 * Screen addressing via the URL hash, so the browser back button works and a
 * screen can be bookmarked:
 *   #/consolidado            consolidated view (default)
 *   #/aba/3                  tab 3
 *   #/aba/3/X%3ABTCUSD       tab 3 with that asset selected
 *   #/acoes/AAPL             legacy link (v0.5–v0.7): resolved to the asset's tab
 */
export type Route = { tab: "consolidado" } | { tab: "aba"; tabId: number | null; ticker: string | null };

function decodeTicker(part: string | undefined) {
  if (!part) return null;
  try {
    const candidate = decodeURIComponent(part).toUpperCase();
    return TICKER_RE.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "aba") {
    const id = Number(parts[1]);
    return { tab: "aba", tabId: Number.isSafeInteger(id) && id > 0 ? id : null, ticker: decodeTicker(parts[2]) };
  }
  if (parts[0] === "acoes") return { tab: "aba", tabId: null, ticker: decodeTicker(parts[1]) };
  return { tab: "consolidado" };
}

export function routePath(route: Route) {
  if (route.tab === "consolidado") return "/consolidado";
  if (route.tabId === null) return route.ticker ? `/acoes/${encodeURIComponent(route.ticker)}` : "/acoes";
  return route.ticker ? `/aba/${route.tabId}/${encodeURIComponent(route.ticker)}` : `/aba/${route.tabId}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  /** Goes to a route. `replace` updates the address without a new history entry. */
  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = `#${routePath(next)}`;
    if (window.location.hash === hash) return;
    if (options.replace) {
      window.history.replaceState(null, "", hash);
      setRoute(parseRoute(hash));
    } else {
      window.location.hash = hash;
    }
  }, []);

  return { route, navigate };
}
