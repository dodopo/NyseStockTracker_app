import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { z } from "zod";
import type { AppConfig } from "./config";
import { CandleError, createCandleService, defaultMassiveFetch, providerUrls, type AlpacaKeys, type MassiveFetch } from "./candles";
import { ALPACA_FREE_DELAY_MS, alpacaHeaders } from "./providers/alpaca";
import { coinbaseUsdAssets, coinbaseUsdBrl, type CryptoAsset } from "./providers/coinbase";
import { defaultDataFetch, offlineDataFetch, type DataFetch } from "./providers/types";
import { MOVING_AVERAGE_IDS, movingAverage, type MovingAverageId, type SeriesPoint } from "../shared/indicators";
import { ensureDefaultTabs, DEFAULT_TAB, type DB } from "./db";
import { assetTypeOfTicker, displaySymbol, finnhubQuoteSymbol, isCryptoTicker, CRYPTO_TICKER_RE } from "../shared/assetTypes";
import { parsePositiveDecimal } from "../shared/decimal";
import { APP_NAME } from "../shared/brand";
import {
  alpacaKeySchema,
  changeEmailSchema,
  changePasswordSchema,
  deleteAccountSchema,
  finnhubKeySchema,
  firstIssue,
  loginSchema,
  massiveKeySchema,
  registerSchema,
  stockSchema,
  tabCreateSchema,
  tabReorderSchema,
  tabUpdateSchema,
  transactionSchema,
} from "../shared/schemas";
import {
  LIMITS,
  findNegativePosition,
  isValidFinnhubKey,
  isValidIsoDate,
  isValidTicker,
  normalizeEmail,
  normalizeTicker,
  shortText,
  type PositionTx,
} from "../shared/validation";

export const SESSION_COOKIE_NAME = "nyse_tracker_session";
const BCRYPT_COST = 12;

export type FinnhubFetch = (url: string) => Promise<any>;

type UserRow = {
  id: number;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  finnhub_key: string | null;
  massive_key: string | null;
  alpaca_key_id: string | null;
  alpaca_secret: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

type TxRow = PositionTx & { id: number; price: string };

/** Error whose message is safe to show to the user. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Validates a request body with a shared zod schema; 400 with the first issue otherwise. */
function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new HttpError(400, firstIssue(result.error));
  return result.data;
}

// Canonical decimal strings come from the *_dec columns (exact); REAL columns are legacy.
const TX_COLUMNS = `id, ticker, type, shares_dec AS shares, price_dec AS price, date, created_at, sort_order`;

async function defaultFinnhubFetch(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) {
    // Never include the URL: it carries the API token.
    throw new Error(`Finnhub HTTP ${r.status}`);
  }
  return r.json();
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(header?: string) {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // Malformed cookie value: ignore it instead of crashing the request.
    }
  }
  return out;
}

function getSafeUser(user: UserRow | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    hasPassword: !!user.password_hash,
    hasFinnhubKey: !!user.finnhub_key,
    hasMassiveKey: !!user.massive_key,
    hasAlpacaKey: !!(user.alpaca_key_id && user.alpaca_secret),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
  };
}

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<unknown> | unknown;

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
const wrap =
  (handler: AsyncHandler): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

