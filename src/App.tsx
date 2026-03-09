import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  History,
  Plus,
  Search,
  Trash2,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  RefreshCw,
  LogOut,
  KeyRound,
  ExternalLink,
  Upload,
  Download,
  Settings,
  X,
  Mail,
  Lock,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { format } from "date-fns";
import { cn, formatCurrency, formatPercent } from "./lib/utils";
import type { Stock, Transaction, TransactionType, PortfolioItem, ConsolidationMode } from "./types";
import { fetchQuotes, pricesToMap, searchStock, StockPrice } from "./services/marketService";

declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

type AuthUser = {
  id: number;
  email: string;
  displayName: string | null;
  hasPassword: boolean;
  hasFinnhubKey: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type BackupFileData = {
  app?: string;
  version?: number;
  exportedAt?: string;
  user?: {
    id?: number;
    email?: string;
    display_name?: string | null;
    finnhub_key?: string | null;
    created_at?: string;
    updated_at?: string;
    last_login_at?: string | null;
  };
  settings?: {
    id?: number;
    user_id?: number;
    default_port?: number;
    theme?: string;
    currency?: string;
    include_secrets_in_backup?: number;
    created_at?: string;
    updated_at?: string;
  };
  stocks?: Array<{
    id?: number;
    user_id?: number;
    ticker?: string;
    name?: string;
    created_at?: string;
  }>;
  transactions?: Array<{
    id?: number;
    user_id?: number;
    ticker?: string;
    type?: string;
    shares?: number;
    price?: number;
    date?: string;
    created_at?: string;
    sort_order?: number;
  }>;
};

// -----------------------------
// UI building blocks
// -----------------------------
const TabButton = ({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: any;
  label: string;
}) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-4 py-3 border-b-2 transition-all",
      active
        ? "border-tv-accent text-tv-accent bg-tv-accent/5"
        : "border-transparent text-tv-text/60 hover:text-tv-text hover:bg-white/5"
    )}
  >
    <Icon size={18} />
    <span className="font-medium">{label}</span>
  </button>
);

const Card = ({
  title,
  children,
  className,
  extra,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  extra?: React.ReactNode;
}) => (
  <div className={cn("tv-card p-4", className)}>
    {(title || extra) && (
      <div className="flex justify-between items-center mb-4">
        {title && (
          <h3 className="text-sm font-semibold uppercase tracking-wider text-tv-text/50">
            {title}
          </h3>
        )}
        {extra}
      </div>
    )}
    {children}
  </div>
);

// -----------------------------
// PM calc (padrão corretora)
// -----------------------------
function calculatePMPosition(transactions: Transaction[], currentPrice: number) {
  const txs = [...transactions].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;

    const aSort = a.sort_order ?? a.id ?? 0;
    const bSort = b.sort_order ?? b.id ?? 0;
    if (aSort !== bSort) return aSort - bSort;

    return (a.id || 0) - (b.id || 0);
  });

  let shares = 0;
  let openCost = 0;
  let realizedPnL = 0;

  for (const t of txs) {
    const qty = Number(t.shares);
    const px = Number(t.price);

    if (t.type === "BUY") {
      shares += qty;
      openCost += qty * px;
    } else {
      if (qty > shares) {
        continue;
      }

      const avgCost = shares > 0 ? openCost / shares : 0;
      realizedPnL += (px - avgCost) * qty;

      shares -= qty;
      openCost -= avgCost * qty;
    }
  }

  const avgCost = shares > 0 ? openCost / shares : 0;
  const marketValue = shares * currentPrice;
  const unrealizedPnL = shares * (currentPrice - avgCost);

  const unrealizedPnLPct = openCost > 0 ? (unrealizedPnL / openCost) * 100 : 0;
  const totalPnL = realizedPnL + unrealizedPnL;
  const totalPnLPct = openCost > 0 ? (totalPnL / openCost) * 100 : 0;

  return {
    shares,
    avgCost,
    openCost,
    marketValue,
    realizedPnL,
    unrealizedPnL,
    unrealizedPnLPct,
    totalPnL,
    totalPnLPct,
  };
}

