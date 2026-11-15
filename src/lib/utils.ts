import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type Currency = "USD" | "BRL";

/** Dollars in the app's US format ($1,234.56); reais in the Brazilian format (R$ 1.234,56). */
const LOCALE: Record<Currency, string> = { USD: "en-US", BRL: "pt-BR" };

export function formatCurrency(value: number, currency: Currency = "USD") {
  return new Intl.NumberFormat(LOCALE[currency], {
    style: "currency",
    currency,
  }).format(value);
}

/** Price with 2 decimals, or up to 8 when the value needs them (small crypto prices). */
export function formatPrice(value: number | string, currency: Currency = "USD") {
  const n = Number(value);
  const needsMore = n !== 0 && Math.abs(n) < 1;
  return new Intl.NumberFormat(LOCALE[currency], {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: needsMore ? 8 : 2,
  }).format(n);
}

export function formatPercent(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

/** Quantity with thousands separators and up to 8 decimals, from an exact decimal string. */
export function formatQuantity(value: string | number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(Number(value));
}
