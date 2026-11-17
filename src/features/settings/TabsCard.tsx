import React, { useId, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { ApiError, errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel } from "../../components/ui";
import { ColorPicker } from "../../components/ColorPicker";
import { cn } from "../../lib/utils";
import type { PortfolioState } from "../../hooks/usePortfolio";
import type { Tab } from "../../types";
import { ASSET_TYPES, ASSET_TYPE_IDS, TAB_COLORS, type AssetType } from "../../../shared/assetTypes";
import { firstIssue, tabCreateSchema } from "../../../shared/schemas";

/** Settings → Abas: create, rename, recolor, reorder and delete the user's tabs. */
export function TabsCard({ portfolio, title }: { portfolio: PortfolioState; title?: string }) {
  const { tabs } = portfolio;
  const [error, setError] = useState<string | null>(null);

  const move = async (index: number, delta: number) => {
    const ids = tabs.map((t) => t.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await portfolio.reorderTabs(ids);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível reordenar."));
    }
  };

  return (
    <Card title={title ?? "Abas"}>
      <p className="text-sm text-tv-text/60 mb-4">
        Cada aba agrupa ativos de um tipo. Você pode ter várias abas do mesmo tipo (por exemplo, "Cripto" e
        "Bitcoin longo prazo"). O tipo não muda depois de criada.
      </p>

      <ul className="space-y-2">
        {tabs.map((tab, i) => (
          <TabRow
            key={tab.id}
            tab={tab}
            tabs={tabs}
            portfolio={portfolio}
            canMoveUp={i > 0}
            canMoveDown={i < tabs.length - 1}
            onMove={(delta) => void move(i, delta)}
            onError={setError}
          />
        ))}
      </ul>

      <div className="mt-2">
        <ErrorMessage>{error}</ErrorMessage>
      </div>

      <NewTabForm portfolio={portfolio} />
    </Card>
  );
}

function TabRow({
  tab,
  tabs,
  portfolio,
  canMoveUp,
  canMoveDown,
  onMove,
  onError,
}: {
  tab: Tab;
  tabs: Tab[];
  portfolio: PortfolioState;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState(tab.name);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState<number | "">("");
  const nameId = useId();
  const sameType = tabs.filter((t) => t.id !== tab.id && t.assetType === tab.assetType);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tab.name) {
      setName(tab.name);
      return;
    }
    try {
      await portfolio.updateTab(tab.id, { name: trimmed });
      onError(null);
    } catch (err) {
      onError(errorMessage(err, "Não foi possível renomear."));
      setName(tab.name);
    }
  };

  const remove = async () => {
    if (tab.assetCount > 0 && moveTo === "") return;
    const target = tabs.find((t) => t.id === moveTo);
    const question =
      tab.assetCount > 0
        ? `Mover ${tab.assetCount} ativo(s) para "${target?.name}" e excluir a aba "${tab.name}"? As operações são mantidas.`
        : `Excluir a aba vazia "${tab.name}"?`;
    if (!window.confirm(question)) return;
    try {
      await portfolio.deleteTab(tab.id, tab.assetCount > 0 ? Number(moveTo) : undefined);
      onError(null);
    } catch (err) {
      onError(errorMessage(err, "Não foi possível excluir a aba."));
      if (err instanceof ApiError && err.code === "TAB_NOT_EMPTY") setDeleting(true);
    }
  };

  return (
    <li className="p-3 rounded border border-white/10 bg-white/[0.02] space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-3 w-3 rounded-full shrink-0" style={{ background: tab.color }} />
        <label htmlFor={nameId} className="sr-only">
          Nome da aba
        </label>
        <input
          id={nameId}
          className="tv-input py-1 flex-1 min-w-[140px]"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <span className="text-[10px] uppercase tracking-wider text-tv-text/50 border border-white/10 rounded px-1.5 py-0.5">
          {ASSET_TYPES[tab.assetType].label}
        </span>
        <span className="text-xs text-tv-text/50">{tab.assetCount} ativo(s)</span>
        <div className="flex items-center gap-1 ml-auto">
          <button type="button" disabled={!canMoveUp} onClick={() => onMove(-1)} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30" aria-label={`Subir ${tab.name}`}>
            <ArrowUp size={14} />
          </button>
          <button type="button" disabled={!canMoveDown} onClick={() => onMove(1)} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30" aria-label={`Descer ${tab.name}`}>
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            disabled={tabs.length <= 1}
            onClick={() => (tab.assetCount > 0 ? setDeleting((d) => !d) : void remove())}
            className="p-1.5 rounded hover:bg-white/5 text-tv-down disabled:opacity-30"
            aria-label={`Excluir ${tab.name}`}
            title={tabs.length <= 1 ? "A única aba não pode ser excluída" : `Excluir ${tab.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <ColorPicker
        value={tab.color}
        label={`Cor da aba ${tab.name}`}
        onChange={(color) => void portfolio.updateTab(tab.id, { color }).catch((err) => onError(errorMessage(err, "Não foi possível trocar a cor.")))}
      />

      {deleting && tab.assetCount > 0 && (
        <div className="rounded border border-tv-down/30 bg-tv-down/5 p-3 space-y-2 text-sm">
          {sameType.length === 0 ? (
            <p className="text-tv-text/70">
              Esta aba tem {tab.assetCount} ativo(s). Para excluí-la, crie antes outra aba do tipo{" "}
              {ASSET_TYPES[tab.assetType].label} para receber os ativos, ou exclua os ativos.
            </p>
          ) : (
            <>
              <p className="text-tv-text/70">Para onde mover os {tab.assetCount} ativo(s)? As operações são mantidas.</p>
              <div className="flex flex-wrap gap-2">
                <select
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value ? Number(e.target.value) : "")}
                  className="tv-input py-1 text-sm"
                  aria-label="Aba de destino"
                >
                  <option value="">Escolha a aba…</option>
                  {sameType.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={moveTo === ""}
                  onClick={() => void remove()}
                  className="px-3 py-1 rounded bg-tv-down text-white text-sm font-semibold disabled:opacity-40"
                >
                  Mover e excluir
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function NewTabForm({ portfolio }: { portfolio: PortfolioState }) {
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("crypto");
  const [color, setColor] = useState<string>(TAB_COLORS[2]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const typeId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = tabCreateSchema.safeParse({ name, assetType, color });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await portfolio.addTab({ name: check.data.name, assetType, color });
      setName("");
    } catch (err) {
      setError(errorMessage(err, "Não foi possível criar a aba."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 pt-4 border-t border-white/10 space-y-3">
      <div className="text-sm font-semibold">Nova aba</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabel htmlFor={nameId}>Nome</FieldLabel>
          <input
            id={nameId}
            className="tv-input w-full"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Cripto"
          />
        </div>
        <div className="space-y-1">
          <FieldLabel htmlFor={typeId}>Tipo de ativo</FieldLabel>
          <select id={typeId} className="tv-input w-full" value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)}>
            {ASSET_TYPE_IDS.map((id) => (
              <option key={id} value={id}>
                {ASSET_TYPES[id].label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ColorPicker value={color} onChange={setColor} label="Cor da nova aba" />
      <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2">
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
        Criar aba
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}