export function createApp(
  db: DB,
  config: AppConfig,
  deps: { finnhubFetch?: FinnhubFetch; massiveFetch?: MassiveFetch; dataFetch?: DataFetch; now?: () => number } = {}
) {
  const finnhubFetch = deps.finnhubFetch ?? defaultFinnhubFetch;
  const massiveFetch = deps.massiveFetch ?? defaultMassiveFetch;
  // Tests never reach Coinbase/Binance/Alpaca unless they pass a fake client.
  const dataFetch = deps.dataFetch ?? (process.env.VITEST || process.env.NODE_ENV === "test" ? offlineDataFetch : defaultDataFetch);
  const candleService = createCandleService({ fetch: massiveFetch, dataFetch, now: deps.now });
  const statsCache = new Map<string, { value: unknown; expiresAt: number }>();

  // ---------------------------------------------------------------------------
  // Prepared statements (all parameterized, all scoped by user_id)
  // ---------------------------------------------------------------------------
  const q = {
    getStocks: db.prepare(
      `SELECT id, ticker, name, created_at, asset_type, tab_id FROM stocks WHERE user_id = ? ORDER BY ticker ASC`
    ),
    getStock: db.prepare(`SELECT id FROM stocks WHERE user_id = ? AND ticker = ?`),
    insertStock: db.prepare(
      `INSERT INTO stocks (user_id, ticker, name, created_at, asset_type, tab_id) VALUES (?, ?, ?, ?, ?, ?)`
    ),

    getTabs: db.prepare(
      `SELECT t.id, t.name, t.asset_type, t.color, t.sort_order,
              (SELECT COUNT(*) FROM stocks s WHERE s.tab_id = t.id) AS asset_count
       FROM tabs t WHERE t.user_id = ? ORDER BY t.sort_order ASC, t.id ASC`
    ),
    getTab: db.prepare(`SELECT id, name, asset_type, color, sort_order FROM tabs WHERE user_id = ? AND id = ?`),
    insertTab: db.prepare(
      `INSERT INTO tabs (user_id, name, asset_type, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ),
    nextTabOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tabs WHERE user_id = ?`),
    updateTab: db.prepare(`UPDATE tabs SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE user_id = ? AND id = ?`),
    setTabOrder: db.prepare(`UPDATE tabs SET sort_order = ? WHERE user_id = ? AND id = ?`),
    countTabs: db.prepare(`SELECT COUNT(*) AS n FROM tabs WHERE user_id = ?`),
    countTabAssets: db.prepare(`SELECT COUNT(*) AS n FROM stocks WHERE user_id = ? AND tab_id = ?`),
    moveTabAssets: db.prepare(`UPDATE stocks SET tab_id = ? WHERE user_id = ? AND tab_id = ?`),
    deleteTab: db.prepare(`DELETE FROM tabs WHERE user_id = ? AND id = ?`),
    deleteAllTabs: db.prepare(`DELETE FROM tabs WHERE user_id = ?`),
    deleteStock: db.prepare(`DELETE FROM stocks WHERE user_id = ? AND ticker = ?`),
    deleteAllStocks: db.prepare(`DELETE FROM stocks WHERE user_id = ?`),

    getTxAsc: db.prepare(
      `SELECT ${TX_COLUMNS} FROM transactions WHERE user_id = ? ORDER BY date ASC, sort_order ASC, id ASC`
    ),
    getTxByTicker: db.prepare(
      `SELECT ${TX_COLUMNS} FROM transactions WHERE user_id = ? AND ticker = ?
       ORDER BY date ASC, sort_order ASC, id ASC`
    ),
    getTxDesc: db.prepare(
      `SELECT ${TX_COLUMNS} FROM transactions WHERE user_id = ? ORDER BY date DESC, sort_order DESC, id DESC`
    ),
    getTxById: db.prepare(`SELECT id, ticker FROM transactions WHERE user_id = ? AND id = ?`),
    insertTx: db.prepare(
      `INSERT INTO transactions (user_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
    deleteTx: db.prepare(`DELETE FROM transactions WHERE user_id = ? AND id = ?`),
    deleteTxByTicker: db.prepare(`DELETE FROM transactions WHERE user_id = ? AND ticker = ?`),
    deleteAllTx: db.prepare(`DELETE FROM transactions WHERE user_id = ?`),
    nextSortOrder: db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM transactions WHERE user_id = ?`
    ),

    getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
    insertUser: db.prepare(
      `INSERT INTO users (email, display_name, password_hash, recovery_key_hash, finnhub_key, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`
    ),
    updateLastLogin: db.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`),
    updateFinnhubKey: db.prepare(`UPDATE users SET finnhub_key = ?, updated_at = ? WHERE id = ?`),
    updateMassiveKey: db.prepare(`UPDATE users SET massive_key = ?, updated_at = ? WHERE id = ?`),
    updateAlpacaKey: db.prepare(`UPDATE users SET alpaca_key_id = ?, alpaca_secret = ?, updated_at = ? WHERE id = ?`),
    updatePassword: db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`),
    updateEmail: db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`),
    updateProfileFromBackup: db.prepare(
      `UPDATE users SET display_name = ?, finnhub_key = COALESCE(?, finnhub_key), updated_at = ? WHERE id = ?`
    ),

    getSettings: db.prepare(
      `SELECT default_port, theme, currency, include_secrets_in_backup, created_at, updated_at
       FROM user_settings WHERE user_id = ?`
    ),
    upsertSettings: db.prepare(
      `INSERT INTO user_settings (user_id, default_port, theme, currency, include_secrets_in_backup, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         default_port = excluded.default_port,
         theme = excluded.theme,
         currency = excluded.currency,
         include_secrets_in_backup = excluded.include_secrets_in_backup,
         updated_at = excluded.updated_at`
    ),

    insertSession: db.prepare(
      `INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`
    ),
    getSession: db.prepare(`SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    deleteOtherSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`),
    deleteAllSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
    countActiveSessions: db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?`),
    deleteExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  };

  // Used to spend the same bcrypt time when the e-mail does not exist (anti-enumeration).
  const dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), BCRYPT_COST);

  /** Writes the exact decimal columns and the legacy REAL columns (rollback compatibility). */
  function insertTransaction(
    userId: number,
    tx: { ticker: string; type: "BUY" | "SELL"; shares: string; price: string; date: string },
    createdAt: string,
    sortOrder: number
  ) {
    return q.insertTx.run(
      userId,
      tx.ticker,
      tx.type,
      Number(tx.shares),
      Number(tx.price),
      tx.shares,
      tx.price,
      tx.date,
      createdAt,
      sortOrder
    );
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  function setSessionCookie(res: express.Response, token: string) {
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
    ];
    if (config.cookieSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function clearSessionCookie(res: express.Response) {
    const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (config.cookieSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function createSession(res: express.Response, userId: number) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    q.deleteExpiredSessions.run(new Date(now).toISOString());
    q.insertSession.run(
      userId,
      hashToken(token),
      new Date(now).toISOString(),
      new Date(now + config.sessionTtlMs).toISOString()
    );
    setSessionCookie(res, token);
  }

  function getAuth(req: express.Request) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) return null;

    const tokenHash = hashToken(token);
    const session = q.getSession.get(tokenHash) as
      | { id: number; user_id: number; expires_at: string }
      | undefined;
    if (!session) return null;

    if (Date.parse(session.expires_at) <= Date.now()) {
      q.deleteSession.run(tokenHash);
      return null;
    }

    const user = q.getUserById.get(session.user_id) as UserRow | undefined;
    if (!user) return null;
    return { user, tokenHash };
  }

  /** Express middleware: rejects the request with 401 when there is no valid session. */
  const requireAuth: express.RequestHandler = (req, res, next) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.user = auth.user;
    res.locals.tokenHash = auth.tokenHash;
    next();
  };

  const currentUser = (res: express.Response) => res.locals.user as UserRow;

  // ---------------------------------------------------------------------------
  // Finnhub (quote cache bounded in size)
  // ---------------------------------------------------------------------------
  const quoteCache = new Map<string, { value: any; expiresAt: number }>();

  function requireFinnhubKey(user: UserRow) {
    // No server-wide fallback key: each user brings their own Finnhub key.
    if (!user.finnhub_key) throw new HttpError(400, "Missing Finnhub API key");
    return user.finnhub_key;
  }

  /**
   * Confirms a Finnhub key works before saving it, with one real quote request,
   * so a mistyped key never replaces a working one.
   */
  async function verifyFinnhubKey(apiKey: string) {
    let raw: any;
    try {
      raw = await finnhubFetch(
        `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(apiKey)}`
      );
    } catch {
      throw new HttpError(400, "A Finnhub recusou esta chave. Confira se copiou a chave inteira.");
    }
    if (!raw || typeof raw !== "object" || !("c" in raw)) {
      throw new HttpError(400, "A Finnhub não confirmou esta chave. Tente de novo em instantes.");
    }
  }

  /** Confirms a Massive key works (one small daily-candle request) before saving it. */
  async function verifyMassiveKey(apiKey: string) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    let raw: any;
    try {
      raw = await massiveFetch(`/v2/aggs/ticker/AAPL/range/1/day/${from}/${to}?adjusted=true&limit=20`, apiKey);
    } catch {
      throw new HttpError(400, "A Massive recusou esta chave. Confira se copiou a chave inteira.");
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.results)) {
      throw new HttpError(400, "A Massive não confirmou esta chave. Tente de novo em instantes.");
    }
  }

  /** A key pair is saved only after Alpaca answers a small request with it. */
  async function verifyAlpacaKey(keys: AlpacaKeys) {
    const t = Date.now();
    let raw: any;
    try {
      raw = await dataFetch(
        `${(process.env.ALPACA_DATA_URL?.trim() || "https://data.alpaca.markets").replace(/\/+$/, "")}/v2/stocks/bars?` +
          new URLSearchParams({
            symbols: "AAPL",
            timeframe: "1Day",
            start: new Date(t - 10 * 86_400_000).toISOString(),
            end: new Date(t - ALPACA_FREE_DELAY_MS).toISOString(),
            feed: "sip",
            limit: "20",
          }),
        alpacaHeaders(keys)
      );
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        throw new HttpError(400, "A Alpaca recusou esta chave. Confira se colou o API Key ID e o Secret Key certos.");
      }
      throw new HttpError(502, "Não foi possível falar com a Alpaca agora. Tente de novo em instantes.");
    }
    if (!raw || typeof raw !== "object" || typeof raw.bars !== "object") {
      throw new HttpError(400, "A Alpaca não confirmou esta chave. Tente de novo em instantes.");
    }
  }

  function alpacaKeysOf(user: UserRow): AlpacaKeys | null {
    return user.alpaca_key_id && user.alpaca_secret ? { keyId: user.alpaca_key_id, secret: user.alpaca_secret } : null;
  }

  async function checkPassword(user: UserRow, password: string) {
    const ok = await bcrypt.compare(password, user.password_hash || dummyHash);
    if (!user.password_hash || !ok) throw new HttpError(401, "Senha atual incorreta");
  }

  function keyHint(key: string | null) {
    return key ? `••••${key.slice(-4)}` : null;
  }

  async function getQuoteCached(symbol: string, apiKey: string, massiveKey?: string | null) {
    const now = Date.now();
    const cached = quoteCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      return { raw: cached.value, cacheHit: true, ttlMs: cached.expiresAt - now };
    }

    // Stocks: Finnhub quote. Crypto (X:BTCUSD): Finnhub's Binance USDT pair (live, 24/7).
    let raw = await finnhubFetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(finnhubQuoteSymbol(symbol))}&token=${encodeURIComponent(apiKey)}`
    );

    // Crypto not listed on Binance: fall back to Massive's previous close (delayed).
    if (isCryptoTicker(symbol) && !(Number(raw?.c) > 0) && massiveKey) {
      raw = await candleService.cachedGet(`prev|${symbol}`, `/v2/aggs/ticker/${symbol}/prev?adjusted=true`, massiveKey, 15 * 60_000, (r) => {
        const bar = Array.isArray(r?.results) ? r.results[0] : null;
        return bar ? { c: bar.c, o: bar.o, h: bar.h, l: bar.l, pc: bar.o, d: bar.c - bar.o, dp: bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0, source: "massive-prev" } : { c: 0 };
      });
    }

    quoteCache.delete(symbol);
    if (quoteCache.size >= config.quoteCacheMaxEntries) {
      const oldest = quoteCache.keys().next().value;
      if (oldest !== undefined) quoteCache.delete(oldest);
    }
    quoteCache.set(symbol, { value: raw, expiresAt: now + config.quoteCacheTtlMs });

    return { raw, cacheHit: false, ttlMs: config.quoteCacheTtlMs };
  }

  function toQuote(symbol: string, raw: any) {
    return {
      symbol,
      price: raw?.c ?? null,
      change: raw?.d ?? null,
      changePct: raw?.dp ?? null,
      high: raw?.h ?? null,
      low: raw?.l ?? null,
      open: raw?.o ?? null,
      prevClose: raw?.pc ?? null,
      raw,
    };
  }

  /** Crypto search (Massive reference data): USD pairs only, best matches first, cached 24 h. */
  /** Coinbase's US dollar list, cached for 24 h (null while unavailable). */
  let coinbaseList: { value: CryptoAsset[]; expiresAt: number } | null = null;
  async function coinbaseAssets(): Promise<CryptoAsset[] | null> {
    if (coinbaseList && coinbaseList.expiresAt > Date.now()) return coinbaseList.value;
    try {
      const value = await coinbaseUsdAssets(dataFetch, providerUrls().coinbase);
      coinbaseList = { value, expiresAt: Date.now() + 24 * 60 * 60_000 };
      return value;
    } catch (error: any) {
      console.warn(`[search] coinbase falhou (status ${Number(error?.status) || "-"})`);
      return coinbaseList?.value ?? null; // stale list is better than nothing
    }
  }

  function rankCrypto<T extends { description: string; displaySymbol: string; aliases?: string[] }>(found: T[], query: string) {
    const qU = query.toUpperCase();
    const qL = query.toLowerCase();
    const names = (r: T) => [r.description, ...(r.aliases ?? [])].map((n) => n.toLowerCase());
    const score = (r: T) =>
      r.displaySymbol === qU ? 0 : names(r).includes(qL) ? 1 : names(r).some((n) => n.startsWith(qL)) ? 2 : r.displaySymbol.startsWith(qU) ? 3 : 4;
    return [...found].sort((a, b) => score(a) - score(b) || a.description.length - b.description.length).slice(0, 20);
  }

  /** Crypto search: Coinbase (no key) first; Massive (key) when Coinbase finds nothing. */
  async function searchCryptoAll(query: string, massiveKey: string | null) {
    const list = await coinbaseAssets();
    const qL = query.toLowerCase();
    const qU = query.toUpperCase();
    const hits = (list ?? []).filter(
      (a) => a.displaySymbol.includes(qU) || [a.description, ...a.aliases].some((n) => n.toLowerCase().includes(qL))
    );
    if (hits.length > 0) {
      const result = rankCrypto(hits, query).map(({ symbol, description, displaySymbol }) => ({ symbol, description, displaySymbol }));
      return { count: result.length, result, source: "coinbase" };
    }
    if (massiveKey) return { ...(await searchCrypto(query, massiveKey)), source: "massive" };
    if (list === null) throw new HttpError(502, "Não foi possível buscar criptos agora. Tente de novo em instantes.");
    return { count: 0, result: [], source: "coinbase" };
  }

  async function searchCrypto(query: string, massiveKey: string) {
    const path = `/v3/reference/tickers?market=crypto&search=${encodeURIComponent(query)}&active=true&limit=100`;
    let found: Array<{ symbol: string; description: string; displaySymbol: string }>;
    try {
      found = await candleService.cachedGet(`search|${query.toLowerCase()}`, path, massiveKey, 24 * 60 * 60_000, (raw) =>
        (Array.isArray(raw?.results) ? raw.results : [])
          .filter((r: any) => typeof r?.ticker === "string" && CRYPTO_TICKER_RE.test(r.ticker))
          .map((r: any) => ({
            symbol: r.ticker as string,
            description: String(r.name ?? "").replace(/ - United States dollar$/i, "").trim() || displaySymbol(r.ticker),
            displaySymbol: displaySymbol(r.ticker),
          }))
      );
    } catch (error) {
      if (error instanceof CandleError) throw new HttpError(error.status, error.message);
      throw error;
    }
    const result = rankCrypto(found, query);
    return { count: result.length, result };
  }

  function parseSymbol(value: unknown) {
    const symbol = normalizeTicker(value);
    if (!isValidTicker(symbol)) throw new HttpError(400, "Invalid symbol");
    return symbol;
  }

  // ---------------------------------------------------------------------------
  // App + global middleware
  // ---------------------------------------------------------------------------
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      // Vite dev server injects inline scripts; enforce CSP only in production.
      contentSecurityPolicy: config.isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              fontSrc: ["'self'"],
              imgSrc: ["'self'", "data:"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
              upgradeInsecureRequests: null,
            },
          }
        : false,
      strictTransportSecurity: config.cookieSecure,
    })
  );

  const limiterDefaults = {
    standardHeaders: "draft-7" as const,
    legacyHeaders: false,
  };

  app.use(
    "/api",
    rateLimit({
      ...limiterDefaults,
      ...config.apiRateLimit,
      message: { error: "Too many requests, try again later" },
    })
  );

  const authLimiter = rateLimit({
    ...limiterDefaults,
    ...config.authRateLimit,
    message: { error: "Too many attempts, try again in a few minutes" },
  });

  // Small JSON bodies everywhere; only the backup import may be larger.
  const smallJson = express.json({ limit: "100kb" });
  const largeJson = express.json({ limit: "5mb" });
  app.use((req, res, next) =>
    req.path === "/api/import" ? largeJson(req, res, next) : smallJson(req, res, next)
  );

  // ---------------------------------------------------------------------------
  // Auth routes
  // ---------------------------------------------------------------------------
  app.post(
    "/api/auth/register",
    authLimiter,
    wrap(async (req, res) => {
      if (!config.allowRegistration) {
        throw new HttpError(403, "Registration is disabled on this server");
      }

      const { email, displayName, password } = parseBody(registerSchema, req.body);
      if (q.getUserByEmail.get(email)) throw new HttpError(400, "User already exists");

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const timestamp = nowIso();

      const userId = db.transaction(() => {
        const info = q.insertUser.run(email, displayName, passwordHash, timestamp, timestamp);
        const id = Number(info.lastInsertRowid);
        q.upsertSettings.run(id, config.port, "dark", "USD", 0, timestamp, timestamp);
        q.insertTab.run(id, DEFAULT_TAB.name, DEFAULT_TAB.assetType, DEFAULT_TAB.color, 1, timestamp);
        return id;
      })();

      createSession(res, userId);
      res.status(201).json({ success: true, user: getSafeUser(q.getUserById.get(userId) as UserRow) });
    })
  );

  app.post(
    "/api/auth/login",
    authLimiter,
    wrap(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body ?? {});
      const email = parsed.success ? parsed.data.email : "";
      const password = parsed.success ? parsed.data.password : "";

      const user = q.getUserByEmail.get(email) as UserRow | undefined;
      // Always run bcrypt, even for unknown users, so timing does not reveal accounts.
      const ok = await bcrypt.compare(password, user?.password_hash || dummyHash);

      // Accounts without a password (created by v0.2.0 and older) can no longer log in.
      if (!user || !user.password_hash || !ok) {
        throw new HttpError(401, "Invalid credentials");
      }

      const timestamp = nowIso();
      q.updateLastLogin.run(timestamp, timestamp, user.id);
      createSession(res, user.id);

      res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
    })
  );

  app.post("/api/auth/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) q.deleteSession.run(hashToken(token));
    clearSessionCookie(res);
    res.json({ success: true });
  });

  // Liveness + running version, used by the update script to confirm a deploy.
  app.get("/api/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", version: config.appVersion });
  });

  app.get("/api/auth/me", (req, res) => {
    const auth = getAuth(req);
    res.json({
      authenticated: !!auth,
      user: getSafeUser(auth?.user),
      registrationEnabled: config.allowRegistration,
    });
  });

  app.post(
    "/api/auth/finnhub-key",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const { apiKey } = parseBody(finnhubKeySchema, req.body);
      await verifyFinnhubKey(apiKey);

      q.updateFinnhubKey.run(apiKey, nowIso(), user.id);
      res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
    })
  );

  app.post(
    "/api/auth/massive-key",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const { apiKey } = parseBody(massiveKeySchema, req.body);
      await verifyMassiveKey(apiKey);

      q.updateMassiveKey.run(apiKey, nowIso(), user.id);
      res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
    })
  );

  app.post(
    "/api/auth/alpaca-key",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const keys = parseBody(alpacaKeySchema, req.body);
      await verifyAlpacaKey(keys);

      q.updateAlpacaKey.run(keys.keyId, keys.secret, nowIso(), user.id);
      res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
    })
  );

  // ---------------------------------------------------------------------------
  // Account (settings)
  // ---------------------------------------------------------------------------
  app.get("/api/account", requireAuth, (_req, res) => {
    const user = currentUser(res);
    const { n } = q.countActiveSessions.get(user.id, nowIso()) as { n: number };
    res.json({
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      finnhubKeyHint: keyHint(user.finnhub_key),
      massiveKeyHint: keyHint(user.massive_key),
      alpacaKeyHint: keyHint(user.alpaca_key_id),
      activeSessions: n,
      appVersion: config.appVersion,
    });
  });

  app.post(
    "/api/account/password",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
      await checkPassword(user, currentPassword);

      const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
      db.transaction(() => {
        q.updatePassword.run(hash, nowIso(), user.id);
        // Anyone else logged in with the old password is signed out now.
        q.deleteOtherSessions.run(user.id, res.locals.tokenHash as string);
      })();
      res.json({ success: true });
    })
  );

  app.post(
    "/api/account/email",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const { currentPassword, newEmail } = parseBody(changeEmailSchema, req.body);
      await checkPassword(user, currentPassword);

      if (newEmail === user.email) throw new HttpError(400, "Este já é o seu e-mail");
      if (q.getUserByEmail.get(newEmail)) throw new HttpError(400, "Este e-mail já está em uso");

      q.updateEmail.run(newEmail, nowIso(), user.id);
      res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
    })
  );

  app.post("/api/account/logout-all", requireAuth, (_req, res) => {
    q.deleteAllSessions.run(currentUser(res).id);
    clearSessionCookie(res);
    res.json({ success: true });
  });

  app.post(
    "/api/auth/delete-account",
    authLimiter,
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const { password, confirmEmail } = parseBody(deleteAccountSchema, req.body);

      const ok = await bcrypt.compare(password, user.password_hash || dummyHash);
      if (!user.password_hash || !ok) throw new HttpError(401, "Senha incorreta");
      if (confirmEmail !== user.email) {
        throw new HttpError(400, "Digite o seu e-mail exatamente como cadastrado para confirmar");
      }

      // ON DELETE CASCADE removes settings, sessions, stocks and transactions.
      q.deleteUser.run(user.id);
      clearSessionCookie(res);
      res.json({ success: true });
    })
  );

  // ---------------------------------------------------------------------------
  // Portfolio
  // ---------------------------------------------------------------------------
  app.get("/api/stocks", requireAuth, (_req, res) => {
    res.json(q.getStocks.all(currentUser(res).id));
  });

  app.post("/api/stocks", requireAuth, (req, res) => {
    const user = currentUser(res);
    const { ticker, name, tabId } = parseBody(stockSchema, req.body);
    const tab = q.getTab.get(user.id, tabId) as { id: number; asset_type: string } | undefined;
    if (!tab) throw new HttpError(404, "Aba não encontrada");
    const assetType = assetTypeOfTicker(ticker);
    if (tab.asset_type !== assetType) {
      throw new HttpError(400, "Este ativo não é do tipo desta aba");
    }
    if (q.getStock.get(user.id, ticker)) throw new HttpError(400, "Este ativo já está na carteira");

    q.insertStock.run(user.id, ticker, name, nowIso(), assetType, tab.id);
    res.status(201).json({ ticker, name, assetType, tabId: tab.id });
  });

  // ---------------------------------------------------------------------------
  // Tabs (user-defined groups of assets, each bound to an asset type)
  // ---------------------------------------------------------------------------
  type TabRow = { id: number; name: string; asset_type: string; color: string; sort_order: number; asset_count?: number };
  const tabDto = (t: TabRow) => ({
    id: t.id,
    name: t.name,
    assetType: t.asset_type,
    color: t.color,
    sortOrder: t.sort_order,
    assetCount: t.asset_count ?? 0,
  });

  app.get("/api/tabs", requireAuth, (_req, res) => {
    res.json((q.getTabs.all(currentUser(res).id) as TabRow[]).map(tabDto));
  });

  app.post("/api/tabs", requireAuth, (req, res) => {
    const user = currentUser(res);
    const { name, assetType, color } = parseBody(tabCreateSchema, req.body);
    if ((q.countTabs.get(user.id) as { n: number }).n >= 20) throw new HttpError(400, "Limite de 20 abas");
    const order = (q.nextTabOrder.get(user.id) as { n: number }).n;
    const id = Number(q.insertTab.run(user.id, name, assetType, color, order, nowIso()).lastInsertRowid);
    res.status(201).json(tabDto({ ...(q.getTab.get(user.id, id) as TabRow), asset_count: 0 }));
  });

  app.patch("/api/tabs/:id", requireAuth, (req, res) => {
    const user = currentUser(res);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !q.getTab.get(user.id, id)) throw new HttpError(404, "Aba não encontrada");
    const { name, color } = parseBody(tabUpdateSchema, req.body);
    q.updateTab.run(name ?? null, color ?? null, user.id, id);
    res.json(tabDto(q.getTab.get(user.id, id) as TabRow));
  });

  app.post("/api/tabs/reorder", requireAuth, (req, res) => {
    const user = currentUser(res);
    const { ids } = parseBody(tabReorderSchema, req.body);
    const mine = new Set((q.getTabs.all(user.id) as TabRow[]).map((t) => t.id));
    if (ids.length !== mine.size || ids.some((id) => !mine.has(id)) || new Set(ids).size !== ids.length) {
      throw new HttpError(400, "A nova ordem precisa conter todas as suas abas, uma vez cada");
    }
    db.transaction(() => ids.forEach((id, i) => q.setTabOrder.run(i + 1, user.id, id)))();
    res.json((q.getTabs.all(user.id) as TabRow[]).map(tabDto));
  });

  app.delete("/api/tabs/:id", requireAuth, (req, res) => {
    const user = currentUser(res);
    const id = Number(req.params.id);
    const tab = Number.isSafeInteger(id) ? (q.getTab.get(user.id, id) as TabRow | undefined) : undefined;
    if (!tab) throw new HttpError(404, "Aba não encontrada");
    if ((q.countTabs.get(user.id) as { n: number }).n <= 1) {
      throw new HttpError(400, "Não é possível excluir a única aba");
    }

    const count = (q.countTabAssets.get(user.id, id) as { n: number }).n;
    if (count > 0) {
      // Never delete assets or trades silently: they must be moved to another tab of the same type.
      const moveTo = Number(req.query.moveTo);
      if (!req.query.moveTo) {
        res.status(409).json({ error: `Esta aba tem ${count} ativo(s). Escolha para qual aba movê-los.`, code: "TAB_NOT_EMPTY", count });
        return;
      }
      const target = Number.isSafeInteger(moveTo) ? (q.getTab.get(user.id, moveTo) as TabRow | undefined) : undefined;
      if (!target || target.id === id) throw new HttpError(400, "Aba de destino inválida");
      if (target.asset_type !== tab.asset_type) {
        throw new HttpError(400, "A aba de destino precisa ser do mesmo tipo de ativo");
      }
      db.transaction(() => {
        q.moveTabAssets.run(target.id, user.id, id);
        q.deleteTab.run(user.id, id);
      })();
    } else {
      q.deleteTab.run(user.id, id);
    }
    res.status(204).send();
  });

  app.delete("/api/stocks/:ticker", requireAuth, (req, res) => {
    const user = currentUser(res);
    const ticker = normalizeTicker(req.params.ticker);
    if (!isValidTicker(ticker)) throw new HttpError(400, "Invalid ticker");

    db.transaction(() => {
      q.deleteTxByTicker.run(user.id, ticker);
      q.deleteStock.run(user.id, ticker);
    })();
    res.status(204).send();
  });

  app.get("/api/transactions", requireAuth, (req, res) => {
    const user = currentUser(res);
    if (req.query.ticker) {
      const ticker = normalizeTicker(req.query.ticker);
      if (!isValidTicker(ticker)) throw new HttpError(400, "Invalid ticker");
      return res.json(q.getTxByTicker.all(user.id, ticker));
    }
    const order = String(req.query.order ?? "").toLowerCase();
    res.json(order === "desc" ? q.getTxDesc.all(user.id) : q.getTxAsc.all(user.id));
  });

  app.post("/api/transactions", requireAuth, (req, res) => {
    const user = currentUser(res);
    const tx = parseBody(transactionSchema, req.body);
    const { ticker, type, shares, date } = tx;
    if (!q.getStock.get(user.id, ticker)) {
      throw new HttpError(400, "Ticker not found in portfolio. Add the stock first.");
    }

    const id = db.transaction(() => {
      const nextSortOrder = Number((q.nextSortOrder.get(user.id) as { next: number }).next);
      const existing = q.getTxByTicker.all(user.id, ticker) as TxRow[];

      if (
        type === "SELL" &&
        findNegativePosition([...existing, { ticker, type, shares, date, sort_order: nextSortOrder }])
      ) {
        throw new HttpError(400, "Cannot SELL more shares than held on that date (no short allowed)");
      }

      return insertTransaction(user.id, tx, nowIso(), nextSortOrder).lastInsertRowid;
    })();

    res.status(201).json({ success: true, id: Number(id) });
  });

  app.delete("/api/transactions/:id", requireAuth, (req, res) => {
    const user = currentUser(res);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");

    db.transaction(() => {
      const tx = q.getTxById.get(user.id, id) as { id: number; ticker: string } | undefined;
      if (!tx) return; // Not found or not yours: idempotent 204, reveals nothing.

      const remaining = (q.getTxByTicker.all(user.id, tx.ticker) as TxRow[]).filter((t) => t.id !== id);
      if (findNegativePosition(remaining)) {
        throw new HttpError(409, "Deleting this transaction would make the position negative");
      }
      q.deleteTx.run(user.id, id);
    })();

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Backup export / import
  // ---------------------------------------------------------------------------
  app.get("/api/export", requireAuth, (_req, res) => {
    const user = currentUser(res);
    const settings = q.getSettings.get(user.id) as { include_secrets_in_backup?: number } | undefined;
    const includeSecrets = Number(settings?.include_secrets_in_backup ?? 0) === 1;

    res.json({
      app: APP_NAME,
      version: 1,
      exportedAt: nowIso(),
      user: {
        email: user.email,
        display_name: user.display_name,
        finnhub_key: includeSecrets ? user.finnhub_key : null,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
      },
      settings,
      tabs: (q.getTabs.all(user.id) as TabRow[]).map((t) => ({
        id: t.id,
        name: t.name,
        asset_type: t.asset_type,
        color: t.color,
        sort_order: t.sort_order,
      })),
      stocks: q.getStocks.all(user.id),
      transactions: q.getTxDesc.all(user.id),
    });
  });

  app.post("/api/import", requireAuth, wrap(async (req, res) => {
    const user = currentUser(res);
    const backup = req.body && typeof req.body === "object" ? req.body : {};
    const backupUser = backup.user ?? {};
    const backupSettings = backup.settings ?? {};
    const stocks: any[] = Array.isArray(backup.stocks) ? backup.stocks : [];
    const transactions: any[] = Array.isArray(backup.transactions) ? backup.transactions : [];

    if (normalizeEmail(backupUser.email) === "") {
      throw new HttpError(400, "Backup inválido: usuário do backup não informado");
    }
    if (normalizeEmail(backupUser.email) !== user.email) {
      // A backup from another e-mail (e.g. before an e-mail change) is restored only
      // after the account owner confirms with the current password.
      const confirmPassword = typeof backup.confirmPassword === "string" ? backup.confirmPassword : "";
      if (!confirmPassword) {
        res.status(409).json({
          error: "Este backup é de outro e-mail. Confirme com a sua senha para restaurar.",
          code: "BACKUP_EMAIL_MISMATCH",
        });
        return;
      }
      await checkPassword(user, confirmPassword);
    }
    if (stocks.length > LIMITS.importStocksMax || transactions.length > LIMITS.importTransactionsMax) {
      throw new HttpError(400, "Backup too large");
    }

    let skipped = 0;

    db.transaction(() => {
      const finnhubKey = shortText(backupUser.finnhub_key, LIMITS.finnhubKeyMax);
      q.updateProfileFromBackup.run(
        shortText(backupUser.display_name, LIMITS.displayNameMax) || null,
        finnhubKey && isValidFinnhubKey(finnhubKey) ? finnhubKey : null, // null keeps the current key
        nowIso(),
        user.id
      );

      const existingSettings = q.getSettings.get(user.id) as { created_at?: string } | undefined;
      const port = Number(backupSettings.default_port);
      q.upsertSettings.run(
        user.id,
        Number.isInteger(port) && port >= 1 && port <= 65535 ? port : config.port,
        shortText(backupSettings.theme, 20) || "dark",
        shortText(backupSettings.currency, 10) || "USD",
        Number(backupSettings.include_secrets_in_backup) === 1 ? 1 : 0,
        existingSettings?.created_at || nowIso(),
        nowIso()
      );

      q.deleteAllTx.run(user.id);
      q.deleteAllStocks.run(user.id);
      q.deleteAllTabs.run(user.id);

      // Tabs from the backup (v0.8.0+); older backups have none and get default tabs below.
      const tabIdMap = new Map<number, { id: number; assetType: string }>();
      const backupTabs: any[] = Array.isArray(backup.tabs) ? backup.tabs.slice(0, 20) : [];
      for (const t of backupTabs) {
        const parsed = tabCreateSchema.safeParse({ name: t?.name, assetType: t?.asset_type, color: t?.color });
        if (!parsed.success || !Number.isSafeInteger(Number(t?.id))) continue;
        const order = (q.nextTabOrder.get(user.id) as { n: number }).n;
        const newId = Number(
          q.insertTab.run(user.id, parsed.data.name, parsed.data.assetType, parsed.data.color, order, nowIso()).lastInsertRowid
        );
        tabIdMap.set(Number(t.id), { id: newId, assetType: parsed.data.assetType });
      }

      const knownTickers = new Set<string>();
      for (const s of stocks) {
        const ticker = normalizeTicker(s?.ticker);
        const name = shortText(s?.name, LIMITS.stockNameMax);
        if (!isValidTicker(ticker) || !name || knownTickers.has(ticker)) {
          skipped++;
          continue;
        }
        const assetType = assetTypeOfTicker(ticker);
        const mapped = tabIdMap.get(Number(s?.tab_id));
        const tabId = mapped && mapped.assetType === assetType ? mapped.id : null; // null: default tab below
        q.insertStock.run(user.id, ticker, name, shortText(s?.created_at) || nowIso(), assetType, tabId);
        knownTickers.add(ticker);
      }

      const imported: PositionTx[] = [];
      let fallbackSortOrder = 1;
      for (const tr of transactions) {
        // Accepts numbers (backups from v0.4.x and older) or exact decimal strings (v0.5.0+).
        const parsed = transactionSchema.safeParse(tr ?? {});
        if (!parsed.success || !knownTickers.has(parsed.data.ticker)) {
          skipped++;
          continue;
        }
        const tx = parsed.data;
        const sortRaw = Number(tr?.sort_order);
        const sortOrder = Number.isSafeInteger(sortRaw) && sortRaw > 0 ? sortRaw : fallbackSortOrder;

        const info = insertTransaction(user.id, tx, shortText(tr?.created_at) || nowIso(), sortOrder);
        imported.push({
          id: Number(info.lastInsertRowid),
          ticker: tx.ticker,
          type: tx.type,
          shares: tx.shares,
          date: tx.date,
          sort_order: sortOrder,
        });
        fallbackSortOrder += 1;
      }

      const negative = findNegativePosition(imported);
      if (negative) {
        // Throwing inside the transaction rolls back the whole restore.
        throw new HttpError(400, `Backup inválido: posição negativa em ${negative}`);
      }

      // Assets without a valid tab (old backups) go to a default tab of their type.
      ensureDefaultTabs(db);
    })();

    res.json({
      success: true,
      skipped,
      user: getSafeUser(q.getUserById.get(user.id) as UserRow),
      settings: q.getSettings.get(user.id),
      tabs: (q.getTabs.all(user.id) as TabRow[]).map(tabDto),
      stocks: q.getStocks.all(user.id),
      transactions: q.getTxDesc.all(user.id),
    });
  }));

  // ---------------------------------------------------------------------------
  // Market data (Finnhub)
  // ---------------------------------------------------------------------------
  app.get(
    "/api/search",
    requireAuth,
    wrap(async (req, res) => {
      const query = String(req.query.q ?? req.query.ticker ?? req.query.symbol ?? "").trim();
      if (!query) throw new HttpError(400, "Missing query (q/ticker/symbol)");
      if (query.length > LIMITS.searchQueryMax) throw new HttpError(400, "Query too long");

      if (req.query.type === "crypto") {
        res.json(await searchCryptoAll(query, currentUser(res).massive_key));
        return;
      }

      const key = requireFinnhubKey(currentUser(res));
      const data = await finnhubFetch(
        `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${encodeURIComponent(key)}`
      );
      res.json(data);
    })
  );

  app.get(
    "/api/quote",
    requireAuth,
    wrap(async (req, res) => {
      const symbol = parseSymbol(req.query.symbol ?? req.query.ticker);
      const key = requireFinnhubKey(currentUser(res));
      const { raw, cacheHit, ttlMs } = await getQuoteCached(symbol, key, currentUser(res).massive_key);

      res.setHeader("X-Cache", cacheHit ? "HIT" : "MISS");
      res.setHeader("X-Cache-TTL-MS", String(ttlMs));
      res.json(toQuote(symbol, raw));
    })
  );

  app.get(
    "/api/prices",
    requireAuth,
    wrap(async (req, res) => {
      const parts = String(req.query.symbols ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (parts.length === 0) throw new HttpError(400, "Missing symbols (comma-separated)");
      if (parts.length > LIMITS.symbolsPerRequest) {
        throw new HttpError(400, `Too many symbols (max ${LIMITS.symbolsPerRequest})`);
      }

      const symbols = [...new Set(parts.map(parseSymbol))];
      const key = requireFinnhubKey(currentUser(res));

      const massiveKey = currentUser(res).massive_key;
      const settled = await Promise.allSettled(symbols.map((s) => getQuoteCached(s, key, massiveKey)));
      const results: Record<string, ReturnType<typeof toQuote>> = {};
      settled.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") {
          results[symbols[i]] = toQuote(symbols[i], outcome.value.raw);
        } else {
          console.error(`[prices] quote failed for ${symbols[i]}: ${outcome.reason?.message}`);
        }
      });

      res.json(results);
    })
  );

  // ---------------------------------------------------------------------------
  // Charts: historical candles (Massive) and key statistics (Finnhub)
  // ---------------------------------------------------------------------------
  app.get(
    "/api/candles",
    requireAuth,
    wrap(async (req, res) => {
      const user = currentUser(res);
      const symbol = parseSymbol(req.query.symbol);
      const range = String(req.query.range ?? "1A");
      try {
        const result = await candleService.getCandles({
          symbol,
          range,
          interval: req.query.interval ? String(req.query.interval) : undefined,
          apiKey: user.massive_key,
          alpaca: alpacaKeysOf(user),
          customFrom: req.query.from,
          customTo: req.query.to,
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ symbol, range, ...result });
      } catch (error) {
        if (error instanceof CandleError) {
          if (error.code) return res.status(error.status).json({ error: error.message, code: error.code });
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
    })
  );

  /** Daily history (all of it) for long-term indicators and crypto statistics. */
  async function dailyHistory(user: UserRow, symbol: string) {
    try {
      return await candleService.getCandles({
        symbol,
        range: "MAX",
        interval: "1D",
        apiKey: user.massive_key,
        alpaca: alpacaKeysOf(user),
      });
    } catch (error) {
      if (error instanceof CandleError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** USD -> BRL for the consolidated view: Coinbase (no key), cached 10 min; stale value if Coinbase fails. */
  let usdBrl: { rate: number; fetchedAt: string; expiresAt: number } | null = null;
  app.get(
    "/api/fx/usdbrl",
    requireAuth,
    wrap(async (_req, res) => {
      const now = Date.now();
      if (!usdBrl || usdBrl.expiresAt <= now) {
        try {
          const base = (process.env.COINBASE_RATES_URL?.trim() || "https://api.coinbase.com").replace(/\/+$/, "");
          const rate = await coinbaseUsdBrl(dataFetch, base);
          usdBrl = { rate, fetchedAt: new Date(now).toISOString(), expiresAt: now + 10 * 60_000 };
        } catch (error: any) {
          console.warn(`[fx] coinbase falhou (status ${Number(error?.status) || "-"})`);
          if (!usdBrl) throw new HttpError(502, "Não foi possível obter o câmbio agora. Tente de novo em instantes.");
          return res.json({ pair: "USDBRL", rate: usdBrl.rate, source: "coinbase", fetchedAt: usdBrl.fetchedAt, stale: true });
        }
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ pair: "USDBRL", rate: usdBrl.rate, source: "coinbase", fetchedAt: usdBrl.fetchedAt });
    })
  );

  app.get(
    "/api/indicators",
    requireAuth,
    wrap(async (req, res) => {
      const symbol = parseSymbol(req.query.symbol);
      const ids = String(req.query.ma ?? "")
        .split(",")
        .filter((id): id is MovingAverageId => (MOVING_AVERAGE_IDS as string[]).includes(id));
      if (ids.length === 0) throw new HttpError(400, "Informe as médias (ma=200D,200W,50M)");
      // Only points from `from` on are sent (the chart's first candle), keeping the answer small.
      const from = Number(req.query.from);
      const since = Number.isFinite(from) && from > 0 ? from - 40 * 86_400_000 : 0;

      const history = await dailyHistory(currentUser(res), symbol);
      const daily = history.candles.map((c) => ({ t: c.t, c: c.c }));
      const series: Record<string, SeriesPoint[]> = {};
      for (const id of ids) {
        series[id] = movingAverage(daily, id)
          .filter((p) => p.t >= since)
          .map((p) => ({ t: p.t, v: Math.round(p.v * 1e6) / 1e6 }));
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        symbol,
        source: history.source,
        firstDay: history.candles[0]?.t ?? null,
        days: history.candles.length,
        series,
      });
    })
  );

  app.get(
    "/api/stats",
    requireAuth,
    wrap(async (req, res) => {
      const symbol = parseSymbol(req.query.symbol);

      if (isCryptoTicker(symbol)) {
        const { candles, source } = await dailyHistory(currentUser(res), symbol);
        const last = candles.slice(-365);
        const hi = last.reduce((m, c) => (c.h > m.h ? c : m), last[0] ?? { h: NaN, t: 0 });
        const lo = last.reduce((m, c) => (c.l < m.l ? c : m), last[0] ?? { l: NaN, t: 0 });
        const avg = (n: number) => {
          const slice = last.slice(-n);
          return slice.length ? slice.reduce((sum, c) => sum + c.v, 0) / slice.length / 1e6 : null; // millions, like Finnhub
        };
        return res.json({
          symbol,
          high52w: last.length ? hi.h : null,
          high52wDate: last.length ? new Date(hi.t).toISOString().slice(0, 10) : null,
          low52w: last.length ? lo.l : null,
          low52wDate: last.length ? new Date(lo.t).toISOString().slice(0, 10) : null,
          avgVolume10d: avg(10),
          avgVolume3m: avg(90),
          marketCap: null,
          beta: null,
          source,
        });
      }

      const key = requireFinnhubKey(currentUser(res));

      const hit = statsCache.get(symbol);
      if (hit && hit.expiresAt > Date.now()) return res.json(hit.value);

      let raw: any;
      try {
        raw = await finnhubFetch(
          `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(key)}`
        );
      } catch {
        throw new HttpError(502, "Não foi possível buscar as estatísticas agora.");
      }
      const m = raw?.metric ?? {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const value = {
        symbol,
        high52w: num(m["52WeekHigh"]),
        high52wDate: typeof m["52WeekHighDate"] === "string" ? m["52WeekHighDate"] : null,
        low52w: num(m["52WeekLow"]),
        low52wDate: typeof m["52WeekLowDate"] === "string" ? m["52WeekLowDate"] : null,
        avgVolume10d: num(m["10DayAverageTradingVolume"]), // millions of shares
        avgVolume3m: num(m["3MonthAverageTradingVolume"]), // millions of shares
        marketCap: num(m["marketCapitalization"]), // millions of USD
        beta: num(m["beta"]),
      };
      statsCache.delete(symbol);
      if (statsCache.size >= 300) {
        const oldest = statsCache.keys().next().value;
        if (oldest !== undefined) statsCache.delete(oldest);
      }
      statsCache.set(symbol, { value, expiresAt: Date.now() + 6 * 60 * 60_000 });
      res.json(value);
    })
  );

  // Unknown API routes => JSON 404
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // ---------------------------------------------------------------------------
  // Error handler: generic message to the client, details only in the server log.
  // ---------------------------------------------------------------------------
  app.use(
    (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(err);

      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: "Request body too large" });
      }
      if (err?.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      console.error(`[error] ${req.method} ${req.path}: ${err?.message ?? err}`);
      res.status(500).json({ error: "Internal server error" });
    }
  );

  return app;
}
