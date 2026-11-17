import React, { useCallback, useEffect, useId, useState } from "react";
import { BarChart3, CandlestickChart, CheckCircle2, Download, KeyRound, Loader2, Lock, LogOut, Mail, Trash2, Upload, X } from "lucide-react";
import { accountApi, authApi, portfolioApi, type AccountInfo } from "../../api/endpoints";
import { ApiError, errorMessage } from "../../api/client";
import { cn } from "../../lib/utils";
import {
  alpacaKeySchema,
  changeEmailSchema,
  changePasswordSchema,
  finnhubKeySchema,
  firstIssue,
  massiveKeySchema,
} from "../../../shared/schemas";
import { LIMITS, normalizeEmail } from "../../../shared/validation";
import { Card, ErrorMessage, FieldLabel, PasswordInput } from "../../components/ui";
import type { AuthUser, BackupFileData } from "../../types";
import type { PortfolioState } from "../../hooks/usePortfolio";
import { TabsCard } from "./TabsCard";

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
  portfolio,
  onClose,
  onRestored,
  onUserChanged,
  onSignedOut,
}: {
  open: boolean;
  user: AuthUser;
  portfolio: PortfolioState;
  onClose: () => void;
  onRestored: (user: AuthUser) => Promise<void>;
  /** The account data changed (e-mail, Finnhub key): refresh the session user. */
  onUserChanged: (user: AuthUser) => void;
  /** This browser is no longer signed in (account deleted or logout everywhere). */
  onSignedOut: () => void;
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
              <p className="text-sm text-tv-text/50">Abas, conta, backup e restore</p>
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
            <TabsCard portfolio={portfolio} />
            <AccountCard user={user} onUserChanged={onUserChanged} onSignedOut={onSignedOut} />
            <BackupCard user={user} />
            <RestoreCard user={user} onRestored={onRestored} onClose={onClose} />
            <DeleteAccountCard user={user} onDeleted={onSignedOut} />
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
      downloadJson(data, `dodopo-am-backup_${who}_${date}_${time}.json`);
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
  user,
  onRestored,
  onClose,
}: {
  user: AuthUser;
  onRestored: (user: AuthUser) => Promise<void>;
  onClose: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<BackupFileData | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setError(null);
    setPreview(null);
    setFileName("");
    setNeedsPassword(false);
    setConfirmPassword("");
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as BackupFileData;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.stocks) || !Array.isArray(parsed.transactions)) {
        setError("Arquivo de backup inválido.");
        return;
      }
      setFileName(file.name);
      setPreview(parsed);
      // Backup from another e-mail (e.g. before an e-mail change): the server asks for the password.
      setNeedsPassword(normalizeEmail(parsed.user?.email) !== user.email);
    } catch {
      setError("Não foi possível ler o arquivo de backup.");
    }
  };

  const restore = async () => {
    if (!preview) return;
    if (needsPassword && !confirmPassword) {
      setError("Digite a sua senha para restaurar um backup de outro e-mail.");
      return;
    }
    const confirmed = window.confirm(
      "Este restore substituirá completamente a carteira atual e as configurações do usuário logado. Deseja continuar?"
    );
    if (!confirmed) return;

    setRestoring(true);
    setError(null);
    try {
      const data = await portfolioApi.importBackup(preview, needsPassword ? confirmPassword : undefined);
      await onRestored(data.user);
      setPreview(null);
      setFileName("");
      onClose();
      const skippedNote = data.skipped ? ` (${data.skipped} item(ns) inválido(s) ignorado(s))` : "";
      window.alert(`Backup restaurado com sucesso${skippedNote}.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setNeedsPassword(true);
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
            {needsPassword && (
              <div className="space-y-2 pt-2">
                <div className="text-xs text-yellow-200">
                  Este backup é de outro e-mail ({preview.user?.email || "não informado"}). Se ele for seu, por
                  exemplo de antes de trocar o e-mail, confirme com a sua senha atual.
                </div>
                <PasswordInput
                  label="Sua senha atual"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="current-password"
                />
              </div>
            )}
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

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("pt-BR");
}

function SuccessMessage({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-tv-up bg-tv-up/10 border border-tv-up/30 rounded p-2">
      <CheckCircle2 size={14} /> {children}
    </div>
  );
}

type AccountPanel = "password" | "email" | "apikey" | "alpaca" | "massive" | null;

function AccountCard({
  user,
  onUserChanged,
  onSignedOut,
}: {
  user: AuthUser;
  onUserChanged: (user: AuthUser) => void;
  onSignedOut: () => void;
}) {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [panel, setPanel] = useState<AccountPanel>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await accountApi.info());
    } catch (err) {
      setError(errorMessage(err, "Não foi possível carregar os dados da conta."));
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo, user.email, user.updatedAt]);

  const done = (message: string) => {
    setPanel(null);
    setError(null);
    setSuccess(message);
    void loadInfo();
  };

  const toggle = (next: Exclude<AccountPanel, null>) => {
    setSuccess(null);
    setError(null);
    setPanel((current) => (current === next ? null : next));
  };

  const logoutAll = async () => {
    if (!window.confirm("Encerrar a sessão em TODOS os aparelhos, inclusive este?")) return;
    try {
      await accountApi.logoutAll();
      onSignedOut();
    } catch (err) {
      setError(errorMessage(err, "Não foi possível encerrar as sessões."));
    }
  };

  const buttons = [
    { id: "password" as const, icon: Lock, label: "Trocar senha" },
    { id: "email" as const, icon: Mail, label: "Trocar e-mail" },
    { id: "apikey" as const, icon: KeyRound, label: "Trocar API key" },
    { id: "alpaca" as const, icon: BarChart3, label: "Chave da Alpaca" },
    { id: "massive" as const, icon: CandlestickChart, label: "Chave da Massive" },
  ];

  return (
    <Card title="Conta">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mb-4">
        <InfoRow label="E-mail" value={info?.email ?? user.email} />
        <InfoRow label="Nome" value={info?.displayName || "—"} />
        <InfoRow label="Conta criada em" value={formatDateTime(info?.createdAt ?? null)} />
        <InfoRow label="Último acesso" value={formatDateTime(info?.lastLoginAt ?? null)} />
        <InfoRow label="Chave da Finnhub" value={info?.finnhubKeyHint ?? "—"} mono />
        <InfoRow label="Chave da Alpaca (ações)" value={info?.alpacaKeyHint ?? "não configurada"} mono />
        <InfoRow label="Chave da Massive (reserva)" value={info?.massiveKeyHint ?? "não configurada"} mono />
        <InfoRow label="Sessões ativas" value={info ? String(info.activeSessions) : "—"} />
        <InfoRow label="Versão do app" value={info ? `v${info.appVersion}` : "—"} mono />
      </dl>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
        {buttons.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            aria-expanded={panel === id}
            className={cn(
              "flex items-center gap-2 px-3 py-3 rounded border text-sm transition-all",
              panel === id
                ? "border-tv-accent/60 bg-tv-accent/10 text-tv-text"
                : "border-white/10 text-tv-text/80 hover:bg-white/5"
            )}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {panel && (
        <div className="mt-4 p-4 rounded border border-white/10 bg-white/[0.02]">
          {panel === "password" && <ChangePasswordForm onDone={() => done("Senha trocada. Os outros aparelhos foram desconectados.")} />}
          {panel === "email" && (
            <ChangeEmailForm
              onDone={(updated) => {
                onUserChanged(updated);
                done(`E-mail trocado para ${updated.email}. Use-o no próximo login.`);
              }}
            />
          )}
          {panel === "apikey" && (
            <ChangeApiKeyForm
              provider="finnhub"
              currentHint={info?.finnhubKeyHint ?? null}
              onDone={(updated) => {
                onUserChanged(updated);
                done("Chave da Finnhub testada e salva.");
              }}
            />
          )}
          {panel === "alpaca" && (
            <AlpacaKeyForm
              currentHint={info?.alpacaKeyHint ?? null}
              onDone={(updated) => {
                onUserChanged(updated);
                done("Chave da Alpaca testada e salva. Os gráficos de ações já usam a Alpaca.");
              }}
            />
          )}
          {panel === "massive" && (
            <ChangeApiKeyForm
              provider="massive"
              currentHint={info?.massiveKeyHint ?? null}
              onDone={(updated) => {
                onUserChanged(updated);
                done("Chave da Massive testada e salva. Os gráficos já podem ser usados.");
              }}
            />
          )}
        </div>
      )}

      <div className="mt-4 space-y-2">
        <SuccessMessage>{success}</SuccessMessage>
        <ErrorMessage>{error}</ErrorMessage>
      </div>

      <div className="mt-4 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-tv-text/50">Esqueceu o app aberto em algum lugar? Encerre todas as sessões.</p>
        <button
          type="button"
          onClick={() => void logoutAll()}
          className="flex items-center gap-2 px-3 py-2 rounded border border-white/10 text-sm text-tv-text/80 hover:bg-white/5"
        >
          <LogOut size={16} />
          Sair de todos os aparelhos
        </button>
      </div>
    </Card>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 pb-1">
      <dt className="text-tv-text/50">{label}</dt>
      <dd className={cn("text-tv-text text-right truncate", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (field: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = changePasswordSchema.safeParse(form);
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await accountApi.changePassword(form);
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Não foi possível trocar a senha."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <PasswordInput label="Senha atual" value={form.currentPassword} onChange={set("currentPassword")} autoComplete="current-password" />
      <PasswordInput
        label="Nova senha"
        value={form.newPassword}
        onChange={set("newPassword")}
        autoComplete="new-password"
        minLength={LIMITS.passwordMin}
        placeholder={`Mínimo de ${LIMITS.passwordMin} caracteres`}
      />
      <PasswordInput
        label="Confirmar nova senha"
        value={form.confirmPassword}
        onChange={set("confirmPassword")}
        autoComplete="new-password"
        minLength={LIMITS.passwordMin}
      />
      <p className="text-xs text-tv-text/50">Ao trocar, os outros aparelhos conectados serão desconectados.</p>
      <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2">
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
        Salvar nova senha
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}

function ChangeEmailForm({ onDone }: { onDone: (user: AuthUser) => void }) {
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = changeEmailSchema.safeParse({ currentPassword, newEmail });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await accountApi.changeEmail(check.data);
      onDone(data.user);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível trocar o e-mail."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <FieldLabel htmlFor={emailId}>Novo e-mail</FieldLabel>
        <input
          id={emailId}
          type="email"
          className="tv-input w-full"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </div>
      <PasswordInput label="Senha atual" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
      <p className="text-xs text-tv-text/50">
        O novo e-mail passa a ser o seu login. Backups feitos com o e-mail antigo continuam restauráveis: o app pede a
        sua senha para confirmar.
      </p>
      <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2">
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
        Salvar novo e-mail
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}

const KEY_PROVIDERS = {
  finnhub: {
    name: "Finnhub",
    purpose: "cotações e busca de ativos",
    signupUrl: "https://finnhub.io/dashboard",
    schema: finnhubKeySchema,
    save: authApi.saveFinnhubKey,
  },
  massive: {
    name: "Massive",
    purpose: "busca de criptomoedas e reserva dos gráficos (plano grátis: até o dia anterior, 2 anos, 5 consultas por minuto)",
    signupUrl: "https://massive.com/dashboard",
    schema: massiveKeySchema,
    save: authApi.saveMassiveKey,
  },
} as const;

function ChangeApiKeyForm({
  provider,
  currentHint,
  onDone,
}: {
  provider: keyof typeof KEY_PROVIDERS;
  currentHint: string | null;
  onDone: (user: AuthUser) => void;
}) {
  const cfg = KEY_PROVIDERS[provider];
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = cfg.schema.safeParse({ apiKey });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await cfg.save(check.data.apiKey);
      setApiKey("");
      onDone(data.user);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a chave."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm text-tv-text/70">
        Chave atual da {cfg.name}: <span className="font-mono text-tv-text">{currentHint ?? "nenhuma"}</span>
        <div className="text-xs text-tv-text/50 mt-1">Usada para {cfg.purpose}.</div>
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor={keyId}>Nova chave da {cfg.name}</FieldLabel>
        <input
          id={keyId}
          type="text"
          className="tv-input w-full font-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Cole a chave nova aqui"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      <p className="text-xs text-tv-text/50">
        A chave é testada na {cfg.name} antes de ser salva. Se ela não funcionar, nada muda. Pegue a chave em{" "}
        <a href={cfg.signupUrl} target="_blank" rel="noreferrer noopener" className="text-tv-accent hover:underline">
          {cfg.signupUrl.replace("https://", "")}
        </a>
        .
      </p>
      <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2">
        {saving ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
        {saving ? `Testando na ${cfg.name}...` : "Testar e salvar"}
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}

/** Alpaca has two values: the key ID and the secret. Both are tested before saving. */
function AlpacaKeyForm({ currentHint, onDone }: { currentHint: string | null; onDone: (user: AuthUser) => void }) {
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idField = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = alpacaKeySchema.safeParse({ keyId, secret });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await authApi.saveAlpacaKey(check.data.keyId, check.data.secret);
      setKeyId("");
      setSecret("");
      onDone(data.user);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a chave."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm text-tv-text/70">
        Chave atual da Alpaca: <span className="font-mono text-tv-text">{currentHint ?? "nenhuma"}</span>
        <div className="text-xs text-tv-text/50 mt-1">
          Usada para os gráficos de ações: todas as bolsas dos EUA com 15 min de atraso e histórico desde 2016 (plano grátis).
        </div>
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor={idField}>API Key ID</FieldLabel>
        <input
          id={idField}
          type="text"
          className="tv-input w-full font-mono"
          value={keyId}
          onChange={(e) => setKeyId(e.target.value)}
          placeholder="Começa com PK"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      <PasswordInput label="Secret Key" value={secret} onChange={setSecret} autoComplete="off" />
      <p className="text-xs text-tv-text/50">
        A chave é testada na Alpaca antes de ser salva; se não funcionar, nada muda. Ela fica só neste servidor e nunca vai
        para os backups. Gere em{" "}
        <a href="https://app.alpaca.markets" target="_blank" rel="noreferrer noopener" className="text-tv-accent hover:underline">
          app.alpaca.markets
        </a>{" "}
        (conta Paper Trading → API Keys → Generate New Keys).
      </p>
      <button type="submit" disabled={saving} className="tv-btn flex items-center gap-2">
        {saving ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
        {saving ? "Testando na Alpaca..." : "Testar e salvar"}
      </button>
      <ErrorMessage>{error}</ErrorMessage>
    </form>
  );
}

function DeleteAccountCard({ user, onDeleted }: { user: AuthUser; onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  const emailMatches = confirmEmail.trim().toLowerCase() === user.email;
  const hintId = useId();
  const locked = !emailMatches || !password;
  const hint = !password && !emailMatches
    ? "Preencha a sua senha e digite o seu e-mail para liberar a exclusão."
    : !password
      ? "Preencha a sua senha para liberar a exclusão."
      : "Digite o seu e-mail exatamente como cadastrado para liberar a exclusão.";

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
          disabled={deleting || locked}
          aria-describedby={locked ? hintId : undefined}
          className="flex items-center gap-2 px-4 py-2 rounded bg-tv-down text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          Excluir minha conta
        </button>
        {locked && (
          <p id={hintId} className="text-xs text-tv-text/50">
            {hint}
          </p>
        )}

        <ErrorMessage>{error}</ErrorMessage>
      </form>
    </Card>
  );
}
