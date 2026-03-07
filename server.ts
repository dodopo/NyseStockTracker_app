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
// Database schema
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

  CREATE TABLE IF NOT EXISTS stocks (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    type TEXT CHECK(type IN ('BUY', 'SELL')) NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    date TEXT NOT NULL,
    FOREIGN KEY (ticker) REFERENCES stocks(ticker)
  );
`);

// -----------------------------
// Prepared statements
// -----------------------------
const stmtGetStocks = db.prepare("SELECT * FROM stocks ORDER BY ticker ASC");
const stmtInsertStock = db.prepare("INSERT INTO stocks (ticker, name) VALUES (?, ?)");
const stmtDeleteStock = db.prepare("DELETE FROM stocks WHERE ticker = ?");
const stmtDeleteTransactionsByTicker = db.prepare("DELETE FROM transactions WHERE ticker = ?");
const stmtGetTransactionsAll = db.prepare("SELECT * FROM transactions ORDER BY date ASC, id ASC");
const stmtGetTransactionsByTicker = db.prepare(
  "SELECT * FROM transactions WHERE ticker = ? ORDER BY date ASC, id ASC"
);
const stmtGetTransactionsDesc = db.prepare("SELECT * FROM transactions ORDER BY date DESC, id DESC");
const stmtInsertTransaction = db.prepare(
  "INSERT INTO transactions (ticker, type, shares, price, date) VALUES (?, ?, ?, ?, ?)"
);
const stmtDeleteTransactionById = db.prepare("DELETE FROM transactions WHERE id = ?");
const stmtGetStockByTicker = db.prepare("SELECT ticker FROM stocks WHERE ticker = ?");

const stmtSumSharesByType = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type='BUY' THEN shares ELSE 0 END), 0) AS buyShares,
    COALESCE(SUM(CASE WHEN type='SELL' THEN shares ELSE 0 END), 0) AS sellShares
  FROM transactions
  WHERE ticker = ?
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

const stmtInsertUserSettings = db.prepare(`
  INSERT INTO user_settings (user_id, default_port, theme, currency, include_secrets_in_backup, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
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

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

async function fetchFinnhubQuote(symbol: string) {
  const key = requireEnv("FINNHUB_KEY");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(
    key
  )}`;
  return finnhubFetchJson(url);
}

async function getQuoteCached(symbolInput: unknown) {
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

  const raw = await fetchFinnhubQuote(symbol);

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
  app.use(express.json());

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

        stmtInsertUserSettings.run(
          userId,
          PORT,
          "dark",
          "USD",
          1,
          timestamp,
          timestamp
        );

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
  // API Routes (Portfolio CRUD)
  // -------------------------
  app.get("/api/stocks", (req, res) => {
    const stocks = stmtGetStocks.all();
    res.json(stocks);
  });

  app.post("/api/stocks", (req, res) => {
    const ticker = normalizeTicker(req.body?.ticker);
    const name = String(req.body?.name || "").trim();

    if (!ticker) return badRequest(res, "Missing ticker");
    if (!name) return badRequest(res, "Missing name");

    try {
      stmtInsertStock.run(ticker, name);
      res.status(201).json({ ticker, name });
    } catch {
      res.status(400).json({ error: "Stock already exists or invalid data" });
    }
  });

  app.delete("/api/stocks/:ticker", (req, res) => {
    const ticker = normalizeTicker(req.params.ticker);
    if (!ticker) return badRequest(res, "Invalid ticker");

    stmtDeleteTransactionsByTicker.run(ticker);
    stmtDeleteStock.run(ticker);

    res.status(204).send();
  });

  // -------------------------
  // API Routes (Transactions)
  // -------------------------
  app.get("/api/transactions", (req, res) => {
    const ticker = req.query.ticker ? normalizeTicker(req.query.ticker) : "";
    const order = String(req.query.order || "").toLowerCase();

    if (ticker) {
      const rows = stmtGetTransactionsByTicker.all(ticker);
      return res.json(rows);
    }

    if (order === "desc") {
      const rows = stmtGetTransactionsDesc.all();
      return res.json(rows);
    }

    const rows = stmtGetTransactionsAll.all();
    return res.json(rows);
  });

  app.post("/api/transactions", (req, res) => {
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

    const exists = stmtGetStockByTicker.get(ticker);
    if (!exists) return badRequest(res, "Ticker not found in portfolio. Add the stock first.");

    if (type === "SELL") {
      const sums = stmtSumSharesByType.get(ticker) as { buyShares: number; sellShares: number };
      const held = (sums?.buyShares || 0) - (sums?.sellShares || 0);

      if (shares > held + 1e-9) {
        return badRequest(res, `Cannot SELL ${shares}. Current held shares: ${held}. (No short allowed)`);
      }
    }

    try {
      const info = stmtInsertTransaction.run(ticker, type, shares, price, date);
      res.status(201).json({ success: true, id: info.lastInsertRowid });
    } catch {
      res.status(400).json({ error: "Invalid transaction data" });
    }
  });

  app.delete("/api/transactions/:id", (req, res) => {
    const idNum = Number(req.params.id);
    if (!Number.isInteger(idNum)) return badRequest(res, "Invalid id");

    stmtDeleteTransactionById.run(idNum);
    res.status(204).send();
  });

  // -------------------------
  // API Routes (Import/Export)
  // -------------------------
  app.get("/api/export", (req, res) => {
    const stocks = stmtGetStocks.all();
    const transactions = stmtGetTransactionsDesc.all();
    res.json({ stocks, transactions });
  });

  app.post("/api/import", (req, res) => {
    const stocks = Array.isArray(req.body?.stocks) ? req.body.stocks : [];
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];

    try {
      const insertStock = db.prepare("INSERT OR IGNORE INTO stocks (ticker, name) VALUES (?, ?)");
      const insertTrans = db.prepare(
        "INSERT INTO transactions (ticker, type, shares, price, date) VALUES (?, ?, ?, ?, ?)"
      );

      const tx = db.transaction(() => {
        for (const s of stocks) {
          const t = normalizeTicker(s?.ticker);
          const n = String(s?.name || "").trim();
          if (t && n) insertStock.run(t, n);
        }

        for (const tr of transactions) {
          const t = normalizeTicker(tr?.ticker);
          const ty = String(tr?.type || "")
            .trim()
            .toUpperCase();
          const sh = Number(tr?.shares);
          const pr = Number(tr?.price);
          const dt = String(tr?.date || "").trim();

          if (
            !t ||
            (ty !== "BUY" && ty !== "SELL") ||
            !Number.isFinite(sh) ||
            sh <= 0 ||
            !Number.isFinite(pr) ||
            pr <= 0 ||
            !dt
          ) {
            continue;
          }

          insertTrans.run(t, ty, sh, pr, dt);
        }
      });

      tx();
      res.json({ success: true });
    } catch {
      res.status(400).json({ error: "Failed to import data" });
    }
  });

  // -------------------------
  // API Routes (Market Data via Finnhub)
  // -------------------------
  app.get("/api/search", async (req, res) => {
    try {
      const qRaw = (req.query.q ?? req.query.ticker ?? req.query.symbol) as unknown;
      const q = String(qRaw || "").trim();

      if (!q) return badRequest(res, "Missing query (q/ticker/symbol)");

      const key = requireEnv("FINNHUB_KEY");
      const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(key)}`;
      const data = await finnhubFetchJson(url);

      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Search failed" });
    }
  });

  app.get("/api/quote", async (req, res) => {
    try {
      const { symbol, raw, cacheHit, ttlMs } = await getQuoteCached(req.query.symbol ?? req.query.ticker);

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
          const { symbol, raw } = await getQuoteCached(sym);

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