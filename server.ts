import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config -----
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === "production";

// ----- Database (absolute path) -----
const dbPath = path.join(__dirname, "portfolio.db");
const db = new Database(dbPath);

// Recommended pragmas
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

// Initialize Database
db.exec(`
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

// Prepared statements
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

function normalizeTicker(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function badRequest(res: express.Response, msg: string) {
  return res.status(400).json({ error: msg });
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ----- Finnhub helpers -----
async function finnhubFetchJson(url: string) {
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Finnhub HTTP ${r.status}: ${text || "Request failed"}`);
  }
  return r.json();
}

// ----- Quote cache -----
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