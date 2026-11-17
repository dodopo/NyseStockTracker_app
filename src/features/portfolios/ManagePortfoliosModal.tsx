import React, { useEffect, useId, useState } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Loader2, Trash2, X } from "lucide-react";
import { errorMessage } from "../../api/client";
import { ColorPicker } from "../../components/ColorPicker";
import { Card, ErrorMessage, PasswordInput } from "../../components/ui";
import { cn } from "../../lib/utils";
import type { PortfoliosState } from "../../hooks/usePortfolios";
import type { Portfolio } from "../../types";
import { NewPortfolioForm, PortfolioAvatar } from "./PortfolioSwitcher";

/**
 * Gerenciar carteiras: rename, color, order, archive/unarchive and (permanent)
 * delete with password + typed name. Archived portfolios are listed last.
 */
export function ManagePortfoliosModal({ open, state, onClose }: { open: boolean; state: PortfoliosState; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const all = state.portfolios;
  const move = async (index: number, delta: number) => {
    const ids = all.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await state.reorder(ids);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível reordenar."));
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Gerenciar carteiras" className="relative z-[101] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <div>
              <h2 className="text-xl font-bold">Gerenciar carteiras</h2>
              <p className="text-sm text-tv-text/50">Cada carteira tem suas próprias abas, ativos e operações.</p>
            </div>
            <button type="button" onClick={onClose} className="p-2 rounded hover:bg-white/5 text-tv-text/60" aria-label="Fechar">
              <X size={20} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <ul className="space-y-2">
              {all.map((p, i) => (
                <PortfolioRow
                  key={p.id}
                  portfolio={p}
                  state={state}
                  canMoveUp={i > 0}
                  canMoveDown={i < all.length - 1}
                  onMove={(delta) => void move(i, delta)}
                  onError={setError}
                />
              ))}
            </ul>
            <ErrorMessage>{error}</ErrorMessage>

            <div className="pt-2 border-t border-white/10">
              <div className="text-sm font-semibold px-2 pt-2">Nova carteira</div>
              <NewPortfolioForm onCreate={async (p) => void (await state.create(p))} />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PortfolioRow({
  portfolio,
  state,
  canMoveUp,
  canMoveDown,
  onMove,
  onError,
}: {
  portfolio: Portfolio;
  state: PortfoliosState;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState(portfolio.name);
  const [deleting, setDeleting] = useState(false);
  const nameId = useId();
  const isLastActive = !portfolio.archived && state.active.length <= 1;

  useEffect(() => setName(portfolio.name), [portfolio.name]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action();
      onError(null);
    } catch (err) {
      onError(errorMessage(err, fallback));
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === portfolio.name) return setName(portfolio.name);
    await run(() => state.update(portfolio.id, { name: trimmed }), "Não foi possível renomear.");
  };

  return (
    <li className={cn("p-3 rounded border border-white/10 bg-white/[0.02] space-y-3", portfolio.archived && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-3">
        <PortfolioAvatar portfolio={portfolio} size={28} />
        <label htmlFor={nameId} className="sr-only">
          Nome da carteira
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
        {portfolio.archived && (
          <span className="text-[10px] uppercase tracking-wider text-tv-text/50 border border-white/10 rounded px-1.5 py-0.5">Arquivada</span>
        )}
        <span className="text-xs text-tv-text/50">{portfolio.assetCount} ativo(s)</span>
        <div className="flex items-center gap-1 ml-auto">
          <button type="button" disabled={!canMoveUp} onClick={() => onMove(-1)} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30" aria-label={`Subir ${portfolio.name}`}>
            <ArrowUp size={14} />
          </button>
          <button type="button" disabled={!canMoveDown} onClick={() => onMove(1)} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30" aria-label={`Descer ${portfolio.name}`}>
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            disabled={isLastActive}
            onClick={() => void run(() => state.update(portfolio.id, { archived: !portfolio.archived }), "Não foi possível arquivar.")}
            className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30"
            aria-label={portfolio.archived ? `Desarquivar ${portfolio.name}` : `Arquivar ${portfolio.name}`}
            title={isLastActive ? "A única carteira ativa não pode ser arquivada" : portfolio.archived ? "Desarquivar" : "Arquivar (nada é apagado)"}
          >
            {portfolio.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
          <button
            type="button"
            disabled={isLastActive || state.portfolios.length <= 1}
            onClick={() => setDeleting((d) => !d)}
            className="p-1.5 rounded hover:bg-white/5 text-tv-down disabled:opacity-30"
            aria-label={`Excluir ${portfolio.name}`}
            title={isLastActive ? "A única carteira ativa não pode ser excluída" : `Excluir ${portfolio.name} definitivamente`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <ColorPicker
        value={portfolio.color}
        label={`Cor da carteira ${portfolio.name}`}
        onChange={(color) => void run(() => state.update(portfolio.id, { color }), "Não foi possível trocar a cor.")}
      />

      {deleting && <DeleteForm portfolio={portfolio} state={state} onDone={() => setDeleting(false)} onError={onError} />}
    </li>
  );
}

function DeleteForm({
  portfolio,
  state,
  onDone,
  onError,
}: {
  portfolio: Portfolio;
  state: PortfoliosState;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await state.remove(portfolio.id, password, confirmName);
      onError(null);
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Não foi possível excluir a carteira."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded border border-tv-down/30 bg-tv-down/5 p-3 space-y-3 text-sm">
      <p className="text-tv-text/80">
        Excluir <strong>{portfolio.name}</strong> apaga definitivamente as abas, os {portfolio.assetCount} ativo(s) e todas as
        operações desta carteira. Se quiser só tirar da frente, prefira <strong>Arquivar</strong>.
      </p>
      <div className="space-y-1">
        <label htmlFor={nameId} className="text-xs text-tv-text/70">
          Digite o nome da carteira para confirmar: <strong>{portfolio.name}</strong>
        </label>
        <input id={nameId} className="tv-input w-full" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
      </div>
      <PasswordInput label="Sua senha" value={password} onChange={setPassword} autoComplete="current-password" />
      <button
        type="submit"
        disabled={busy || !password || confirmName.trim().toLocaleLowerCase("pt-BR") !== portfolio.name.toLocaleLowerCase("pt-BR")}
        className="px-3 py-1.5 rounded bg-tv-down text-white font-semibold disabled:opacity-40 flex items-center gap-2"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        Excluir definitivamente
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}
