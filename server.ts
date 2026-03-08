import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config -----
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = "nyse_tracker_session";

// ----- Database (absolute path) -----
const dbPath = path.join(__dirname, "portfolio.db");
const db = new Database(dbPath);

// Recommended pragmas
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

// -----------------------------
// Base schema (auth/session tables)
// -----------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    password_hash TEXT,
    recovery_key_hash TEXT,
    finnhub_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    default_port INTEGER,
    theme TEXT,
    currency TEXT,
    include_secrets_in_backup INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function tableHasColumn(tableName: string, columnName: string) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

// -----------------------------
// Ensure portfolio tables are user-scoped
// If old global tables still exist, reset them once.
// -----------------------------
function ensureUserScopedPortfolioTables() {
  const stocksExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='stocks'`)
    .get();
  const transactionsExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`)
    .get();

  const stocksScoped = stocksExists ? tableHasColumn("stocks", "user_id") : false;
  const transactionsScoped = transactionsExists ? tableHasColumn("transactions", "user_id") : false;

  if (!stocksExists || !transactionsExists || !stocksScoped || !transactionsScoped) {
    db.exec(`
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS stocks;

      CREATE TABLE stocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, ticker)
      );

      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
        shares REAL NOT NULL,
        price REAL NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id, ticker) REFERENCES stocks(user_id, ticker) ON DELETE CASCADE
      );
    `);
  }

  if (transactionsExists && !tableHasColumn("transactions", "sort_order")) {
    db.exec(`
      ALTER TABLE transactions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    `);

    db.exec(`
      UPDATE transactions
      SET sort_order = id
      WHERE sort_order IS NULL OR sort_order = 0;
    `);
  }
}

ensureUserScopedPortfolioTables();

// -----------------------------
// Prepared statements
// -----------------------------
const stmtGetStocks = db.prepare(`
  SELECT id, user_id, ticker, name, created_at
  FROM stocks
  WHERE user_id = ?
  ORDER BY ticker ASC
`);

const stmtInsertStock = db.prepare(`
  INSERT INTO stocks (user_id, ticker, name, created_at)
  VALUES (?, ?, ?, ?)
`);

const stmtDeleteStock = db.prepare(`
  DELETE FROM stocks
  WHERE user_id = ? AND ticker = ?
`);

const stmtDeleteAllStocksByUser = db.prepare(`
  DELETE FROM stocks
  WHERE user_id = ?
`);

const stmtDeleteTransactionsByTicker = db.prepare(`
  DELETE FROM transactions
  WHERE user_id = ? AND ticker = ?
`);

const stmtDeleteAllTransactionsByUser = db.prepare(`
  DELETE FROM transactions
  WHERE user_id = ?
`);

const stmtGetTransactionsAll = db.prepare(`
  SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order
  FROM transactions
  WHERE user_id = ?
  ORDER BY date ASC, sort_order ASC, id ASC
`);

const stmtGetTransactionsByTicker = db.prepare(`
  SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order
  FROM transactions
  WHERE user_id = ? AND ticker = ?
  ORDER BY date ASC, sort_order ASC, id ASC
`);

const stmtGetTransactionsDesc = db.prepare(`
  SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order
  FROM transactions
  WHERE user_id = ?
  ORDER BY date DESC, sort_order DESC, id DESC
`);

const stmtInsertTransaction = db.prepare(`
  INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtDeleteTransactionById = db.prepare(`
  DELETE FROM transactions
  WHERE user_id = ? AND id = ?
`);

const stmtGetStockByTicker = db.prepare(`
  SELECT id, user_id, ticker, name, created_at
  FROM stocks
  WHERE user_id = ? AND ticker = ?
`);

const stmtGetNextSortOrderForUser = db.prepare(`
  SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder
  FROM transactions
  WHERE user_id = ?
`);

const stmtSumSharesByType = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type='BUY' THEN shares ELSE 0 END), 0) AS buyShares,
    COALESCE(SUM(CASE WHEN type='SELL' THEN shares ELSE 0 END), 0) AS sellShares
  FROM transactions
  WHERE user_id = ? AND ticker = ?
`);

