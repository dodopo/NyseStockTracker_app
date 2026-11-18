import React, { useId, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel } from "../../components/ui";
import { cn, formatCurrency, formatPrice } from "../../lib/utils";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { Stock } from "../../types";
import type { CurrencyCode } from "../../../shared/currencies";
import { STALE_VALUATION_DAYS, VALUATION_NOTE_MAX, latestValuation, type Valuation } from "../../../shared/manualAssets";
import { daysBetween, localToday } from "../../../shared/tranches";
import { firstIssue, valuationSchema } from "../../../shared/schemas";

const br = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Dated valuations of an illiquid asset (price of ONE unit, in the asset's
 * currency). The latest one up to today is its value; with none, the asset is
 * valued at its average cost. Editing saves at once; deleting asks first.
 */
export function ValuationsCard({
  stock,
  currency,
  quantity,
  portfolio,
}: {
  stock: Stock;
  currency: CurrencyCode;
  /** Units held today (to show the value of the whole position). */
  quantity: number;
  portfolio: PortfolioState;
}) {
  const today = localToday();
  const valuations = stock.valuations ?? [];
  const current = latestValuation(valuations, today);
  const list = useMemo(() => [...valuations].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id), [valuations]);
  const [editing, setEditing] = useState<Valuation | null>(null);
  const [date, setDate] = useState(today);
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { date: useId(), price: useId(), note: useId() };

  const reset = () => {
    setEditing(null);
    setDate(localToday());
    setPrice("");
    setNote("");
  };

  const startEdit = (v: Valuation) => {
    setEditing(v);
    setDate(v.date);
    setPrice(v.price);
    setNote(v.note);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const check = valuationSchema.safeParse({ date, price, note });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    const v = { date: check.data.date, price: check.data.price, note: check.data.note };
    setSaving(true);
    try {
      if (editing) await portfolio.updateValuation(stock.ticker, editing.id, v);
      else await portfolio.addValuation(stock.ticker, v);
      reset();
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a avaliação."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (v: Valuation) => {
    const question = `Excluir a avaliação de ${stock.name} de ${br(v.date)}: ${formatPrice(v.price, currency)} por unidade?`;
    try {
      if (await portfolio.deleteValuation(stock.ticker, v.id, question)) {
        if (editing?.id === v.id) reset();
      }
    } catch (err) {
      setError(errorMessage(err, "Não foi possível excluir a avaliação."));
    }
  };

  const age = current ? daysBetween(current.date, today) : null;

  return (
    <Card title="Avaliações">
      <div className="mb-3 text-xs">
        {current ? (
          <span className={cn(age! > STALE_VALUATION_DAYS ? "text-amber-400" : "text-tv-text/60")}>
            Valendo: avaliação de {br(current.date)} ({age === 0 ? "hoje" : `há ${age!.toLocaleString("pt-BR")} dias`}).
            {age! > STALE_VALUATION_DAYS && ` Mais de ${STALE_VALUATION_DAYS} dias: vale registrar uma nova.`}
          </span>
        ) : (
          <span className="text-amber-400">Sem avaliação: o ativo vale pelo custo (preço médio) até a primeira.</span>
        )}
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-[9rem_10rem_1fr_auto] gap-3 items-end">
        <div className="space-y-1">
          <FieldLabel htmlFor={ids.date}>Data</FieldLabel>
          <input id={ids.date} type="date" className="tv-input w-full" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="space-y-1">
          <FieldLabel htmlFor={ids.price}>Valor por unidade ({currency})</FieldLabel>
          <input
            id={ids.price}
            type="text"
            inputMode="decimal"
            className="tv-input w-full"
            placeholder="ex: 850000"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(",", "."))}
            required
          />
        </div>
        <div className="space-y-1">
          <FieldLabel htmlFor={ids.note}>Observação</FieldLabel>
          <input
            id={ids.note}
            type="text"
            className="tv-input w-full"
            placeholder="ex: laudo, último aporte, proposta recebida"
            maxLength={VALUATION_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="tv-btn flex items-center gap-1 whitespace-nowrap">
            {saving ? <Loader2 size={16} className="animate-spin" /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
            {editing ? "Salvar" : "Registrar"}
          </button>
          {editing && (
            <button type="button" onClick={reset} className="px-3 rounded border border-white/10 hover:bg-white/5 text-sm">
              Cancelar
            </button>
          )}
        </div>
      </form>
      {quantity !== 1 && quantity > 0 && (
        <p className="mt-2 text-[10px] text-tv-text/40">
          O valor é de UMA unidade; a posição de hoje ({quantity.toLocaleString("pt-BR")} un) vale o valor vezes a quantidade.
        </p>
      )}
      <ErrorMessage>{error}</ErrorMessage>

      <ul className="mt-4 space-y-2 max-h-[300px] overflow-y-auto pr-2">
        {list.map((v) => {
          const future = v.date > today;
          return (
            <li key={v.id} className={cn("flex justify-between items-center gap-3 p-2 rounded border", v.id === current?.id ? "border-tv-accent/40 bg-tv-accent/10" : "border-white/5 bg-white/5")}>
              <div className="min-w-0">
                <div className="text-sm font-mono">
                  {br(v.date)} · {formatPrice(v.price, currency)}
                  {quantity > 0 && quantity !== 1 && <span className="text-tv-text/40"> · posição {formatCurrency(Number(v.price) * quantity, currency)}</span>}
                </div>
                {v.note && <div className="text-[11px] text-tv-text/60 truncate">{v.note}</div>}
                {future && <div className="text-[10px] text-amber-400">Data futura: só passa a valer nesse dia.</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => startEdit(v)} className="text-tv-text/40 hover:text-tv-text" title="Editar avaliação" aria-label={`Editar avaliação de ${br(v.date)}`}>
                  <Pencil size={14} />
                </button>
                <button type="button" onClick={() => void remove(v)} className="text-tv-text/20 hover:text-tv-down" title="Excluir avaliação" aria-label={`Excluir avaliação de ${br(v.date)}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
        {list.length === 0 && <li className="text-center py-6 text-tv-text/40 italic">Nenhuma avaliação</li>}
      </ul>
    </Card>
  );
}

/**
 * The valuations as a step line (the value holds until the next one), with the
 * price paid or received in each trade as a dot. Drawn by hand: no market data.
 */
export function ValuationChart({
  valuations,
  trades,
  currency,
}: {
  valuations: Valuation[];
  /** Trades with prices in the asset's currency. */
  trades: Array<{ type: "BUY" | "SELL"; price: string | number; date: string }>;
  currency: CurrencyCode;
}) {
  const today = localToday();
  const points = [...valuations].filter((v) => v.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const dots = trades.map((t) => ({ type: t.type, date: t.date, price: Number(t.price) })).filter((t) => Number.isFinite(t.price));
  if (points.length + dots.length < 2) return null;

  const W = 640;
  const H = 200;
  const PAD = { l: 8, r: 8, t: 12, b: 22 };
  const time = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const xs = [...points.map((p) => time(p.date)), ...dots.map((d) => time(d.date)), time(today)];
  const ys = [...points.map((p) => Number(p.price)), ...dots.map((d) => d.price)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y0 === y1) [y0, y1] = [y0 * 0.9, y1 * 1.1 || 1];
  const x = (t: number) => PAD.l + ((t - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);

  let path = "";
  points.forEach((p, i) => {
    const px = x(time(p.date));
    const py = y(Number(p.price));
    path += i === 0 ? `M${px},${py}` : ` H${px} V${py}`;
  });
  if (points.length) path += ` H${x(time(today))}`;

  return (
    <Card title="Histórico de avaliações">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Avaliações ao longo do tempo, com compras e vendas">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="currentColor" className="text-tv-border" />
        {path && <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-tv-accent" />}
        {points.map((p) => (
          <circle key={`v${p.id}`} cx={x(time(p.date))} cy={y(Number(p.price))} r={3} fill="currentColor" className="text-tv-accent">
            <title>{`${br(p.date)}: ${formatPrice(p.price, currency)}${p.note ? ` · ${p.note}` : ""}`}</title>
          </circle>
        ))}
        {dots.map((d, i) => (
          <circle key={`t${i}`} cx={x(time(d.date))} cy={y(d.price)} r={4} fill="currentColor" className={d.type === "BUY" ? "text-tv-up" : "text-tv-down"}>
            <title>{`${d.type === "BUY" ? "Compra" : "Venda"} em ${br(d.date)}: ${formatPrice(d.price, currency)}`}</title>
          </circle>
        ))}
        <text x={PAD.l} y={H - 6} fontSize={10} fill="currentColor" className="text-tv-text/40">
          {br(new Date(x0).toISOString().slice(0, 10))}
        </text>
        <text x={W - PAD.r} y={H - 6} fontSize={10} textAnchor="end" fill="currentColor" className="text-tv-text/40">
          hoje
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-tv-text/50">
        <span><span className="text-tv-accent">●</span> avaliação (vale até a próxima)</span>
        <span><span className="text-tv-up">●</span> compra</span>
        <span><span className="text-tv-down">●</span> venda</span>
        <span>
          faixa: {formatPrice(y0, currency)} a {formatPrice(y1, currency)}
        </span>
      </div>
    </Card>
  );
}
