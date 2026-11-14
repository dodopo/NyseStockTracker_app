import { api } from "./client";
import type { AuthUser, BackupFileData, Stock, Transaction } from "../types";

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
  deleteAccount: (password: string, confirmEmail: string) =>
    api("/api/auth/delete-account", { method: "POST", body: { password, confirmEmail } }),
};

export const portfolioApi = {
  stocks: () => api<Stock[]>("/api/stocks"),
  addStock: (stock: Stock) => api("/api/stocks", { method: "POST", body: stock }),
  deleteStock: (ticker: string) =>
    api(`/api/stocks/${encodeURIComponent(ticker)}`, { method: "DELETE" }),
  transactions: () => api<Transaction[]>("/api/transactions?order=desc"),
  addTransaction: (tx: Omit<Transaction, "id" | "sort_order">) =>
    api<{ success: boolean; id: number }>("/api/transactions", { method: "POST", body: tx }),
  deleteTransaction: (id: number) => api(`/api/transactions/${id}`, { method: "DELETE" }),
  exportBackup: () => api<BackupFileData>("/api/export"),
  importBackup: (backup: BackupFileData) =>
    api<{ success: boolean; user: AuthUser; skipped: number }>("/api/import", {
      method: "POST",
      body: backup,
    }),
};
