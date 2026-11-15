import { api } from "./client";
import type { AuthUser, BackupFileData, CandlesResponse, IndicatorsResponse, Stock, StockStats, Tab, Transaction } from "../types";
import type { AssetType } from "../../shared/assetTypes";

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

export const portfolioApi = {
  stocks: () => api<Stock[]>("/api/stocks"),
  addStock: (stock: { ticker: string; name: string; tabId: number }) =>
    api("/api/stocks", { method: "POST", body: stock }),
  deleteStock: (ticker: string) =>
    api(`/api/stocks/${encodeURIComponent(ticker)}`, { method: "DELETE" }),
  transactions: () => api<Transaction[]>("/api/transactions?order=desc"),
  addTransaction: (tx: Omit<Transaction, "id" | "sort_order">) =>
    api<{ success: boolean; id: number }>("/api/transactions", { method: "POST", body: tx }),
  deleteTransaction: (id: number) => api(`/api/transactions/${id}`, { method: "DELETE" }),
  exportBackup: () => api<BackupFileData>("/api/export"),
  importBackup: (backup: BackupFileData, confirmPassword?: string) =>
    api<{ success: boolean; user: AuthUser; skipped: number }>("/api/import", {
      method: "POST",
      body: confirmPassword ? { ...backup, confirmPassword } : backup,
    }),
};

export const marketApi = {
  candles: (symbol: string, range: string, interval = "auto") =>
    api<CandlesResponse>(
      `/api/candles?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`
    ),
  indicators: (symbol: string, ids: string[], from: number) =>
    api<IndicatorsResponse>(
      `/api/indicators?symbol=${encodeURIComponent(symbol)}&ma=${encodeURIComponent(ids.join(","))}&from=${Math.floor(from)}`
    ),
  stats: (symbol: string) => api<StockStats>(`/api/stats?symbol=${encodeURIComponent(symbol)}`),
};

export const tabsApi = {
  list: () => api<Tab[]>("/api/tabs"),
  create: (tab: { name: string; assetType: AssetType; color: string }) =>
    api<Tab>("/api/tabs", { method: "POST", body: tab }),
  update: (id: number, changes: { name?: string; color?: string }) =>
    api<Tab>(`/api/tabs/${id}`, { method: "PATCH", body: changes }),
  reorder: (ids: number[]) => api<Tab[]>("/api/tabs/reorder", { method: "POST", body: { ids } }),
  remove: (id: number, moveTo?: number) =>
    api(`/api/tabs/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`, { method: "DELETE" }),
};
