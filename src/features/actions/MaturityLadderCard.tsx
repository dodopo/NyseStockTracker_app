import React, { useEffect, useState } from "react";
import { errorMessage } from "../../api/client";
import { Card } from "../../components/ui";
import { cn, formatCurrency, formatPrice, formatQuantity } from "../../lib/utils";
import type { PortfolioState } from "../../hooks/usePortfolio";
import { HORIZON } from "../../../shared/classification";
import type { CurrencyCode } from "../../../shared/currencies";
import { TARGET_DAYS_MAX, maturityOf, type MaturityBucket, type Tranche, type TrancheTrade } from "../../../shared/tranches";

export const BUCKET_LABEL: Record<MaturityBucket, string> = {
  ultra_short: HORIZON.ultra_short.label,
  short: HORIZON.short.label,
  medium: HORIZON.medium.label,
  long: HORIZON.long.label,
  ultra_long: HORIZON.ultra_long.label,
  matured: "Maturada",
  none: "Não definido",
};

const br = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

/**
 * Escada de maturação: one line per open tranche (BUY not yet sold), with its
 * target date, the days left, the horizon those days fall in today, today's
 * value and the result against that purchase's own price. The average price
 * (PM) shown above stays the official one.
 */
export function MaturityLadderCard({
  tranches,
  today,
  currentPrice,
  currency,
  assetTargetDays,
  portfolio,
}: {
  tranches: Array<Tranche<TrancheTrade & { id?: number }>>;
  today: string;
  /** In the asset's currency. */
  currentPrice: number;
  currency: CurrencyCode;
  assetTargetDays: number | null;
  portfolio: PortfolioState;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!tranches.length) return null;

  return (
    <Card title="Escada de maturação">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[10px] uppercase text-tv-text/40 font-bold border-b border-tv-border">
              <th className="pb-2 pr-3">Compra</th>
              <th className="pb-2 pr-3">Qtd aberta</th>
              <th className="pb-2 pr-3">Preço</th>
              <th className="pb-2 pr-3">Prazo (dias)</th>
              <th className="pb-2 pr-3">Matura em</th>
              <th className="pb-2 pr-3">Faltam</th>
              <th className="pb-2 pr-3">Faixa hoje</th>
              <th className="pb-2 pr-3 text-right">Valor hoje</th>
              <th className="pb-2 text-right">Resultado</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {tranches.map((t) => {
              const { daysLeft, bucket } = maturityOf(t.targetDate, today);
              const price = Number(t.buy.price); // NaN when this purchase could not be converted yet
              const known = Number.isFinite(price);
              const value = t.remainingNumber * currentPrice;
              const pnl = known ? (currentPrice - price) * t.remainingNumber : 0;
              const pct = known && price > 0 ? ((currentPrice - price) / price) * 100 : 0;
              return (
                <tr key={t.buyId ?? t.buy.date} className={cn("border-b border-tv-border/40", bucket === "matured" && "bg-amber-400/10")}>
                  <td className="py-2 pr-3">{br(t.buy.date)}</td>
                  <td className="py-2 pr-3">{formatQuantity(t.remaining)}</td>
                  <td className="py-2 pr-3 text-tv-text/60">{known ? formatPrice(price, currency) : "-"}</td>
                  <td className="py-2 pr-3">
                    {t.buyId !== undefined ? (
                      <TrancheTargetInput
                        own={t.buy.target_days ?? null}
                        inherited={assetTargetDays}
                        onSave={async (days) => {
                          try {
                            await portfolio.setTrancheTarget(t.buyId!, days);
                            setError(null);
                          } catch (err) {
                            setError(errorMessage(err, "Não foi possível salvar o prazo da tranche."));
                          }
                        }}
                      />
                    ) : (
                      t.targetDays ?? "-"
                    )}
                  </td>
                  <td className="py-2 pr-3">{t.targetDate ? br(t.targetDate) : "-"}</td>
                  <td className="py-2 pr-3">
                    {daysLeft === null ? "-" : daysLeft > 0 ? `${daysLeft.toLocaleString("pt-BR")} dias` : `maturou há ${(-daysLeft).toLocaleString("pt-BR")} d`}
                  </td>
                  <td className={cn("py-2 pr-3 font-sans font-semibold", bucket === "matured" ? "text-amber-400" : "text-tv-text/80")}>
                    {BUCKET_LABEL[bucket]}
                  </td>
                  <td className="py-2 pr-3 text-right">{formatCurrency(value, currency)}</td>
                  <td className={cn("py-2 text-right", !known ? "text-tv-text/40" : pnl >= 0 ? "text-tv-up" : "text-tv-down")}>
                    {known ? (
                      <>
                        {formatCurrency(pnl, currency)}
                        <div className="text-[10px] opacity-60">{pct.toFixed(2)}%</div>
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[10px] text-tv-text/40">
        Vendas tiram das tranches mais antigas, ou das que você escolher na venda. O resultado de cada linha é contra o preço daquela compra; o preço
        médio (PM) acima continua o oficial. Prazo em branco = segue o do ativo.
      </p>
      {error && <p className="mt-2 text-xs text-tv-down">{error}</p>}
    </Card>
  );
}

function TrancheTargetInput({ own, inherited, onSave }: { own: number | null; inherited: number | null; onSave: (days: number | null) => Promise<void> }) {
  const [text, setText] = useState(own === null ? "" : String(own));
  useEffect(() => setText(own === null ? "" : String(own)), [own]);
  const commit = () => {
    const t = text.trim();
    if (t === "") return own === null ? undefined : void onSave(null);
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > TARGET_DAYS_MAX) return setText(own === null ? "" : String(own));
    if (n !== own) void onSave(n);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label="Prazo-alvo desta tranche, em dias"
      className="tv-input w-20 py-0.5 text-xs"
      placeholder={inherited === null ? "-" : String(inherited)}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}
