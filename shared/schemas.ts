/**
 * Request schemas (zod) shared by the server (authoritative validation) and the
 * browser (early feedback in forms). The same rules run on both sides.
 */
import { z } from "zod";
import { parsePositiveDecimal } from "./decimal";
import {
  EMAIL_RE,
  FINNHUB_KEY_RE,
  LIMITS,
  TICKER_RE,
  isValidIsoDate,
  passwordProblem,
} from "./validation";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.emailMax, "E-mail muito longo")
  .regex(EMAIL_RE, "E-mail inválido");

const passwordSchema = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const tickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(TICKER_RE, "Ticker inválido");

/** Positive decimal (string or number) normalized to a canonical string, max 8 decimals. */
export const decimalSchema = (label: string) =>
  z.union([z.string(), z.number()]).transform((value, ctx) => {
    const parsed = parsePositiveDecimal(value);
    if (!parsed) {
      ctx.addIssue({
        code: "custom",
        message: `${label}: use um número positivo com até 8 casas decimais`,
      });
      return z.NEVER;
    }
    return parsed;
  });

export const isoDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoDate, "Data inválida (use AAAA-MM-DD)");

export const registerSchema = z
  .object({
    email: emailSchema,
    displayName: z
      .string()
      .trim()
      .max(LIMITS.displayNameMax, "Nome muito longo")
      .optional()
      .transform((v) => v || null),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "A confirmação da senha não confere",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(LIMITS.emailMax),
  password: z.string().max(1024),
});

export const stockSchema = z.object({
  ticker: tickerSchema,
  name: z.string().trim().min(1, "Nome obrigatório").max(LIMITS.stockNameMax, "Nome muito longo"),
});

export const transactionSchema = z.object({
  ticker: tickerSchema,
  type: z.preprocess(
    (v) => String(v ?? "").trim().toUpperCase(),
    z.enum(["BUY", "SELL"], { message: "Tipo inválido (BUY/SELL)" })
  ),
  shares: decimalSchema("Quantidade"),
  price: decimalSchema("Preço"),
  date: isoDateSchema,
});

export const finnhubKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(LIMITS.finnhubKeyMin, "Chave muito curta")
    .max(LIMITS.finnhubKeyMax, "Chave muito longa")
    .regex(FINNHUB_KEY_RE, "Formato de chave inválido"),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Informe a senha").max(1024),
  confirmEmail: z.string().trim().toLowerCase().max(LIMITS.emailMax),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Informe a senha atual").max(1024),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "A confirmação da nova senha não confere",
    path: ["confirmPassword"],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: "A nova senha precisa ser diferente da atual",
    path: ["newPassword"],
  });

export const changeEmailSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual").max(1024),
  newEmail: emailSchema,
});

/** First human-readable message of a failed parse. */
export function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Dados inválidos";
}

export type RegisterInput = z.infer<typeof registerSchema>;
export type TransactionInput = z.infer<typeof transactionSchema>;
