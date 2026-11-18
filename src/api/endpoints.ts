import { api } from "./client";
import type {
  AuthUser,
  BackupFileData,
  CandlesResponse,
  ClassificationChanges,
  GlobalData,
  IndicatorsResponse,
  LiveFx,
  NewTransaction,
  Portfolio,
  Stock,
  StockStats,
  Tab,
  Transaction,
} from "../types";
import type { FxSnapshot } from "../../shared/currencies";
import type { AssetType } from "../../shared/assetTypes";
import type { CurrencyCode } from "../../shared/currencies";
import type { Valuation } from "../../shared/manualAssets";

type UserResponse = { success: boolean; user: AuthUser };

export const authApi = {
  me: () =>
    api<{ authenticated: boolean; user: AuthUser | null; registrationEnabled: boolean }>("/api/auth/me"),
  login: (email: string, password: string) =>
    api<UserResponse>("/api/auth/login", { method: "POST", body: { email, password } }),
  register: (body: { email: string; displayName: string; password: string; confirmPassword: string }) =>
    api<UserResponse>("/api/auth/register", { method: "POST", body }),
  logout: () => api("/api/auth/logout", { method: "POST" }),
  saveFinnhubKey: (apiKey: string) =>
    api<UserResponse>("/api/auth/finnhub-key", { method: "POST", body: { apiKey } }),
  saveMassiveKey: (apiKey: string) =>
    api<UserResponse>("/api/auth/massive-key", { method: "POST", body: { apiKey } }),
  saveAlpacaKey: (keyId: string, secret: string) =>
    api<UserResponse>("/api/auth/alpaca-key", { method: "POST", body: { keyId, secret } }),
  deleteAccount: (password: string, confirmEmail: string) =>
    api("/api/auth/delete-account", { method: "POST", body: { password, confirmEmail } }),
};

export type AccountInfo = {
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  finnhubKeyHint: string | null;
  massiveKeyHint: string | null;
  alpacaKeyHint: string | null;
  activeSessions: number;
  appVersion: string;
};

export const accountApi = {
  info: () => api<AccountInfo>("/api/account"),
  changePassword: (body: { currentPassword: string; newPassword: string; confirmPassword: string }) =>
    api("/api/account/password", { method: "POST", body }),
  changeEmail: (body: { currentPassword: string; newEmail: string }) =>
    api<UserResponse>("/api/account/email", { method: "POST", body }),
  logoutAll: () => api("/api/account/logout-all", { method: "POST" }),
};

/** Scoped routes: every call names the portfolio it acts on (never an implicit "current" one). */
export const portfolioApi = {
  stocks: (portfolioId: number) => api<Stock[]>("/api/stocks", { portfolioId }),
  addStock: (portfolioId: number, stock: { ticker: string; name: string; tabId: number }) =>
    api("/api/stocks", { method: "POST", body: stock, portfolioId }),
  /** An illiquid asset or cash account (the server creates its identity). */
  addManualStock: (portfolioId: number, stock: { name: string; tabId: number; currency: CurrencyCode }) =>
    api<Stock>("/api/stocks/manual", { method: "POST", body: stock, portfolioId }),
  renameStock: (portfolioId: number, ticker: string, name: string) =>
    api<Stock>(`/api/stocks/${encodeURIComponent(ticker)}`, { method: "PATCH", body: { name }, portfolioId }),
  addValuation: (portfolioId: number, ticker: string, v: { date: string; price: string; note: string }) =>
    api<Valuation[]>(`/api/stocks/${encodeURIComponent(ticker)}/valuations`, { method: "POST", body: v, portfolioId }),
  updateValuation: (portfolioId: number, id: number, v: { date: string; price: string; note: string }) =>
    api<Valuation[]>(`/api/valuations/${id}`, { method: "PATCH", body: v, portfolioId }),
  deleteValuation: (portfolioId: number, id: number) => api(`/api/valuations/${id}`, { method: "DELETE", portfolioId }),
  deleteStock: (portfolioId: number, ticker: string) =>
    api(`/api/stocks/${encodeURIComponent(ticker)}`, { method: "DELETE", portfolioId }),
  transactions: (portfolioId: number) => api<Transaction[]>("/api/transactions?order=desc", { portfolioId }),
  addTransaction: (portfolioId: number, tx: NewTransaction) =>
    api<{ success: boolean; id: number; fx: FxSnapshot | null }>("/api/transactions", { method: "POST", body: tx, portfolioId }),
  classifyStock: (portfolioId: number, ticker: string, changes: ClassificationChanges) =>
    api<Stock>(`/api/stocks/${encodeURIComponent(ticker)}/classification`, { method: "PATCH", body: changes, portfolioId }),
  deleteTransaction: (portfolioId: number, id: number) => api(`/api/transactions/${id}`, { method: "DELETE", portfolioId }),
  /** A tranche's own target in days (null = follow the asset's thesis). */
  setTrancheTarget: (portfolioId: number, id: number, targetDays: number | null) =>
    api(`/api/transactions/${id}/target`, { method: "PATCH", body: { targetDays }, portfolioId }),
  exportBackup: () => api<BackupFileData>("/api/export"),
  importBackup: (backup: BackupFileData, confirmPassword?: string) =>
    api<{ success: boolean; user: AuthUser; skipped: number }>("/api/import", {
      method: "POST",
      body: confirmPassword ? { ...backup, confirmPassword } : backup,
    }),
};

