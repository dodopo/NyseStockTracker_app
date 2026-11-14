import React, { useEffect, useId, useState } from "react";
import { Download, KeyRound, Loader2, Lock, Mail, Trash2, Upload, X } from "lucide-react";
import { authApi, portfolioApi } from "../../api/endpoints";
import { errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel, PasswordInput } from "../../components/ui";
import type { AuthUser, BackupFileData } from "../../types";

function sanitizeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "user"
  );
}

function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function SettingsModal({
  open,
  user,
  onClose,
  onRestored,
  onAccountDeleted,
}: {
  open: boolean;
  user: AuthUser;
  onClose: () => void;
  onRestored: (user: AuthUser) => Promise<void>;
  onAccountDeleted: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        className="relative z-[101] w-full max-w-3xl max-h-[90vh] overflow-y-auto"
      >
        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <div>
              <h2 className="text-xl font-bold">Settings</h2>
              <p className="text-sm text-tv-text/50">Backup, restore e configurações da conta</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60"
              title="Fechar"
              aria-label="Fechar"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-6 space-y-6">
            <BackupCard user={user} />
            <RestoreCard onRestored={onRestored} onClose={onClose} />
            <AccountCard />
            <DeleteAccountCard user={user} onDeleted={onAccountDeleted} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function BackupCard({ user }: { user: AuthUser }) {
  const [error, setError] = useState<string | null>(null);

  const exportBackup = async () => {
    setError(null);
    try {
      const data = await portfolioApi.exportBackup();
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now.toTimeString().slice(0, 8).replace(/:/g, "-");
      const who = sanitizeFilePart(user.displayName || user.email);
      downloadJson(data, `nyse-tracker-backup_${who}_${date}_${time}.json`);
    } catch (err) {
      setError(errorMessage(err, "Falha ao exportar o backup."));
    }
  };

  return (
    <Card title="Backup">
      <div className="space-y-3">
        <p className="text-sm text-tv-text/60">
          Baixe um arquivo JSON com configurações, ações e transações do usuário logado. A chave da Finnhub
          não vai no arquivo, por segurança.
        </p>
        <button type="button" onClick={exportBackup} className="tv-btn flex items-center gap-2">
          <Download size={16} />
          Baixar Backup
        </button>
        <ErrorMessage>{error}</ErrorMessage>
      </div>
    </Card>
  );
}

function RestoreCard({
  onRestored,
  onClose,
}: {
  onRestored: (user: AuthUser) => Promise<void>;
  onClose: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<BackupFileData | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setError(null);
    setPreview(null);
    setFileName("");
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as BackupFileData;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.stocks) || !Array.isArray(parsed.transactions)) {
        setError("Arquivo de backup inválido.");
        return;
      }
      setFileName(file.name);
      setPreview(parsed);
    } catch {
      setError("Não foi possível ler o arquivo de backup.");
    }
  };

  const restore = async () => {
    if (!preview) return;
    const confirmed = window.confirm(
      "Este restore substituirá completamente a carteira atual e as configurações do usuário logado. Deseja continuar?"
    );
    if (!confirmed) return;

    setRestoring(true);
    setError(null);
    try {
      const data = await portfolioApi.importBackup(preview);
      await onRestored(data.user);
      setPreview(null);
      setFileName("");
      onClose();
      const skippedNote = data.skipped ? ` (${data.skipped} item(ns) inválido(s) ignorado(s))` : "";
      window.alert(`Backup restaurado com sucesso${skippedNote}.`);
    } catch (err) {
      setError(errorMessage(err, "Falha ao restaurar backup."));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card title="Restore">
      <div className="space-y-4">
        <p className="text-sm text-tv-text/60">
          Restaure um backup existente. Esta ação substituirá completamente os dados atuais do usuário logado.
        </p>

        <label className="inline-flex items-center gap-2 px-3 py-2 rounded border border-white/10 text-sm text-tv-text/70 hover:bg-white/5 transition-all cursor-pointer">
          <Upload size={16} />
          Selecionar arquivo
          <input type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
        </label>

        {fileName && (
          <div className="text-xs text-tv-text/50">
            Arquivo selecionado: <span className="text-tv-text">{fileName}</span>
          </div>
        )}

        {preview && (
          <div className="rounded border border-yellow-500/30 bg-yellow-500/10 p-3 space-y-2 text-sm">
            <div className="font-semibold text-yellow-300">Preview do backup</div>
            <div className="text-tv-text/80">
              Usuário do backup: {preview.user?.display_name || preview.user?.email || "N/A"}
            </div>
            <div className="text-tv-text/80">Exportado em: {preview.exportedAt || "N/A"}</div>
            <div className="text-tv-text/80">Ações: {preview.stocks?.length || 0}</div>
            <div className="text-tv-text/80">Transações: {preview.transactions?.length || 0}</div>
            <div className="text-tv-text/80">Finnhub key incluída: {preview.user?.finnhub_key ? "Sim" : "Não"}</div>
            <div className="text-xs text-yellow-200 mt-2">
              Atenção: o restore substitui completamente a carteira e configurações atuais.
            </div>
            <button type="button" onClick={restore} disabled={restoring} className="tv-btn flex items-center gap-2 mt-2">
              {restoring ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              Restaurar Backup
            </button>
          </div>
        )}

        <ErrorMessage>{error}</ErrorMessage>
      </div>
    </Card>
  );
}

function AccountCard() {
  const soon = [
    { icon: Lock, label: "Trocar senha" },
    { icon: Mail, label: "Trocar e-mail" },
    { icon: KeyRound, label: "Trocar API key" },
  ];
  return (
    <Card title="Conta">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {soon.map(({ icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            className="flex items-center gap-2 px-3 py-3 rounded border border-white/10 text-sm text-tv-text/50 bg-white/5 cursor-not-allowed"
            disabled
            title="Será implementado em etapa futura"
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 text-xs text-tv-text/40">Esta área foi preparada para futuras configurações da conta.</div>
    </Card>
  );
}

function DeleteAccountCard({ user, onDeleted }: { user: AuthUser; onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  const emailMatches = confirmEmail.trim().toLowerCase() === user.email;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailMatches || !password) return;
    if (!window.confirm("Excluir a conta apaga TODA a carteira e não pode ser desfeito. Continuar?")) return;

    setDeleting(true);
    setError(null);
    try {
      await authApi.deleteAccount(password, confirmEmail);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err, "Não foi possível excluir a conta."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card title="Zona de perigo" className="border-tv-down/40">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-tv-text/60">
          Exclui a sua conta e <strong>todas</strong> as suas ações e transações. Não há como desfazer. Se
          quiser guardar os dados, baixe um backup antes.
        </p>

        <PasswordInput label="Sua senha" value={password} onChange={setPassword} autoComplete="current-password" />

        <div className="space-y-1">
          <FieldLabel htmlFor={emailId}>Digite o seu e-mail para confirmar ({user.email})</FieldLabel>
          <input
            id={emailId}
            type="email"
            className="tv-input w-full"
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            autoComplete="off"
            required
          />
        </div>

        <button
          type="submit"
          disabled={deleting || !emailMatches || !password}
          className="flex items-center gap-2 px-4 py-2 rounded bg-tv-down text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          Excluir minha conta
        </button>

        <ErrorMessage>{error}</ErrorMessage>
      </form>
    </Card>
  );
}
