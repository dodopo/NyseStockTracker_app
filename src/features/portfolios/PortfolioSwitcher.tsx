import React, { useEffect, useId, useRef, useState } from "react";
import { Check, Globe, Loader2, Plus, Settings2 } from "lucide-react";
import { marketApi, portfoliosApi } from "../../api/endpoints";
import { errorMessage } from "../../api/client";
import { ColorPicker } from "../../components/ColorPicker";
import { ErrorMessage } from "../../components/ui";
import { fetchQuotes, pricesToMap } from "../../services/marketService";
import { cn, formatCurrency } from "../../lib/utils";
import { GLOBAL_VIEW, type PortfoliosState } from "../../hooks/usePortfolios";
import { assetsLeftOut, buildRows, valueByPortfolio } from "../consolidated/rows";
import { TAB_COLORS } from "../../../shared/assetTypes";
import { firstIssue, portfolioCreateSchema } from "../../../shared/schemas";
import type { Portfolio } from "../../types";

/** Up to two initials of a portfolio name ("Holding XYZ" -> "HX"). */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toLocaleUpperCase("pt-BR");
}

export function PortfolioAvatar({ portfolio, size = 32 }: { portfolio: Pick<Portfolio, "name" | "color"> | null; size?: number }) {
  return (
    <span
      className="rounded-full flex items-center justify-center font-bold text-white shrink-0"
      style={{ width: size, height: size, background: portfolio?.color ?? "#5d606b", fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {portfolio ? initials(portfolio.name) : <Globe size={size * 0.55} />}
    </span>
  );
}

/**
 * Gmail-style switcher: the active portfolio as an avatar; the menu lists the
 * active portfolios with their value, the global view, "Nova carteira" and
 * "Gerenciar carteiras".
 */
export function PortfolioSwitcher({ state, onManage }: { state: PortfoliosState; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Map<number, number> | null>(null);
  // Assets left out of the totals for lack of today's rates (never a silently smaller total).
  const [leftOut, setLeftOut] = useState(0);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Values are loaded when the menu opens (one request for all portfolios + quotes).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setValues(null);
    void (async () => {
      try {
        const g = await portfoliosApi.global();
        // Today's rates: an asset in reais, euros or francs (cash, illiquid) is summed
        // in dollars too; without them it would be left out of the portfolio's value.
        const [prices, live] = await Promise.all([
          fetchQuotes(g.stocks.map((s) => s.ticker)).then(pricesToMap),
          marketApi.fx().then((fx) => fx.rates, () => null),
        ]);
        if (cancelled) return;
        setValues(valueByPortfolio(buildRows(g.stocks, g.transactions, prices, "USD", live)));
        setLeftOut(assetsLeftOut(g.stocks, "USD", live));
      } catch {
        if (!cancelled) setValues(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (selection: number | typeof GLOBAL_VIEW) => {
    state.select(selection);
    setOpen(false);
    setCreating(false);
  };

  const label = state.isGlobal ? "Visão Global" : state.current?.name ?? "Carteira";
  const total = values ? [...values.values()].reduce((a, b) => a + b, 0) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="flex items-center gap-2 rounded-full p-0.5 sm:pr-2 hover:bg-white/5 transition-all"
        title={`Carteira: ${label}`}
      >
        <PortfolioAvatar portfolio={state.isGlobal ? null : state.current} />
        <span className="hidden sm:block text-sm font-semibold max-w-[160px] truncate">{label}</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="fixed left-3 right-3 top-[68px] sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80 rounded-lg border border-white/10 bg-tv-bg shadow-2xl z-[60] overflow-hidden"
        >
          <div className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">Carteiras</div>
          <ul className="max-h-[50vh] overflow-y-auto">
            {state.active.map((p) => (
              <li key={p.id}>
                <MenuRow
                  active={state.selection === p.id}
                  onClick={() => choose(p.id)}
                  avatar={<PortfolioAvatar portfolio={p} />}
                  title={p.name}
                  value={values ? formatCurrency(values.get(p.id) ?? 0, "USD") : null}
                />
              </li>
            ))}
            <li className="border-t border-white/5">
              <MenuRow
                active={state.isGlobal}
                onClick={() => choose(GLOBAL_VIEW)}
                avatar={<PortfolioAvatar portfolio={null} />}
                title="Visão Global"
                subtitle="Todas as carteiras somadas"
                value={total !== null ? formatCurrency(total, "USD") : null}
              />
            </li>
          </ul>

          {leftOut > 0 && (
            <p className="px-4 py-2 text-[10px] text-tv-down border-t border-white/5">
              Sem o câmbio de hoje: {leftOut === 1 ? "1 ativo em real, euro ou franco ficou" : `${leftOut} ativos em real, euro ou franco ficaram`} fora dos
              totais.
            </p>
          )}

          <div className="border-t border-white/10 p-2 space-y-1">
            {creating ? (
              <NewPortfolioForm
                onCancel={() => setCreating(false)}
                onCreate={async (p) => {
                  await state.create(p);
                  setOpen(false);
                  setCreating(false);
                }}
              />
            ) : (
              <button type="button" role="menuitem" onClick={() => setCreating(true)} className="w-full flex items-center gap-3 px-3 py-2 rounded text-sm hover:bg-white/5">
                <Plus size={16} className="text-tv-accent" /> Nova carteira
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="w-full flex items-center gap-3 px-3 py-2 rounded text-sm hover:bg-white/5"
            >
              <Settings2 size={16} className="text-tv-text/60" /> Gerenciar carteiras
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuRow({
  active,
  onClick,
  avatar,
  title,
  subtitle,
  value,
}: {
  active: boolean;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle?: string;
  value: string | null;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-all", active && "bg-tv-accent/10")}
    >
      {avatar}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold truncate">{title}</span>
        {subtitle && <span className="block text-[10px] text-tv-text/40">{subtitle}</span>}
      </span>
      <span className="text-xs font-mono text-tv-text/60">{value ?? <Loader2 size={12} className="animate-spin" />}</span>
      {active && <Check size={14} className="text-tv-accent" />}
    </button>
  );
}

export function NewPortfolioForm({
  onCreate,
  onCancel,
}: {
  onCreate: (p: { name: string; color: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TAB_COLORS[1]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = portfolioCreateSchema.safeParse({ name, color });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(check.data);
      setName("");
    } catch (err) {
      setError(errorMessage(err, "Não foi possível criar a carteira."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 p-2">
      <label htmlFor={nameId} className="text-xs font-semibold text-tv-text/70">
        Nome da nova carteira
      </label>
      <input
        id={nameId}
        autoFocus
        className="tv-input w-full"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        placeholder="ex: Holding, PF, Offshore"
      />
      <ColorPicker value={color} onChange={setColor} label="Cor da nova carteira" />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2 text-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Criar
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-sm text-tv-text/60 hover:bg-white/5">
            Cancelar
          </button>
        )}
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}
