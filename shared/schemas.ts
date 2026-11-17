/**
 * Request schemas (zod) shared by the server (authoritative validation) and the
 * browser (early feedback in forms). The same rules run on both sides.
 */
import { z } from "zod";
import { parsePositiveDecimal } from "./decimal";
import { ASSET_TYPE_IDS, TAB_COLORS } from "./assetTypes";
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
  tabId: z.coerce.number().int().positive("Aba inválida"),
});

const tabName = z.string().trim().min(1, "Dê um nome à aba").max(40, "Nome da aba muito longo");
const tabColor = z.enum(TAB_COLORS, { message: "Cor inválida" });

export const tabCreateSchema = z.object({
  name: tabName,
  assetType: z.enum(ASSET_TYPE_IDS as [string, ...string[]], { message: "Tipo de ativo inválido" }),
  color: tabColor,
});

export const tabUpdateSchema = z
  .object({ name: tabName.optional(), color: tabColor.optional() })
  .refine((d) => d.name !== undefined || d.color !== undefined, { message: "Nada para alterar" });

export const tabReorderSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

const portfolioName = z.string().trim().min(1, "Dê um nome à carteira").max(40, "Nome da carteira muito longo");

export const portfolioCreateSchema = z.object({ name: portfolioName, color: tabColor });

export const portfolioUpdateSchema = z
  .object({ name: portfolioName.optional(), color: tabColor.optional(), archived: z.boolean().optional() })
  .refine((d) => d.name !== undefined || d.color !== undefined || d.archived !== undefined, { message: "Nada para alterar" });

export const portfolioReorderSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

export const portfolioDeleteSchema = z.object({
  password: z.string().min(1, "Informe a senha").max(1024),
  confirmName: z.string().trim().max(40),
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

const apiKeyField = z
  .string()
  .trim()
  .min(LIMITS.finnhubKeyMin, "Chave muito curta")
  .max(LIMITS.finnhubKeyMax, "Chave muito longa")
  .regex(FINNHUB_KEY_RE, "Formato de chave inválido");

export const finnhubKeySchema = z.object({ apiKey: apiKeyField });

/** Massive (ex-Polygon) key, used only for historical candles (charts). */
export const massiveKeySchema = z.object({ apiKey: apiKeyField });

/** Alpaca key pair (US stocks candles). Paper keys start with "PK"; only letters and digits. */
export const alpacaKeySchema = z.object({
  keyId: z.string().trim().regex(/^[A-Za-z0-9]{16,40}$/, "API Key ID inválido (letras e números, 16 a 40)"),
  secret: z.string().trim().regex(/^[A-Za-z0-9]{30,80}$/, "Secret Key inválido (letras e números, 30 a 80)"),
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
