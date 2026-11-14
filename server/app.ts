import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { z } from "zod";
import type { AppConfig } from "./config";
import type { DB } from "./db";
import { parsePositiveDecimal } from "../shared/decimal";
import {
  deleteAccountSchema,
  finnhubKeySchema,
  firstIssue,
  loginSchema,
  registerSchema,
  stockSchema,
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
  deps: { finnhubFetch?: FinnhubFetch } = {}
) {
  const finnhubFetch = deps.finnhubFetch ?? defaultFinnhubFetch;

  // ---------------------------------------------------------------------------
  // Prepared statements (all parameterized, all scoped by user_id)
  // ---------------------------------------------------------------------------
  const q = {
    getStocks: db.prepare(
      `SELECT id, ticker, name, created_at FROM stocks WHERE user_id = ? ORDER BY ticker ASC`
    ),
    getStock: db.prepare(`SELECT id FROM stocks WHERE user_id = ? AND ticker = ?`),
    insertStock: db.prepare(`INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (?, ?, ?, ?)`),
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

  async function getQuoteCached(symbol: string, apiKey: string) {
    const now = Date.now();
    const cached = quoteCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      return { raw: cached.value, cacheHit: true, ttlMs: cached.expiresAt - now };
    }

    const raw = await finnhubFetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`
    );

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

  app.get("/api/auth/me", (req, res) => {
    const auth = getAuth(req);
    res.json({
      authenticated: !!auth,
      user: getSafeUser(auth?.user),
      registrationEnabled: config.allowRegistration,
    });
  });

  app.post("/api/auth/finnhub-key", requireAuth, (req, res) => {
    const user = currentUser(res);
    const { apiKey } = parseBody(finnhubKeySchema, req.body);

    q.updateFinnhubKey.run(apiKey, nowIso(), user.id);
    res.json({ success: true, user: getSafeUser(q.getUserById.get(user.id) as UserRow) });
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
    const { ticker, name } = parseBody(stockSchema, req.body);
    if (q.getStock.get(user.id, ticker)) throw new HttpError(400, "Stock already exists");

    q.insertStock.run(user.id, ticker, name, nowIso());
    res.status(201).json({ ticker, name });
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
      app: "NYSE Stock Portfolio Tracker",
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
      stocks: q.getStocks.all(user.id),
      transactions: q.getTxDesc.all(user.id),
    });
  });

  app.post("/api/import", requireAuth, (req, res) => {
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
      throw new HttpError(403, "Este backup pertence a outro usuário e não pode ser restaurado nesta conta");
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

      const knownTickers = new Set<string>();
      for (const s of stocks) {
        const ticker = normalizeTicker(s?.ticker);
        const name = shortText(s?.name, LIMITS.stockNameMax);
        if (!isValidTicker(ticker) || !name || knownTickers.has(ticker)) {
          skipped++;
          continue;
        }
        q.insertStock.run(user.id, ticker, name, shortText(s?.created_at) || nowIso());
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
    })();

    res.json({
      success: true,
      skipped,
      user: getSafeUser(q.getUserById.get(user.id) as UserRow),
      settings: q.getSettings.get(user.id),
      stocks: q.getStocks.all(user.id),
      transactions: q.getTxDesc.all(user.id),
    });
  });

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
      const { raw, cacheHit, ttlMs } = await getQuoteCached(symbol, key);

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

      const settled = await Promise.allSettled(symbols.map((s) => getQuoteCached(s, key)));
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