export const marketApi = {
  candles: (symbol: string, range: string, interval = "auto", custom?: { from: string; to: string }) =>
    api<CandlesResponse>(
      `/api/candles?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}` +
        (custom ? `&from=${encodeURIComponent(custom.from)}&to=${encodeURIComponent(custom.to)}` : "")
    ),
  indicators: (symbol: string, ids: string[], from: number) =>
    api<IndicatorsResponse>(
      `/api/indicators?symbol=${encodeURIComponent(symbol)}&ma=${encodeURIComponent(ids.join(","))}&from=${Math.floor(from)}`
    ),
  fx: () => api<LiveFx>("/api/fx"),
  stats: (symbol: string) => api<StockStats>(`/api/stats?symbol=${encodeURIComponent(symbol)}`),
};

export const portfoliosApi = {
  list: () => api<Portfolio[]>("/api/portfolios"),
  create: (p: { name: string; color: string }) => api<Portfolio>("/api/portfolios", { method: "POST", body: p }),
  update: (id: number, changes: { name?: string; color?: string; archived?: boolean }) =>
    api<Portfolio>(`/api/portfolios/${id}`, { method: "PATCH", body: changes }),
  reorder: (ids: number[]) => api<Portfolio[]>("/api/portfolios/reorder", { method: "POST", body: { ids } }),
  remove: (id: number, password: string, confirmName: string) =>
    api<Portfolio[]>(`/api/portfolios/${id}/delete`, { method: "POST", body: { password, confirmName } }),
  global: () => api<GlobalData>("/api/global"),
};

export const tabsApi = {
  list: (portfolioId: number) => api<Tab[]>("/api/tabs", { portfolioId }),
  create: (portfolioId: number, tab: { name: string; assetType: AssetType; color: string }) =>
    api<Tab>("/api/tabs", { method: "POST", body: tab, portfolioId }),
  update: (portfolioId: number, id: number, changes: { name?: string; color?: string }) =>
    api<Tab>(`/api/tabs/${id}`, { method: "PATCH", body: changes, portfolioId }),
  reorder: (portfolioId: number, ids: number[]) => api<Tab[]>("/api/tabs/reorder", { method: "POST", body: { ids }, portfolioId }),
  remove: (portfolioId: number, id: number, moveTo?: number) =>
    api(`/api/tabs/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`, { method: "DELETE", portfolioId }),
  /** Same classification for every asset of the tab (overwrites each asset's own). */
  classify: (portfolioId: number, id: number, changes: ClassificationChanges) =>
    api<{ success: boolean; changed: number }>(`/api/tabs/${id}/classification`, { method: "POST", body: changes, portfolioId }),
};
