import { useEffect, useState } from "react";
import { marketApi } from "../api/endpoints";
import { errorMessage } from "../api/client";
import type { LiveFx } from "../types";

export type LiveFxState = { status: "loading" } | ({ status: "ready" } & LiveFx) | { status: "error"; message: string };

/**
 * Today's exchange rates (reais per USD, EUR, CHF), refreshed every 10 minutes
 * while the screen is open. Used only for current prices and for trades whose
 * PTAX is not known yet; costs use the PTAX frozen on each trade.
 */
export function useLiveFx(enabled = true): LiveFxState {
  const [fx, setFx] = useState<LiveFxState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      marketApi
        .fx()
        .then((d) => !cancelled && setFx({ status: "ready", ...d }))
        .catch((err) => !cancelled && setFx((cur) => (cur.status === "ready" ? cur : { status: "error", message: errorMessage(err, "Não foi possível obter o câmbio.") })));
    void load();
    const timer = window.setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return fx;
}
