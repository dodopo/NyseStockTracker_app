import { useCallback, useEffect, useRef, useState } from "react";
import { portfoliosApi } from "../api/endpoints";
import type { Portfolio } from "../types";

export const GLOBAL_VIEW = "global" as const;
/** The active portfolio, or the global view (every active portfolio). */
export type PortfolioSelection = number | typeof GLOBAL_VIEW;

const storageKey = (userId: number) => `dam.portfolio.${userId}`;

function readSelection(userId: number): unknown {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSelection(userId: number, selection: PortfolioSelection) {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(selection));
  } catch {
    // private window or blocked storage: the choice just is not remembered
  }
}

/** A valid selection: the wanted one if it is the global view or an active portfolio, else the first active. */
function resolve(list: Portfolio[], wanted: unknown): PortfolioSelection | null {
  const active = list.filter((p) => !p.archived);
  if (wanted === GLOBAL_VIEW) return GLOBAL_VIEW;
  if (typeof wanted === "number" && active.some((p) => p.id === wanted)) return wanted;
  return active[0]?.id ?? list[0]?.id ?? null;
}

/**
 * The user's portfolios and which one is active. The active portfolio is
 * remembered per browser (so the iPhone and the computer may differ); scoped
 * requests name it explicitly (see usePortfolio).
 */
export function usePortfolios(userId: number | null) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selection, setSelection] = useState<PortfolioSelection | null>(null);
  const selectionRef = useRef<PortfolioSelection | null>(null);

  const apply = useCallback(
    (next: PortfolioSelection | null) => {
      selectionRef.current = next;
      setSelection(next);
      if (userId !== null && next !== null) writeSelection(userId, next);
    },
    [userId]
  );

  /** Reloads the list; keeps the selection if it is still valid, else the first active portfolio. */
  const refresh = useCallback(
    async (wanted?: PortfolioSelection) => {
      const list = await portfoliosApi.list();
      setPortfolios(list);
      apply(resolve(list, wanted ?? selectionRef.current));
      return list;
    },
    [apply]
  );

  useEffect(() => {
    if (userId === null) {
      setPortfolios([]);
      apply(null);
      return;
    }
    let cancelled = false;
    void portfoliosApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setPortfolios(list);
        apply(resolve(list, readSelection(userId)));
      })
      .catch((error) => console.error("portfolios load error:", error));
    return () => {
      cancelled = true;
    };
  }, [userId, apply]);

  const create = useCallback(
    async (p: { name: string; color: string }) => {
      const created = await portfoliosApi.create(p);
      await refresh(created.id);
      return created;
    },
    [refresh]
  );

  const update = useCallback(
    async (id: number, changes: { name?: string; color?: string; archived?: boolean }) => {
      await portfoliosApi.update(id, changes);
      await refresh();
    },
    [refresh]
  );

  const reorder = useCallback(async (ids: number[]) => {
    setPortfolios(await portfoliosApi.reorder(ids));
  }, []);

  const remove = useCallback(
    async (id: number, password: string, confirmName: string) => {
      await portfoliosApi.remove(id, password, confirmName);
      await refresh();
    },
    [refresh]
  );

  const active = portfolios.filter((p) => !p.archived);
  const current = typeof selection === "number" ? portfolios.find((p) => p.id === selection) ?? null : null;

  return {
    portfolios,
    active,
    selection,
    current,
    isGlobal: selection === GLOBAL_VIEW,
    ready: userId !== null && selection !== null,
    select: apply,
    refresh,
    create,
    update,
    reorder,
    remove,
  };
}

export type PortfoliosState = ReturnType<typeof usePortfolios>;
