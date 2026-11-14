import { useEffect, useState } from "react";
import { errorMessage } from "../../api/client";
import { marketApi } from "../../api/endpoints";
import { Card } from "../../components/ui";
import { formatPrice } from "../../lib/utils";
import type { StockStats } from "../../types";
import type { AssetType } from "../../../shared/assetTypes";

const compact = (value: number) =>
  new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 2 }).format(value);

function formatDate(value: string | null) {
  if (!value) return null;
  const d = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("pt-BR");
}

/** Key statistics (Finnhub): 52-week range, average volume, market cap, beta. */
export function StatsCard({
  symbol,
  currentPrice,
  assetType,
}: {
  symbol: string;
  currentPrice: number;
  assetType: AssetType;
}) {
  const crypto = assetType === "crypto";
  const [stats, setStats] = useState<StockStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setError(null);
    marketApi
      .stats(symbol)
      .then((s) => !cancelled && setStats(s))
      .catch((err) => !cancelled && setError(errorMessage(err, "Estatísticas indisponíveis agora.")));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const range52 =
    stats?.high52w != null && stats.low52w != null && stats.high52w > stats.low52w && currentPrice > 0
      ? Math.min(100, Math.max(0, ((currentPrice - stats.low52w) / (stats.high52w - stats.low52w)) * 100))
      : null;

  const unit = crypto ? "unidades" : "ações";
  const rows: Array<[string, string]> = stats
    ? [
        ["Volume médio (10 dias)", stats.avgVolume10d != null ? `${compact(stats.avgVolume10d * 1e6)} ${unit}` : "—"],
        [crypto ? "Volume médio (90 dias)" : "Volume médio (3 meses)", stats.avgVolume3m != null ? `${compact(stats.avgVolume3m * 1e6)} ${unit}` : "—"],
        ...(crypto
          ? []
          : ([
              ["Valor de mercado", stats.marketCap != null ? `US$ ${compact(stats.marketCap * 1e6)}` : "—"],
              ["Beta", stats.beta != null ? stats.beta.toFixed(2) : "—"],
            ] as Array<[string, string]>)),
      ]
    : [];

  return (
    <Card title="Estatísticas">
      {error && <p className="text-xs text-tv-text/50">{error}</p>}
      {!stats && !error && <p className="text-xs text-tv-text/40">Carregando…</p>}
      {stats && (
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-tv-text/50 mb-1">
              <span>Mínima 52 semanas</span>
              <span>Máxima 52 semanas</span>
            </div>
            <div className="flex justify-between font-mono text-sm">
              <span title={formatDate(stats.low52wDate) ?? undefined}>{stats.low52w != null ? formatPrice(stats.low52w) : "—"}</span>
              <span title={formatDate(stats.high52wDate) ?? undefined}>{stats.high52w != null ? formatPrice(stats.high52w) : "—"}</span>
            </div>
            {range52 !== null && (
              <div
                className="relative h-1.5 mt-2 rounded bg-white/10"
                role="img"
                aria-label={`Preço atual a ${range52.toFixed(0)}% do caminho entre a mínima e a máxima de 52 semanas`}
              >
                <div className="absolute -top-1 h-3.5 w-1 rounded bg-tv-accent" style={{ left: `calc(${range52}% - 2px)` }} />
              </div>
            )}
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 border-b border-white/5 pb-1">
                <dt className="text-tv-text/50">{label}</dt>
                <dd className="font-mono text-right">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[10px] text-tv-text/40">
            {crypto ? "Fonte: histórico diário da Massive (com atraso)." : "Fonte: Finnhub."}
          </p>
        </div>
      )}
    </Card>
  );
}
