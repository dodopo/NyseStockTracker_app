import React, { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel } from "../../components/ui";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { ClassificationChanges, Stock, Tab } from "../../types";
import { assetTypeOfTicker, displaySymbol } from "../../../shared/assetTypes";
import {
  HORIZON,
  HORIZON_IDS,
  JURISDICTION,
  JURISDICTION_IDS,
  LIQUIDITY,
  LIQUIDITY_IDS,
  NOT_DEFINED,
  defaultClassification,
  horizonLabel,
  jurisdictionLabel,
  type Horizon,
  type Jurisdiction,
  type Liquidity,
} from "../../../shared/classification";
import { CURRENCY_LABEL, isCurrency } from "../../../shared/currencies";
import { TARGET_DAYS_MAX, defaultTargetDays } from "../../../shared/tranches";

const NONE = "";

/**
 * Liquidity, horizon and jurisdiction of one asset in this portfolio. Each
 * change is saved at once. "Aplicar a todos" copies this asset's three values
 * to every asset of the tab (asks first: it overwrites theirs).
 */
export function ClassificationCard({ stock, tab, portfolio }: { stock: Stock; tab: Tab | undefined; portfolio: PortfolioState }) {
  const defaults = defaultClassification(stock.asset_type ?? assetTypeOfTicker(stock.ticker));
  const liquidity: Liquidity = stock.liquidity ?? defaults.liquidity;
  const horizon: Horizon | null = stock.horizon === undefined ? defaults.horizon : stock.horizon;
  const jurisdiction: Jurisdiction | null = stock.jurisdiction === undefined ? defaults.jurisdiction : stock.jurisdiction;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { liquidity: useId(), horizon: useId(), jurisdiction: useId(), target: useId() };
  const targetDays: number | null = stock.target_days === undefined ? defaultTargetDays(horizon) : stock.target_days;
  const [targetText, setTargetText] = useState(targetDays === null ? "" : String(targetDays));
  useEffect(() => setTargetText(targetDays === null ? "" : String(targetDays)), [targetDays]);

  /** Saves the typed target (the horizon follows it); empty = no target. */
  const saveTarget = () => {
    const text = targetText.trim();
    if (text === "") return targetDays === null ? undefined : void save({ targetDays: null });
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > TARGET_DAYS_MAX) {
      setError(`Prazo-alvo: um número inteiro de 1 a ${TARGET_DAYS_MAX.toLocaleString("pt-BR")} dias.`);
      setTargetText(targetDays === null ? "" : String(targetDays));
      return;
    }
    if (n !== targetDays) void save({ targetDays: n });
  };
  const others = tab ? portfolio.stocks.filter((s) => s.tab_id === tab.id && s.ticker !== stock.ticker).length : 0;

  const save = async (changes: ClassificationChanges) => {
    setSaving(true);
    setError(null);
    try {
      await portfolio.classifyStock(stock.ticker, changes);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a classificação."));
    } finally {
      setSaving(false);
    }
  };

  const applyToTab = async () => {
    if (!tab) return;
    const question =
      `Aplicar a TODOS os ${others + 1} ativos da aba "${tab.name}" a classificação de ${displaySymbol(stock.ticker)}: ` +
      `${LIQUIDITY[liquidity]}, prazo ${horizonLabel(horizon)}${targetDays !== null ? ` (${targetDays.toLocaleString("pt-BR")} dias)` : ""}, ${jurisdictionLabel(jurisdiction)}? ` +
      `A classificação própria de cada um será substituída.`;
    setSaving(true);
    setError(null);
    try {
      await portfolio.classifyTab(tab.id, { liquidity, jurisdiction, targetDays }, question);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível aplicar à aba."));
    } finally {
      setSaving(false);
    }
  };

  const select = (
    id: string,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => void,
    allowNone: boolean
  ) => (
    <div className="space-y-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select id={id} className="tv-input w-full" value={value} disabled={saving} onChange={(e) => onChange(e.target.value)}>
        {allowNone && <option value={NONE}>{NOT_DEFINED}</option>}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Card
      title="Classificação"
      extra={saving ? <Loader2 size={14} className="animate-spin text-tv-text/40" aria-label="Salvando" /> : undefined}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {select(ids.liquidity, "Liquidez", liquidity, LIQUIDITY_IDS.map((v) => [v, LIQUIDITY[v]]), (v) => void save({ liquidity: v as Liquidity }), false)}
        {select(
          ids.horizon,
          "Prazo",
          horizon ?? NONE,
          HORIZON_IDS.map((v) => [v, `${HORIZON[v].label} (${HORIZON[v].range})`]),
          (v) => void save({ horizon: v === NONE ? null : (v as Horizon) }),
          true
        )}
        <div className="space-y-1">
          <FieldLabel htmlFor={ids.target}>Prazo-alvo (dias)</FieldLabel>
          <input
            id={ids.target}
            type="text"
            inputMode="numeric"
            className="tv-input w-full"
            placeholder="sem prazo"
            value={targetText}
            disabled={saving}
            onChange={(e) => setTargetText(e.target.value.replace(/\D/g, ""))}
            onBlur={saveTarget}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
        </div>
        {select(
          ids.jurisdiction,
          "Jurisdição",
          jurisdiction ?? NONE,
          JURISDICTION_IDS.map((v) => [v, JURISDICTION[v]]),
          (v) => void save({ jurisdiction: v === NONE ? null : (v as Jurisdiction) }),
          true
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-tv-text/50">
        <span>
          Moeda de cotação: {CURRENCY_LABEL[isCurrency(stock.currency) ? stock.currency : "USD"]}. Cada compra herda o prazo-alvo e matura em
          data + prazo (dá para mudar por tranche na escada abaixo).
        </span>
        {tab && others > 0 && (
          <button type="button" disabled={saving} onClick={() => void applyToTab()} className="underline hover:text-tv-text disabled:opacity-40">
            Aplicar a todos os ativos da aba "{tab.name}"
          </button>
        )}
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </Card>
  );
}
