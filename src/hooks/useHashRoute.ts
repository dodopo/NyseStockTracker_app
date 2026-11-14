import { useCallback, useEffect, useState } from "react";
import { TICKER_RE } from "../../shared/validation";

/**
 * Screen addressing via the URL hash, so the browser back button works and a
 * screen can be bookmarked:
 *   #/consolidado        consolidated view (default)
 *   #/acoes              assets tab
 *   #/acoes/AAPL         assets tab with AAPL selected
 */
export type Route = { tab: "consolidado" } | { tab: "acoes"; ticker: string | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "acoes") return { tab: "consolidado" };

  let ticker: string | null = null;
  if (parts[1]) {
    try {
      const candidate = decodeURIComponent(parts[1]).toUpperCase();
      ticker = TICKER_RE.test(candidate) ? candidate : null;
    } catch {
      ticker = null;
    }
  }
  return { tab: "acoes", ticker };
}

export function routePath(route: Route) {
  if (route.tab === "consolidado") return "/consolidado";
  return route.ticker ? `/acoes/${encodeURIComponent(route.ticker)}` : "/acoes";
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