// -----------------------------
// Main App
// -----------------------------
export default function App() {
  const [activeTab, setActiveTab] = useState<"acoes" | "consolidado">("consolidado");

  const [stocks, setStocks] = useState<Stock[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [mode, setMode] = useState<ConsolidationMode>("SEPARATED");

  const [backupFileName, setBackupFileName] = useState("");
  const [backupPreview, setBackupPreview] = useState<BackupFileData | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadPrices = async (tickers: string[]) => {
    if (!tickers.length) return;
    const arr = await fetchQuotes(tickers);
    setPrices(pricesToMap(arr));
  };

  const fetchData = async () => {
    try {
      const [stocksRes, transRes] = await Promise.all([
        fetch("/api/stocks"),
        fetch("/api/transactions?order=desc"),
      ]);

      const stocksData = await stocksRes.json();
      const transData = await transRes.json();

      setStocks(stocksData);
      setTransactions(transData);

      await loadPrices(stocksData.map((s: Stock) => s.ticker));
    } catch (e) {
      console.error("fetchData error:", e);
    } finally {
      setLoading(false);
    }
  };

  const bootstrapAuth = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();

      if (data?.authenticated && data?.user) {
        setCurrentUser(data.user);

        if (data.user.hasFinnhubKey) {
          await fetchData();
        } else {
          setStocks([]);
          setTransactions([]);
          setPrices({});
          setSelectedStock(null);
          setLoading(false);
        }
      } else {
        setCurrentUser(null);
        setLoading(false);
      }
    } catch (e) {
      console.error("bootstrapAuth error:", e);
      setCurrentUser(null);
      setLoading(false);
    }
  };

  useEffect(() => {
    bootstrapAuth();
  }, []);

  useEffect(() => {
    if (!selectedStock && stocks[0]?.ticker) {
      setSelectedStock(stocks[0].ticker);
      return;
    }

    if (selectedStock && !stocks.some((s) => s.ticker === selectedStock)) {
      setSelectedStock(stocks[0]?.ticker || null);
    }
  }, [stocks, selectedStock]);

  const refreshPrices = async () => {
    if (!stocks.length) return;
    setRefreshing(true);
    try {
      await loadPrices(stocks.map((s) => s.ticker));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAuthSuccess = async (user: AuthUser) => {
    setCurrentUser(user);
    setStocks([]);
    setTransactions([]);
    setPrices({});
    setSelectedStock(null);

    if (user.hasFinnhubKey) {
      setLoading(true);
      await fetchData();
    } else {
      setLoading(false);
    }
  };

  const handleFinnhubKeySaved = async (user: AuthUser) => {
    setCurrentUser(user);
    setStocks([]);
    setTransactions([]);
    setPrices({});
    setSelectedStock(null);
    setLoading(true);
    await fetchData();
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.error("logout error:", e);
    } finally {
      setCurrentUser(null);
      setStocks([]);
      setTransactions([]);
      setPrices({});
      setSelectedStock(null);
      setBackupFileName("");
      setBackupPreview(null);
      setSettingsOpen(false);
      setLoading(false);
    }
  };

  // -----------------------------
  // AUTH SCREEN
  // -----------------------------
  const AuthScreen = () => {
    const [mode, setMode] = useState<"login" | "register">("login");
    const [submitting, setSubmitting] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);

    const [form, setForm] = useState({
      email: "",
      displayName: "",
      password: "",
      confirmPassword: "",
    });

    const onChange = (field: keyof typeof form, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    };

    const submitRegister = async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setAuthError(null);

      try {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: form.email,
            displayName: form.displayName,
            password: form.password,
            confirmPassword: form.confirmPassword,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setAuthError(data?.error || "Falha ao criar conta");
          return;
        }

        await handleAuthSuccess(data.user);
      } catch (e) {
        setAuthError("Erro ao criar conta. Tente novamente.");
      } finally {
        setSubmitting(false);
      }
    };

    const submitLogin = async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setAuthError(null);

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: form.email,
            password: form.password,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setAuthError(data?.error || "Falha no login");
          return;
        }

        await handleAuthSuccess(data.user);
      } catch (e) {
        setAuthError("Erro ao fazer login. Tente novamente.");
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <div className="min-h-screen bg-tv-bg text-tv-text flex items-center justify-center p-6">
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-8 flex flex-col justify-center">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-tv-accent rounded flex items-center justify-center text-white">
                <TrendingUp size={26} />
              </div>
              <div>
                <h1 className="text-2xl font-bold leading-none">NYSE Tracker</h1>
                <div className="text-xs uppercase tracking-widest text-tv-text/40 font-bold mt-1">
                  Portfolio + Trades (PM)
                </div>
              </div>
            </div>

            <h2 className="text-3xl font-bold mb-4">Controle sua carteira com acesso por usuário</h2>

            <div className="space-y-3 text-tv-text/70 leading-relaxed">
              <p>Agora o app já está preparado para autenticação local com múltiplos usuários.</p>
              <p>
                Você pode criar uma conta com senha <strong>opcional</strong>, ideal para uso local
                sem complicação nesta fase inicial.
              </p>
              <p>
                Nos próximos passos, vamos adicionar onboarding da Finnhub key, isolamento de dados
                por usuário e backup/import completo.
              </p>
            </div>
          </Card>

          <Card className="p-8">
            <div className="flex gap-2 p-1 bg-white/5 rounded mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setAuthError(null);
                }}
                className={cn(
                  "flex-1 py-2 rounded text-sm font-bold transition-all",
                  mode === "login" ? "bg-tv-accent text-white" : "text-tv-text/50"
                )}
              >
                LOGIN
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("register");
                  setAuthError(null);
                }}
                className={cn(
                  "flex-1 py-2 rounded text-sm font-bold transition-all",
                  mode === "register" ? "bg-tv-accent text-white" : "text-tv-text/50"
                )}
              >
                CRIAR CONTA
              </button>
            </div>

            {mode === "login" ? (
              <form onSubmit={submitLogin} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">E-mail</label>
                  <input
                    type="email"
                    className="tv-input w-full"
                    value={form.email}
                    onChange={(e) => onChange("email", e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">Senha</label>
                  <input
                    type="password"
                    className="tv-input w-full"
                    value={form.password}
                    onChange={(e) => onChange("password", e.target.value)}
                    placeholder="Opcional se a conta foi criada sem senha"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="tv-btn w-full flex items-center justify-center gap-2"
                >
                  {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
                  Entrar
                </button>

                <div className="text-xs text-tv-text/50 leading-relaxed">
                  Se a sua conta foi criada sem senha, basta informar o e-mail para entrar.
                </div>

                {authError && (
                  <div className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                    {authError}
                  </div>
                )}
              </form>
            ) : (
              <form onSubmit={submitRegister} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">
                    Nome de exibição
                  </label>
                  <input
                    type="text"
                    className="tv-input w-full"
                    value={form.displayName}
                    onChange={(e) => onChange("displayName", e.target.value)}
                    placeholder="Opcional"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">E-mail</label>
                  <input
                    type="email"
                    className="tv-input w-full"
                    value={form.email}
                    onChange={(e) => onChange("email", e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">Senha</label>
                  <input
                    type="password"
                    className="tv-input w-full"
                    value={form.password}
                    onChange={(e) => onChange("password", e.target.value)}
                    placeholder="Opcional para uso local"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase text-tv-text/40 font-bold">
                    Confirmar senha
                  </label>
                  <input
                    type="password"
                    className="tv-input w-full"
                    value={form.confirmPassword}
                    onChange={(e) => onChange("confirmPassword", e.target.value)}
                    placeholder="Repita a senha apenas se definiu uma"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="tv-btn w-full flex items-center justify-center gap-2"
                >
                  {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
                  Criar conta
                </button>

                <div className="text-xs text-tv-text/50 leading-relaxed">
                  A senha é opcional nesta fase inicial porque o app é local. Se você deixar em
                  branco, qualquer pessoa com acesso a este computador poderá entrar nesta conta.
                </div>

                {authError && (
                  <div className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                    {authError}
                  </div>
                )}
              </form>
            )}
          </Card>
        </div>
      </div>
    );
  };

  // -----------------------------
  // BACKUP EXPORT / IMPORT
  // -----------------------------
  function sanitizeFilePart(value: string) {
    return value
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "user";
  }

  async function handleExportBackup() {
    try {
      const res = await fetch("/api/export", {
        credentials: "include",
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to export backup");
        return;
      }

      const data = await res.json();

      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now
        .toTimeString()
        .slice(0, 8)
        .replace(/:/g, "-");

      const displayPart = sanitizeFilePart(currentUser?.displayName || currentUser?.email || "user");

      a.download = `nyse-tracker-backup_${displayPart}_${date}_${time}.json`;
      a.click();

      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Backup export failed");
    }
  }

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) {
      setBackupFileName("");
      setBackupPreview(null);
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupFileData;

      const hasValidShape =
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.stocks) &&
        Array.isArray(parsed.transactions);

      if (!hasValidShape) {
        alert("Arquivo de backup inválido.");
        setBackupFileName("");
        setBackupPreview(null);
        return;
      }

      setBackupFileName(file.name);
      setBackupPreview(parsed);
    } catch (err) {
      alert("Não foi possível ler o arquivo de backup.");
      setBackupFileName("");
      setBackupPreview(null);
    }

    e.target.value = "";
  };

  const handleRestoreBackup = async () => {
    if (!backupPreview) {
      alert("Selecione um arquivo de backup primeiro.");
      return;
    }

    const confirmed = confirm(
      "Este restore substituirá completamente a carteira atual, as configurações e a Finnhub API key do usuário logado. Deseja continuar?"
    );

    if (!confirmed) return;

    setRestoringBackup(true);

    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backupPreview),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        alert(data?.error || "Falha ao restaurar backup.");
        return;
      }

      if (data?.user) {
        setCurrentUser(data.user);
      }

      setStocks([]);
      setTransactions([]);
      setPrices({});
      setSelectedStock(null);
      setLoading(true);
      setBackupFileName("");
      setBackupPreview(null);
      setSettingsOpen(false);

      await fetchData();

      alert("Backup restaurado com sucesso.");
    } catch (err) {
      alert("Falha ao restaurar backup.");
    } finally {
      setRestoringBackup(false);
    }
  };

  // -----------------------------
  // FINNHUB ONBOARDING
  // -----------------------------
  const FinnhubOnboardingScreen = () => {
    const [apiKey, setApiKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const saveFinnhubKey = async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);

      try {
        const res = await fetch("/api/auth/finnhub-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setError(data?.error || "Falha ao salvar API key");
          return;
        }

        await handleFinnhubKeySaved(data.user);
      } catch (e) {
        setError("Erro ao salvar API key. Tente novamente.");
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="min-h-screen bg-tv-bg text-tv-text flex items-center justify-center p-6">
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-8 flex flex-col justify-center">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-tv-accent rounded flex items-center justify-center text-white">
                <KeyRound size={26} />
              </div>
              <div>
                <h1 className="text-2xl font-bold leading-none">Configuração Inicial</h1>
                <div className="text-xs uppercase tracking-widest text-tv-text/40 font-bold mt-1">
                  Finnhub API Key
                </div>
              </div>
            </div>

            <h2 className="text-3xl font-bold mb-4">
              Antes de começar, você precisa configurar sua chave da Finnhub
            </h2>

            <div className="space-y-4 text-tv-text/70 leading-relaxed">
              <p>
                A Finnhub fornece os dados de mercado usados pelo app para buscar ativos e atualizar
                preços em tempo real.
              </p>

              <div className="space-y-2">
                <div className="font-semibold text-tv-text">Passo a passo:</div>
                <ol className="list-decimal pl-5 space-y-2">
                  <li>Acesse o site da Finnhub</li>
                  <li>Crie uma conta gratuita</li>
                  <li>Gere sua API key no dashboard</li>
                  <li>Cole a chave no campo ao lado</li>
                </ol>
              </div>

              <a
                href="https://finnhub.io/register"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-tv-accent hover:underline"
              >
                Ir para Finnhub <ExternalLink size={16} />
              </a>

              <div className="text-xs text-tv-text/50">
                Sua chave será salva localmente para este usuário e poderá ser incluída no backup
                futuro, como planejamos.
              </div>
            </div>
          </Card>

          <Card className="p-8">
            <form onSubmit={saveFinnhubKey} className="space-y-4">
              <div>
                <h3 className="text-xl font-bold mb-2">
                  Olá, {currentUser?.displayName || currentUser?.email}
                </h3>
                <p className="text-sm text-tv-text/60">
                  Cole sua Finnhub API key para liberar o uso do app.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase text-tv-text/40 font-bold">
                  Finnhub API Key
                </label>
                <input
                  type="text"
                  className="tv-input w-full"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Cole sua chave aqui"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={saving}
                className="tv-btn w-full flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
                Salvar e continuar
              </button>

              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-3 rounded border border-white/10 text-tv-text/60 hover:bg-white/5 transition-all"
              >
                Sair
              </button>

              {error && (
                <div className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                  {error}
                </div>
              )}
            </form>
          </Card>
        </div>
      </div>
    );
  };

  // -----------------------------
  // SETTINGS MODAL
  // -----------------------------
  const SettingsModal = () => {
    if (!settingsOpen) return null;

    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={() => setSettingsOpen(false)}
        />

        <div className="relative z-[101] w-full max-w-3xl max-h-[90vh] overflow-y-auto">
          <Card className="p-0 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-xl font-bold">Settings</h2>
                <p className="text-sm text-tv-text/50">
                  Backup, restore e futuras configurações da conta
                </p>
              </div>

              <button
                onClick={() => setSettingsOpen(false)}
                className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60"
                title="Fechar"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <Card title="Backup">
                <div className="space-y-3">
                  <p className="text-sm text-tv-text/60">
                    Baixe um arquivo JSON com configurações, Finnhub API key, ações e transações do
                    usuário logado.
                  </p>

                  <button onClick={handleExportBackup} className="tv-btn flex items-center gap-2">
                    <Download size={16} />
                    Baixar Backup
                  </button>
                </div>
              </Card>

              <Card title="Restore">
                <div className="space-y-4">
                  <p className="text-sm text-tv-text/60">
                    Restaure um backup existente. Esta ação substituirá completamente os dados atuais
                    do usuário logado.
                  </p>

                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded border border-white/10 text-sm text-tv-text/70 hover:bg-white/5 transition-all cursor-pointer">
                    <Upload size={16} />
                    Selecionar arquivo
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleBackupFileSelected}
                    />
                  </label>

                  {backupFileName && (
                    <div className="text-xs text-tv-text/50">
                      Arquivo selecionado: <span className="text-tv-text">{backupFileName}</span>
                    </div>
                  )}

                  {backupPreview && (
                    <div className="rounded border border-yellow-500/30 bg-yellow-500/10 p-3 space-y-2 text-sm">
                      <div className="font-semibold text-yellow-300">Preview do backup</div>
                      <div className="text-tv-text/80">
                        Usuário do backup:{" "}
                        {backupPreview.user?.display_name || backupPreview.user?.email || "N/A"}
                      </div>
                      <div className="text-tv-text/80">
                        Exportado em: {backupPreview.exportedAt || "N/A"}
                      </div>
                      <div className="text-tv-text/80">
                        Ações: {backupPreview.stocks?.length || 0}
                      </div>
                      <div className="text-tv-text/80">
                        Transações: {backupPreview.transactions?.length || 0}
                      </div>
                      <div className="text-tv-text/80">
                        Finnhub key incluída: {backupPreview.user?.finnhub_key ? "Sim" : "Não"}
                      </div>

                      <div className="text-xs text-yellow-200 mt-2">
                        Atenção: o restore substitui completamente a carteira e configurações atuais.
                      </div>

                      <button
                        onClick={handleRestoreBackup}
                        disabled={restoringBackup}
                        className="tv-btn flex items-center gap-2 mt-2"
                      >
                        {restoringBackup ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Upload size={16} />
                        )}
                        Restaurar Backup
                      </button>
                    </div>
                  )}
                </div>
              </Card>

              <Card title="Conta">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <button
                    type="button"
                    className="flex items-center gap-2 px-3 py-3 rounded border border-white/10 text-sm text-tv-text/50 bg-white/5 cursor-not-allowed"
                    disabled
                    title="Será implementado em etapa futura"
                  >
                    <Lock size={16} />
                    Trocar senha
                  </button>

                  <button
                    type="button"
                    className="flex items-center gap-2 px-3 py-3 rounded border border-white/10 text-sm text-tv-text/50 bg-white/5 cursor-not-allowed"
                    disabled
                    title="Será implementado em etapa futura"
                  >
                    <Mail size={16} />
                    Trocar e-mail
                  </button>

                  <button
                    type="button"
                    className="flex items-center gap-2 px-3 py-3 rounded border border-white/10 text-sm text-tv-text/50 bg-white/5 cursor-not-allowed"
                    disabled
                    title="Será implementado em etapa futura"
                  >
                    <KeyRound size={16} />
                    Trocar API key
                  </button>
                </div>

                <div className="mt-3 text-xs text-tv-text/40">
                  Esta área foi preparada para futuras configurações da conta.
                </div>
              </Card>
            </div>
          </Card>
        </div>
      </div>
    );
  };

  // -----------------------------
  // AÇÕES
  // -----------------------------
  const ActionsDashboard = () => {
    const [searchQuery, setSearchQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [newStock, setNewStock] = useState<Stock | null>(null);
    const [searchMessage, setSearchMessage] = useState<string | null>(null);

    const [transForm, setTransForm] = useState<{
      type: TransactionType;
      shares: string;
      price: string;
      date: string;
    }>({
      type: "BUY",
      shares: "",
      price: "",
      date: format(new Date(), "yyyy-MM-dd"),
    });

    const [apiError, setApiError] = useState<string | null>(null);

    const handleSearch = async () => {
      const query = searchQuery.trim();
      if (!query) return;

      setSearching(true);
      setApiError(null);
      setSearchMessage(null);
      setNewStock(null);

      try {
        const result = await searchStock(query);

        if (!result) {
          setSearchMessage(`Nenhum ativo encontrado para "${query}".`);
          return;
        }

        setNewStock(result);
      } catch (e) {
        setSearchMessage("Erro ao buscar ativo. Tente novamente.");
      } finally {
        setSearching(false);
      }
    };

    const addStock = async () => {
      if (!newStock) return;

      const res = await fetch("/api/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newStock),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setApiError(err?.error || "Erro ao adicionar ação");
        return;
      }

      const updated = await (await fetch("/api/stocks")).json();
      setStocks(updated);
      setNewStock(null);
      setSearchQuery("");
      setSearchMessage(null);
      setSelectedStock(newStock.ticker);
      await loadPrices(updated.map((s: Stock) => s.ticker));
    };

    const deleteStock = async (ticker: string) => {
      if (!confirm(`Delete ${ticker} e todas as transações?`)) return;
      await fetch(`/api/stocks/${ticker}`, { method: "DELETE" });

      const updatedStocks = await (await fetch("/api/stocks")).json();
      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();

      setStocks(updatedStocks);
      setTransactions(updatedTrans);

      if (selectedStock === ticker) setSelectedStock(updatedStocks[0]?.ticker || null);
    };

    const addTransaction = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedStock) return;

      setApiError(null);

      const payload = {
        ticker: selectedStock,
        type: transForm.type,
        shares: Number(transForm.shares),
        price: Number(transForm.price),
        date: transForm.date,
      };

      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setApiError(err?.error || "Erro ao registrar transação");
        return;
      }

      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();
      setTransactions(updatedTrans);

      setSelectedStock(payload.ticker);
      setTransForm((s) => ({ ...s, shares: "", price: "" }));
    };

    const deleteTransaction = async (id?: number) => {
      if (!id) return;
      await fetch(`/api/transactions/${id}`, { method: "DELETE" });
      const updatedTrans = await (await fetch("/api/transactions?order=desc")).json();
      setTransactions(updatedTrans);
    };

    const currentStock = stocks.find((s) => s.ticker === selectedStock);
    const currentPrice = selectedStock ? (prices[selectedStock]?.price || 0) : 0;

    const txForSelected = useMemo(() => {
      if (!selectedStock) return [];
      return transactions.filter((t) => t.ticker === selectedStock);
    }, [transactions, selectedStock]);

    const pm = useMemo(() => {
      if (!selectedStock) return null;
      return calculatePMPosition(txForSelected, currentPrice);
    }, [txForSelected, currentPrice, selectedStock]);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card title="Adicionar Ação">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Ticker ou Nome (ex: AAPL)"
                className="tv-input flex-1"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button onClick={handleSearch} className="tv-btn px-3" disabled={searching}>
                {searching ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
              </button>
            </div>

            {searchMessage && (
              <div className="mt-3 text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded p-2">
                {searchMessage}
              </div>
            )}

            {newStock && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-3 bg-white/5 rounded border border-white/10 flex justify-between items-center"
              >
                <div>
                  <div className="font-bold text-tv-accent">{newStock.ticker}</div>
                  <div className="text-xs text-tv-text/60">{newStock.name}</div>
                </div>
                <button onClick={addStock} className="tv-btn py-1 px-3 text-sm">
                  Adicionar
                </button>
              </motion.div>
            )}

            {apiError && (
              <div className="mt-3 text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                {apiError}
              </div>
            )}
          </Card>

          <Card title="Minhas Ações">
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
              {stocks.map((stock) => (
                <div
                  key={stock.ticker}
                  onClick={() => setSelectedStock(stock.ticker)}
                  className={cn(
                    "p-3 rounded cursor-pointer transition-all flex justify-between items-center group",
                    selectedStock === stock.ticker
                      ? "bg-tv-accent/20 border border-tv-accent/50"
                      : "bg-white/5 border border-transparent hover:border-white/20"
                  )}
                >
                  <div>
                    <div className="font-bold">{stock.ticker}</div>
                    <div className="text-xs text-tv-text/60 truncate max-w-[150px]">{stock.name}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteStock(stock.ticker);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-tv-down hover:scale-110 transition-all"
                    title="Excluir ação"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {stocks.length === 0 && (
                <div className="text-center py-8 text-tv-text/40 italic">Nenhuma ação adicionada</div>
              )}
            </div>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {selectedStock ? (
            <>
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-bold">{currentStock?.ticker}</h2>
                  <p className="text-tv-text/60">{currentStock?.name}</p>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-mono">{formatCurrency(currentPrice)}</div>
                  <div
                    className={cn(
                      "text-sm font-medium flex items-center justify-end gap-1",
                      (prices[selectedStock]?.change || 0) >= 0 ? "text-tv-up" : "text-tv-down"
                    )}
                  >
                    {(prices[selectedStock]?.change || 0) >= 0 ? (
                      <ArrowUpRight size={14} />
                    ) : (
                      <ArrowDownRight size={14} />
                    )}
                    {formatPercent(prices[selectedStock]?.changePercent || 0)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <Card title="Posição (Qtd)">
                  <div className="text-2xl font-bold font-mono">{pm ? pm.shares : 0}</div>
                </Card>
                <Card title="Preço Médio (PM)">
                  <div className="text-2xl font-bold font-mono">{formatCurrency(pm?.avgCost || 0)}</div>
                </Card>
                <Card title="Investido (Aberto)">
                  <div className="text-2xl font-bold font-mono">{formatCurrency(pm?.openCost || 0)}</div>
                </Card>
                <Card title="P/L Não Realizado">
                  <div
                    className={cn(
                      "text-2xl font-bold font-mono",
                      (pm?.unrealizedPnL || 0) >= 0 ? "text-tv-up" : "text-tv-down"
                    )}
                  >
                    {formatCurrency(pm?.unrealizedPnL || 0)}
                  </div>
                  <div className="text-xs text-tv-text/40">{(pm?.unrealizedPnLPct || 0).toFixed(2)}%</div>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card title="Nova Transação">
                  <form onSubmit={addTransaction} className="space-y-4">
                    <div className="flex gap-2 p-1 bg-white/5 rounded">
                      <button
                        type="button"
                        onClick={() => setTransForm((s) => ({ ...s, type: "BUY" }))}
                        className={cn(
                          "flex-1 py-1 rounded text-sm font-bold transition-all",
                          transForm.type === "BUY" ? "bg-tv-up text-white" : "text-tv-text/40"
                        )}
                      >
                        COMPRA
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransForm((s) => ({ ...s, type: "SELL" }))}
                        className={cn(
                          "flex-1 py-1 rounded text-sm font-bold transition-all",
                          transForm.type === "SELL" ? "bg-tv-down text-white" : "text-tv-text/40"
                        )}
                      >
                        VENDA
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase text-tv-text/40 font-bold">Quantidade</label>
                        <input
                          type="number"
                          step="any"
                          className="tv-input w-full"
                          value={transForm.shares}
                          onChange={(e) => setTransForm((s) => ({ ...s, shares: e.target.value }))}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase text-tv-text/40 font-bold">Preço ($)</label>
                        <input
                          type="number"
                          step="any"
                          className="tv-input w-full"
                          value={transForm.price}
                          onChange={(e) => setTransForm((s) => ({ ...s, price: e.target.value }))}
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] uppercase text-tv-text/40 font-bold">Data</label>
                      <input
                        type="date"
                        className="tv-input w-full"
                        value={transForm.date}
                        onChange={(e) => setTransForm((s) => ({ ...s, date: e.target.value }))}
                        required
                      />
                    </div>

                    <button type="submit" className="tv-btn w-full flex items-center justify-center gap-2">
                      <Plus size={18} /> Registrar
                    </button>

                    {apiError && (
                      <div className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
                        {apiError}
                      </div>
                    )}
                  </form>
                </Card>

                <Card title="Histórico de Transações">
                  <div className="space-y-3 max-h-[340px] overflow-y-auto pr-2">
                    {txForSelected
                      .slice()
                      .sort((a, b) => {
                        const d = b.date.localeCompare(a.date);
                        if (d !== 0) return d;

                        const aSort = a.sort_order ?? a.id ?? 0;
                        const bSort = b.sort_order ?? b.id ?? 0;
                        if (aSort !== bSort) return bSort - aSort;

                        return (b.id || 0) - (a.id || 0);
                      })
                      .map((t) => (
                        <div
                          key={t.id}
                          className="flex justify-between items-center p-2 bg-white/5 rounded border border-white/5"
                        >
                          <div>
                            <div
                              className={cn(
                                "text-xs font-bold",
                                t.type === "BUY" ? "text-tv-up" : "text-tv-down"
                              )}
                            >
                              {t.type === "BUY" ? "COMPRA" : "VENDA"}
                            </div>
                            <div className="text-sm font-mono">
                              {t.shares} un @ {formatCurrency(t.price)}
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-xs text-tv-text/40">{t.date}</div>
                            <button
                              onClick={() => deleteTransaction(t.id)}
                              className="text-tv-text/20 hover:text-tv-down transition-colors"
                              title="Excluir transação"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}

                    {txForSelected.length === 0 && (
                      <div className="text-center py-10 text-tv-text/40 italic">Nenhuma transação</div>
                    )}
                  </div>
                </Card>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-tv-text/20 space-y-4">
              <History size={64} />
              <p className="text-xl font-medium">Selecione uma ação para ver detalhes</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // -----------------------------
  // CONSOLIDADO
  // -----------------------------
  const consolidated: PortfolioItem[] = useMemo(() => {
    return stocks.map((s) => {
      const txs = transactions.filter((t) => t.ticker === s.ticker);
      const currentPrice = prices[s.ticker]?.price || 0;

      const pm = calculatePMPosition(txs, currentPrice);

      return {
        ticker: s.ticker,
        name: s.name,
        shares: pm.shares,
        avgCost: pm.avgCost,
        totalInvested: pm.openCost,
        currentPrice,
        marketValue: pm.marketValue,
        unrealizedPnL: pm.unrealizedPnL,
        realizedPnL: pm.realizedPnL,
        totalPnL: pm.totalPnL,
        totalPnLPct: pm.totalPnLPct,
      };
    });
  }, [stocks, transactions, prices]);

  const totals = useMemo(() => {
    return consolidated.reduce(
      (acc, it) => {
        acc.invested += it.totalInvested;
        acc.market += it.marketValue;
        acc.realized += it.realizedPnL;
        acc.unrealized += it.unrealizedPnL;
        acc.total += it.totalPnL;
        return acc;
      },
      { invested: 0, market: 0, realized: 0, unrealized: 0, total: 0 }
    );
  }, [consolidated]);

  const ConsolidatedDashboard = () => {
    const totalPct = totals.invested > 0 ? (totals.total / totals.invested) * 100 : 0;

    const modeToggle = (
      <div className="flex items-center gap-3">
        <span className={cn("text-xs transition-opacity", mode === "UNIFIED" ? "opacity-100" : "opacity-50")}>
          Unificado
        </span>

        <button
          type="button"
          role="switch"
          aria-checked={mode === "SEPARATED"}
          onClick={() => setMode((m) => (m === "UNIFIED" ? "SEPARATED" : "UNIFIED"))}
          className={cn(
            "relative inline-flex h-7 w-14 items-center rounded-full border transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-tv-accent/40",
            "bg-white/5 border-white/20"
          )}
          title="Alternar visualização"
        >
          <span
            className={cn(
              "inline-block h-6 w-6 transform rounded-full transition-transform bg-tv-text/90",
              mode === "SEPARATED" ? "translate-x-7" : "translate-x-1"
            )}
          />
        </button>

        <span className={cn("text-xs transition-opacity", mode === "SEPARATED" ? "opacity-100" : "opacity-50")}>
          Separado
        </span>
      </div>
    );

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <Card className="bg-tv-accent/10 border-tv-accent/30">
            <div className="text-[10px] uppercase text-tv-accent font-bold mb-1">Patrimônio (Aberto)</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(totals.market)}</div>
          </Card>

          <Card>
            <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Investido (Aberto)</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(totals.invested)}</div>
          </Card>

          <Card>
            <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">P/L Total</div>
            <div className={cn("text-2xl font-bold font-mono", totals.total >= 0 ? "text-tv-up" : "text-tv-down")}>
              {formatCurrency(totals.total)}
            </div>
            <div className={cn("text-xs", totalPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
              {totalPct.toFixed(2)}%
            </div>
          </Card>

          <Card extra={modeToggle}>
            <div className="text-[10px] uppercase text-tv-text/40 font-bold mb-1">Detalhes</div>
            {mode === "SEPARATED" ? (
              <div className="space-y-1">
                <div className="text-xs text-tv-text/50">Realizado</div>
                <div className={cn("text-lg font-bold font-mono", totals.realized >= 0 ? "text-tv-up" : "text-tv-down")}>
                  {formatCurrency(totals.realized)}
                </div>
                <div className="text-xs text-tv-text/50">Não Realizado</div>
                <div
                  className={cn("text-lg font-bold font-mono", totals.unrealized >= 0 ? "text-tv-up" : "text-tv-down")}
                >
                  {formatCurrency(totals.unrealized)}
                </div>
              </div>
            ) : (
              <div className="text-xs text-tv-text/60">
                Modo unificado: tabela mostra apenas um resultado (Total).
              </div>
            )}
          </Card>
        </div>

        <Card title="Consolidado da Carteira">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase text-tv-text/40 font-bold border-b border-tv-border">
                  <th className="pb-3 pl-2">Ticker</th>
                  <th className="pb-3">Preço</th>
                  <th className="pb-3">PM</th>
                  <th className="pb-3">Qtd</th>
                  <th className="pb-3">Valor</th>
                  <th className="pb-3">Investido</th>
                  {mode === "SEPARATED" ? (
                    <>
                      <th className="pb-3">P/L Real.</th>
                      <th className="pb-3">P/L Não Real.</th>
                      <th className="pb-3 pr-2 text-right">P/L Total</th>
                    </>
                  ) : (
                    <th className="pb-3 pr-2 text-right">P/L Total</th>
                  )}
                </tr>
              </thead>

              <tbody className="text-sm font-mono">
                {consolidated.map((it) => (
                  <tr key={it.ticker} className="border-b border-tv-border/50 hover:bg-white/5 transition-colors">
                    <td className="py-4 pl-2 font-bold">
                      <div>{it.ticker}</div>
                      <div className="text-[10px] text-tv-text/40 font-normal">{it.name}</div>
                    </td>

                    <td className="py-4">{formatCurrency(it.currentPrice)}</td>
                    <td className="py-4 text-tv-text/60">{formatCurrency(it.avgCost)}</td>
                    <td className="py-4">{it.shares}</td>
                    <td className="py-4 font-bold">{formatCurrency(it.marketValue)}</td>
                    <td className="py-4 text-tv-text/60">{formatCurrency(it.totalInvested)}</td>

                    {mode === "SEPARATED" ? (
                      <>
                        <td className={cn("py-4", it.realizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.realizedPnL)}
                        </td>
                        <td className={cn("py-4", it.unrealizedPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.unrealizedPnL)}
                        </td>
                        <td className="py-4 pr-2 text-right">
                          <div className={cn("font-bold", it.totalPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                            {formatCurrency(it.totalPnL)}
                          </div>
                          <div className={cn("text-[10px]", it.totalPnLPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
                            {it.totalPnLPct.toFixed(2)}%
                          </div>
                        </td>
                      </>
                    ) : (
                      <td className="py-4 pr-2 text-right">
                        <div className={cn("font-bold", it.totalPnL >= 0 ? "text-tv-up" : "text-tv-down")}>
                          {formatCurrency(it.totalPnL)}
                        </div>
                        <div className={cn("text-[10px]", it.totalPnLPct >= 0 ? "text-tv-up/60" : "text-tv-down/60")}>
                          {it.totalPnLPct.toFixed(2)}%
                        </div>
                      </td>
                    )}
                  </tr>
                ))}

                {consolidated.length === 0 && (
                  <tr>
                    <td colSpan={mode === "SEPARATED" ? 9 : 7} className="py-12 text-center text-tv-text/20 italic">
                      Adicione ações e transações para ver o consolidado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  };

  // -----------------------------
  // Render
  // -----------------------------
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-tv-bg text-tv-accent">
        <Loader2 className="animate-spin" size={48} />
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen />;
  }

  if (!currentUser.hasFinnhubKey) {
    return <FinnhubOnboardingScreen />;
  }

  return (
    <div className="min-h-screen bg-tv-bg text-tv-text flex flex-col">
      <SettingsModal />

      <header className="tv-card border-x-0 border-t-0 rounded-none px-6 py-4 flex justify-between items-center sticky top-0 z-50 backdrop-blur-md bg-tv-bg/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-tv-accent rounded flex items-center justify-center text-white">
            <TrendingUp size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-none">NYSE Tracker</h1>
            <span className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">
              Portfolio + Trades (PM)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right hidden md:block">
            <div className="text-sm font-semibold">
              {currentUser.displayName || currentUser.email}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">
              {currentUser.hasPassword ? "Conta com senha" : "Conta local sem senha"}
            </div>
          </div>

          <button
            onClick={refreshPrices}
            className={cn(
              "p-2 rounded hover:bg-white/5 transition-all text-tv-text/60",
              refreshing && "animate-spin text-tv-accent"
            )}
            title="Atualizar preços"
          >
            <RefreshCw size={20} />
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60 hover:text-tv-accent"
            title="Settings"
          >
            <Settings size={20} />
          </button>

          <button
            onClick={handleLogout}
            className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60 hover:text-tv-down"
            title="Sair"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <nav className="px-6 border-b border-tv-border flex overflow-x-auto no-scrollbar">
        <TabButton
          active={activeTab === "consolidado"}
          onClick={() => setActiveTab("consolidado")}
          icon={LayoutDashboard}
          label="CONSOLIDADO"
        />
        <TabButton
          active={activeTab === "acoes"}
          onClick={() => setActiveTab("acoes")}
          icon={History}
          label="AÇÕES"
        />
      </nav>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === "acoes" && <ActionsDashboard />}
            {activeTab === "consolidado" && <ConsolidatedDashboard />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="p-6 text-center text-[10px] text-tv-text/20 uppercase tracking-widest font-bold">
         NYSE Portfolio Tracker &copy; {new Date().getFullYear()} — v{APP_VERSION}
      </footer>
    </div>
  );
}