const stmtGetUserByEmail = db.prepare(`
  SELECT id, email, display_name, password_hash, recovery_key_hash, finnhub_key, created_at, updated_at, last_login_at
  FROM users
  WHERE email = ?
`);

const stmtGetUserById = db.prepare(`
  SELECT id, email, display_name, password_hash, recovery_key_hash, finnhub_key, created_at, updated_at, last_login_at
  FROM users
  WHERE id = ?
`);

const stmtInsertUser = db.prepare(`
  INSERT INTO users (email, display_name, password_hash, recovery_key_hash, finnhub_key, created_at, updated_at, last_login_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateUserProfileFromBackup = db.prepare(`
  UPDATE users
  SET display_name = ?, finnhub_key = ?, updated_at = ?
  WHERE id = ?
`);

const stmtInsertUserSettings = db.prepare(`
  INSERT INTO user_settings (user_id, default_port, theme, currency, include_secrets_in_backup, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetUserSettingsByUserId = db.prepare(`
  SELECT id, user_id, default_port, theme, currency, include_secrets_in_backup, created_at, updated_at
  FROM user_settings
  WHERE user_id = ?
`);

const stmtUpsertUserSettings = db.prepare(`
  INSERT INTO user_settings (user_id, default_port, theme, currency, include_secrets_in_backup, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    default_port = excluded.default_port,
    theme = excluded.theme,
    currency = excluded.currency,
    include_secrets_in_backup = excluded.include_secrets_in_backup,
    updated_at = excluded.updated_at
`);

const stmtInsertSession = db.prepare(`
  INSERT INTO sessions (user_id, session_token, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);

const stmtGetSessionByToken = db.prepare(`
  SELECT s.id, s.user_id, s.session_token, s.created_at, s.expires_at
  FROM sessions s
  WHERE s.session_token = ?
`);

const stmtDeleteSessionByToken = db.prepare(`
  DELETE FROM sessions
  WHERE session_token = ?
`);

const stmtUpdateLastLoginAt = db.prepare(`
  UPDATE users
  SET last_login_at = ?, updated_at = ?
  WHERE id = ?
`);

function normalizeTicker(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function badRequest(res: express.Response, msg: string) {
  return res.status(400).json({ error: msg });
}

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(cookieHeader?: string) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;

  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function getSessionTokenFromReq(req: express.Request) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

function setSessionCookie(res: express.Response, token: string) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (IS_PROD) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: express.Response) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (IS_PROD) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function getSafeUser(user: any) {
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

function getBackupUser(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    finnhub_key: user.finnhub_key,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
}

function getUserFromSession(req: express.Request) {
  const token = getSessionTokenFromReq(req);
  if (!token) return null;

  const session = stmtGetSessionByToken.get(token) as
    | { id: number; user_id: number; session_token: string; created_at: string; expires_at: string | null }
    | undefined;

  if (!session) return null;

  const user = stmtGetUserById.get(session.user_id);
  if (!user) return null;

  return { session, user };
}

function requireAuth(req: express.Request, res: express.Response) {
  const auth = getUserFromSession(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return auth;
}

function getFinnhubKeyForUser(user: any) {
  return user?.finnhub_key || process.env.FINNHUB_KEY || null;
}

// -----------------------------
// Finnhub helpers
// -----------------------------
async function finnhubFetchJson(url: string) {
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Finnhub HTTP ${r.status}: ${text || "Request failed"}`);
  }
  return r.json();
}

// -----------------------------
// Quote cache
// -----------------------------
type QuoteCacheEntry = {
  value: any;
  expiresAt: number;
};

const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS || 30_000);
const quoteCache = new Map<string, QuoteCacheEntry>();

async function fetchFinnhubQuote(symbol: string, apiKey: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(
    apiKey
  )}`;
  return finnhubFetchJson(url);
}

async function getQuoteCached(symbolInput: unknown, apiKey: string) {
  const symbol = normalizeTicker(symbolInput);

  if (!symbol) {
    throw new Error("Missing symbol");
  }

  const now = Date.now();
  const cached = quoteCache.get(symbol);

  if (cached && cached.expiresAt > now) {
    return {
      symbol,
      raw: cached.value,
      cacheHit: true,
      ttlMs: cached.expiresAt - now,
    };
  }

  const raw = await fetchFinnhubQuote(symbol, apiKey);

  quoteCache.set(symbol, {
    value: raw,
    expiresAt: now + QUOTE_CACHE_TTL_MS,
  });

  return {
    symbol,
    raw,
    cacheHit: false,
    ttlMs: QUOTE_CACHE_TTL_MS,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // -------------------------
  // API Routes (Auth)
  // -------------------------
  app.post("/api/auth/register", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const displayName = String(req.body?.displayName || "").trim() || null;
      const password = String(req.body?.password || "");
      const confirmPassword = String(req.body?.confirmPassword || "");

      if (!email) return badRequest(res, "Missing email");
      if (!email.includes("@")) return badRequest(res, "Invalid email");

      if (password !== confirmPassword) {
        return badRequest(res, "Password confirmation does not match");
      }

      const existing = stmtGetUserByEmail.get(email);
      if (existing) {
        return badRequest(res, "User already exists");
      }

      const timestamp = nowIso();
      const passwordHash = password ? await bcrypt.hash(password, 10) : null;

      const insertUserTx = db.transaction(() => {
        const userInfo = stmtInsertUser.run(
          email,
          displayName,
          passwordHash,
          null,
          null,
          timestamp,
          timestamp,
          null
        );

        const userId = Number(userInfo.lastInsertRowid);

        stmtInsertUserSettings.run(userId, PORT, "dark", "USD", 1, timestamp, timestamp);

        const sessionToken = uuidv4();
        stmtInsertSession.run(userId, sessionToken, timestamp, null);

        return { userId, sessionToken };
      });

      const { userId, sessionToken } = insertUserTx();
      const user = stmtGetUserById.get(userId);

      setSessionCookie(res, sessionToken);

      res.status(201).json({
        success: true,
        user: getSafeUser(user),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Register failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");

      if (!email) return badRequest(res, "Missing email");

      const user = stmtGetUserByEmail.get(email) as any;
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (user.password_hash) {
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
          return res.status(401).json({ error: "Invalid credentials" });
        }
      }

      const timestamp = nowIso();
      const sessionToken = uuidv4();

      stmtInsertSession.run(user.id, sessionToken, timestamp, null);
      stmtUpdateLastLoginAt.run(timestamp, timestamp, user.id);

      const updatedUser = stmtGetUserById.get(user.id);

      setSessionCookie(res, sessionToken);

      res.json({
        success: true,
        user: getSafeUser(updatedUser),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    try {
      const token = getSessionTokenFromReq(req);
      if (token) {
        stmtDeleteSessionByToken.run(token);
      }

      clearSessionCookie(res);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Logout failed" });
    }
  });

  app.get("/api/auth/me", (req, res) => {
    try {
      const auth = getUserFromSession(req);

      if (!auth) {
        return res.json({
          authenticated: false,
          user: null,
        });
      }

      res.json({
        authenticated: true,
        user: getSafeUser(auth.user),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to fetch current user" });
    }
  });

  // -------------------------
  // Save Finnhub API key
  // -------------------------
  app.post("/api/auth/finnhub-key", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const apiKey = String(req.body?.apiKey || "").trim();

    if (!apiKey) {
      return res.status(400).json({ error: "Missing API key" });
    }

    try {
      db.prepare(`
        UPDATE users
        SET finnhub_key = ?, updated_at = ?
        WHERE id = ?
      `).run(apiKey, nowIso(), auth.user.id);

      const updatedUser = stmtGetUserById.get(auth.user.id);

      res.json({
        success: true,
        user: getSafeUser(updatedUser),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to save API key" });
    }
  });

  // -------------------------
  // API Routes (Portfolio CRUD)
  // -------------------------
  app.get("/api/stocks", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const stocks = stmtGetStocks.all(auth.user.id);
    res.json(stocks);
  });

  app.post("/api/stocks", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const ticker = normalizeTicker(req.body?.ticker);
    const name = String(req.body?.name || "").trim();

    if (!ticker) return badRequest(res, "Missing ticker");
    if (!name) return badRequest(res, "Missing name");

    try {
      stmtInsertStock.run(auth.user.id, ticker, name, nowIso());
      res.status(201).json({ ticker, name });
    } catch {
      res.status(400).json({ error: "Stock already exists or invalid data" });
    }
  });

  app.delete("/api/stocks/:ticker", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const ticker = normalizeTicker(req.params.ticker);
    if (!ticker) return badRequest(res, "Invalid ticker");

    stmtDeleteTransactionsByTicker.run(auth.user.id, ticker);
    stmtDeleteStock.run(auth.user.id, ticker);

    res.status(204).send();
  });

  // -------------------------
  // API Routes (Transactions)
  // -------------------------
  app.get("/api/transactions", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const ticker = req.query.ticker ? normalizeTicker(req.query.ticker) : "";
    const order = String(req.query.order || "").toLowerCase();

    if (ticker) {
      const rows = stmtGetTransactionsByTicker.all(auth.user.id, ticker);
      return res.json(rows);
    }

    if (order === "desc") {
      const rows = stmtGetTransactionsDesc.all(auth.user.id);
      return res.json(rows);
    }

    const rows = stmtGetTransactionsAll.all(auth.user.id);
    return res.json(rows);
  });

  app.post("/api/transactions", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const ticker = normalizeTicker(req.body?.ticker);
    const type = String(req.body?.type || "")
      .trim()
      .toUpperCase();
    const shares = Number(req.body?.shares);
    const price = Number(req.body?.price);
    const date = String(req.body?.date || "").trim();

    if (!ticker) return badRequest(res, "Missing ticker");
    if (type !== "BUY" && type !== "SELL") return badRequest(res, "Invalid type (BUY/SELL)");
    if (!Number.isFinite(shares) || shares <= 0) return badRequest(res, "Invalid shares");
    if (!Number.isFinite(price) || price <= 0) return badRequest(res, "Invalid price");
    if (!date) return badRequest(res, "Missing date");

    const exists = stmtGetStockByTicker.get(auth.user.id, ticker);
    if (!exists) return badRequest(res, "Ticker not found in portfolio. Add the stock first.");

    if (type === "SELL") {
      const sums = stmtSumSharesByType.get(auth.user.id, ticker) as { buyShares: number; sellShares: number };
      const held = (sums?.buyShares || 0) - (sums?.sellShares || 0);

      if (shares > held + 1e-9) {
        return badRequest(res, `Cannot SELL ${shares}. Current held shares: ${held}. (No short allowed)`);
      }
    }

    try {
      const row = stmtGetNextSortOrderForUser.get(auth.user.id) as { nextSortOrder: number };
      const nextSortOrder = Number(row?.nextSortOrder || 1);

      const info = stmtInsertTransaction.run(
        auth.user.id,
        ticker,
        type,
        shares,
        price,
        date,
        nowIso(),
        nextSortOrder
      );

      res.status(201).json({ success: true, id: info.lastInsertRowid });
    } catch {
      res.status(400).json({ error: "Invalid transaction data" });
    }
  });

  app.delete("/api/transactions/:id", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const idNum = Number(req.params.id);
    if (!Number.isInteger(idNum)) return badRequest(res, "Invalid id");

    stmtDeleteTransactionById.run(auth.user.id, idNum);
    res.status(204).send();
  });

  // -------------------------
  // API Routes (Import/Export)
  // -------------------------
  app.get("/api/export", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const settings = stmtGetUserSettingsByUserId.get(auth.user.id);
    const stocks = stmtGetStocks.all(auth.user.id);
    const transactions = stmtGetTransactionsDesc.all(auth.user.id);
    const includeSecrets = Number(settings?.include_secrets_in_backup ?? 1) === 1;

    const backupUser = includeSecrets
      ? getBackupUser(auth.user)
      : {
          id: auth.user.id,
          email: auth.user.email,
          display_name: auth.user.display_name,
          finnhub_key: null,
          created_at: auth.user.created_at,
          updated_at: auth.user.updated_at,
          last_login_at: auth.user.last_login_at,
        };

    res.json({
      app: "NYSE Stock Portfolio Tracker",
      version: 1,
      exportedAt: nowIso(),
      user: backupUser,
      settings,
      stocks,
      transactions,
    });
  });

  app.post("/api/import", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const backup = req.body || {};
    const backupUser = backup?.user || {};
    const backupSettings = backup?.settings || {};
    const stocks = Array.isArray(backup?.stocks) ? backup.stocks : [];
    const transactions = Array.isArray(backup?.transactions) ? backup.transactions : [];

    const backupEmail = normalizeEmail(backupUser?.email);
    const currentUserEmail = normalizeEmail(auth.user?.email);

    if (!backupEmail) {
      return res.status(400).json({ error: "Backup inválido: usuário do backup não informado" });
    }

    if (backupEmail !== currentUserEmail) {
      return res.status(403).json({
        error: "Este backup pertence a outro usuário e não pode ser restaurado nesta conta",
      });
    }

    try {
      const restoreTx = db.transaction(() => {
        // Restore user-level editable fields only
        const displayNameRaw = typeof backupUser?.display_name === "string" ? backupUser.display_name.trim() : "";
        const finnhubKeyRaw = typeof backupUser?.finnhub_key === "string" ? backupUser.finnhub_key.trim() : "";

        stmtUpdateUserProfileFromBackup.run(
          displayNameRaw || null,
          finnhubKeyRaw || null,
          nowIso(),
          auth.user.id
        );

        // Restore settings
        const existingSettings = stmtGetUserSettingsByUserId.get(auth.user.id) as any;
        const settingsCreatedAt = existingSettings?.created_at || nowIso();

        stmtUpsertUserSettings.run(
          auth.user.id,
          Number.isFinite(Number(backupSettings?.default_port)) ? Number(backupSettings.default_port) : PORT,
          typeof backupSettings?.theme === "string" && backupSettings.theme.trim()
            ? backupSettings.theme.trim()
            : "dark",
          typeof backupSettings?.currency === "string" && backupSettings.currency.trim()
            ? backupSettings.currency.trim()
            : "USD",
          Number(backupSettings?.include_secrets_in_backup ?? 1) === 1 ? 1 : 0,
          settingsCreatedAt,
          nowIso()
        );

        // Replace portfolio entirely
        stmtDeleteAllTransactionsByUser.run(auth.user.id);
        stmtDeleteAllStocksByUser.run(auth.user.id);

        for (const s of stocks) {
          const ticker = normalizeTicker(s?.ticker);
          const name = String(s?.name || "").trim();
          const createdAt = String(s?.created_at || nowIso()).trim();

          if (!ticker || !name) continue;

          stmtInsertStock.run(auth.user.id, ticker, name, createdAt || nowIso());
        }

        let fallbackSortOrder = 1;

        for (const tr of transactions) {
          const ticker = normalizeTicker(tr?.ticker);
          const type = String(tr?.type || "").trim().toUpperCase();
          const shares = Number(tr?.shares);
          const price = Number(tr?.price);
          const date = String(tr?.date || "").trim();
          const createdAt = String(tr?.created_at || nowIso()).trim();
          const sortOrderRaw = Number(tr?.sort_order);
          const sortOrder =
            Number.isFinite(sortOrderRaw) && sortOrderRaw > 0 ? sortOrderRaw : fallbackSortOrder;

          if (
            !ticker ||
            (type !== "BUY" && type !== "SELL") ||
            !Number.isFinite(shares) ||
            shares <= 0 ||
            !Number.isFinite(price) ||
            price <= 0 ||
            !date
          ) {
            continue;
          }

          const exists = stmtGetStockByTicker.get(auth.user.id, ticker);
          if (!exists) continue;

          stmtInsertTransaction.run(
            auth.user.id,
            ticker,
            type,
            shares,
            price,
            date,
            createdAt || nowIso(),
            sortOrder
          );

          fallbackSortOrder += 1;
        }
      });

      restoreTx();

      const updatedUser = stmtGetUserById.get(auth.user.id);
      const updatedSettings = stmtGetUserSettingsByUserId.get(auth.user.id);
      const updatedStocks = stmtGetStocks.all(auth.user.id);
      const updatedTransactions = stmtGetTransactionsDesc.all(auth.user.id);

      res.json({
        success: true,
        user: getSafeUser(updatedUser),
        settings: updatedSettings,
        stocks: updatedStocks,
        transactions: updatedTransactions,
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Failed to import data" });
    }
  });

  // -------------------------
  // API Routes (Market Data via Finnhub)
  // -------------------------
  app.get("/api/search", async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;

      const qRaw = (req.query.q ?? req.query.ticker ?? req.query.symbol) as unknown;
      const q = String(qRaw || "").trim();

      if (!q) return badRequest(res, "Missing query (q/ticker/symbol)");

      const key = getFinnhubKeyForUser(auth.user);
      if (!key) {
        return res.status(400).json({ error: "Missing Finnhub API key" });
      }

      const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(key)}`;
      const data = await finnhubFetchJson(url);

      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Search failed" });
    }
  });

  app.get("/api/quote", async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;

      const key = getFinnhubKeyForUser(auth.user);
      if (!key) {
        return res.status(400).json({ error: "Missing Finnhub API key" });
      }

      const { symbol, raw, cacheHit, ttlMs } = await getQuoteCached(req.query.symbol ?? req.query.ticker, key);

      res.setHeader("X-Cache", cacheHit ? "HIT" : "MISS");
      res.setHeader("X-Cache-TTL-MS", String(ttlMs));

      res.json({
        symbol,
        price: raw?.c ?? null,
        change: raw?.d ?? null,
        changePct: raw?.dp ?? null,
        high: raw?.h ?? null,
        low: raw?.l ?? null,
        open: raw?.o ?? null,
        prevClose: raw?.pc ?? null,
        raw,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Quote failed" });
    }
  });

  app.get("/api/prices", async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;

      const key = getFinnhubKeyForUser(auth.user);
      if (!key) {
        return res.status(400).json({ error: "Missing Finnhub API key" });
      }

      const symbolsParam = String(req.query.symbols || "").trim();
      if (!symbolsParam) return badRequest(res, "Missing symbols (comma-separated)");

      const symbols = symbolsParam
        .split(",")
        .map((s) => normalizeTicker(s))
        .filter(Boolean);

      if (symbols.length === 0) return badRequest(res, "No valid symbols");

      const results: Record<string, any> = {};

      await Promise.all(
        symbols.map(async (sym) => {
          const { symbol, raw } = await getQuoteCached(sym, key);

          results[symbol] = {
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
        })
      );

      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Prices failed" });
    }
  });

  // -------------------------
  // IMPORTANT: Unknown /api routes => JSON 404
  // -------------------------
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "API route not found", path: req.originalUrl });
  });

  // -------------------------
  // Vite middleware for development
  // -------------------------
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));

    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});