import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { decimalFromLegacyNumber } from "../shared/decimal";

export type DB = Database.Database;

function tableExists(db: DB, name: string) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function tableHasColumn(db: DB, table: string, column: string) {
  // Table names below are constants defined in this file, never user input.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/**
 * Versioned migrations tracked with PRAGMA user_version.
 * Rule: never lose user data. A table that holds user data is only rebuilt
 * (create new, copy, verify, drop old, rename) when SQLite cannot change it in
 * place, inside ONE transaction that also verifies every copied row and the
 * foreign keys before committing; those migrations set `rebuild: true`.
 * The sessions table (disposable login tokens) may simply be recreated.
 */
type Migration = { version: number; rebuild?: boolean; up: (db: DB) => void };

/** Fails the migration (and rolls it back) unless both queries return the same rows. */
function assertSameRows(db: DB, what: string, oldSql: string, newSql: string) {
  const missing = db.prepare(`SELECT COUNT(*) AS n FROM (${oldSql} EXCEPT ${newSql})`).get() as { n: number };
  const extra = db.prepare(`SELECT COUNT(*) AS n FROM (${newSql} EXCEPT ${oldSql})`).get() as { n: number };
  const oldCount = db.prepare(`SELECT COUNT(*) AS n FROM (${oldSql})`).get() as { n: number };
  const newCount = db.prepare(`SELECT COUNT(*) AS n FROM (${newSql})`).get() as { n: number };
  if (missing.n || extra.n || oldCount.n !== newCount.n) {
    throw new Error(
      `Migration check failed for ${what}: ${oldCount.n} rows before, ${newCount.n} after, ${missing.n} missing, ${extra.n} unexpected`
    );
  }
}

function sequenceOf(db: DB, table: string) {
  const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(table) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

const MIGRATIONS: Migration[] = [
  {
    // v1 = baseline schema of v0.2.0 (created if missing, adopted if present).
    version: 1,
    up: (db) => {
      if (tableExists(db, "stocks") && !tableHasColumn(db, "stocks", "user_id")) {
        throw new Error(
          "Database from a version older than v0.2.0 detected (stocks without user_id). " +
            "Automatic migration is not supported. Start with a new DATA_DIR or migrate manually."
        );
      }

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
          include_secrets_in_backup INTEGER NOT NULL DEFAULT 0,
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE (user_id, ticker)
        );

        CREATE TABLE IF NOT EXISTS transactions (
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

      if (!tableHasColumn(db, "transactions", "sort_order")) {
        db.exec(`ALTER TABLE transactions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;`);
        db.exec(`UPDATE transactions SET sort_order = id WHERE sort_order = 0;`);
      }
    },
  },
  {
    // v2 = v0.3.0 security hardening.
    version: 2,
    up: (db) => {
      // Sessions now store only a SHA-256 hash of the token and always expire.
      // Old sessions are disposable: everyone simply logs in again.
      db.exec(`
        DROP TABLE IF EXISTS sessions;

        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_user_ticker ON transactions(user_id, ticker);
      `);

      // The old default put the Finnhub key inside every backup file.
      db.exec(`UPDATE user_settings SET include_secrets_in_backup = 0;`);
    },
  },
  {
    // v3 = v0.5.0 exact decimals. Canonical values live in TEXT columns
    // (shares_dec, price_dec). The legacy REAL columns are kept and still
    // written, so rolling back to v0.4.x keeps working on the same database.
    version: 3,
    up: (db) => {
      if (!tableHasColumn(db, "transactions", "shares_dec")) {
        db.exec(`ALTER TABLE transactions ADD COLUMN shares_dec TEXT;`);
      }
      if (!tableHasColumn(db, "transactions", "price_dec")) {
        db.exec(`ALTER TABLE transactions ADD COLUMN price_dec TEXT;`);
      }
    },
  },
  {
    // v4 = v0.7.0 charts: each user's own Massive key (historical candles). Additive.
    version: 4,
    up: (db) => {
      if (!tableHasColumn(db, "users", "massive_key")) {
        db.exec(`ALTER TABLE users ADD COLUMN massive_key TEXT;`);
      }
    },
  },
  {
    // v5 = v0.8.0 multi-asset: user-defined tabs, each bound to an asset type. Additive:
    // existing assets go to an automatic "Ações" tab (see ensureDefaultTabs).
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tabs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('us_stock', 'crypto')),
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tabs_user ON tabs(user_id, sort_order);
      `);
      if (!tableHasColumn(db, "stocks", "asset_type")) {
        db.exec(`ALTER TABLE stocks ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'us_stock';`);
      }
      if (!tableHasColumn(db, "stocks", "tab_id")) {
        db.exec(`ALTER TABLE stocks ADD COLUMN tab_id INTEGER REFERENCES tabs(id) ON DELETE SET NULL;`);
      }
    },
  },
  {
    // v6 = v0.9.0 better chart data: each user's own Alpaca key (US stocks candles). Additive.
    version: 6,
    up: (db) => {
      if (!tableHasColumn(db, "users", "alpaca_key_id")) db.exec(`ALTER TABLE users ADD COLUMN alpaca_key_id TEXT;`);
      if (!tableHasColumn(db, "users", "alpaca_secret")) db.exec(`ALTER TABLE users ADD COLUMN alpaca_secret TEXT;`);
    },
  },
  {
    // v7 = v0.13.0 portfolios: one login, many portfolios. Tabs, assets and trades
    // now belong to a portfolio, and the same ticker may exist in different
    // portfolios. SQLite cannot change UNIQUE/foreign keys in place, so tabs,
    // stocks and transactions are rebuilt (see the rule above). Every user gets
    // a "Carteira principal" holding everything they had. Ids are kept.
    version: 7,
    rebuild: true,
    up: (db) => {
      const now = new Date().toISOString();
      db.exec(`
        CREATE TABLE portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE (user_id, name)
        );
        CREATE INDEX idx_portfolios_user ON portfolios(user_id, sort_order);

        CREATE TABLE tabs_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('us_stock', 'crypto')),
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
        );

        CREATE TABLE stocks_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          asset_type TEXT NOT NULL DEFAULT 'us_stock',
          tab_id INTEGER REFERENCES tabs(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE,
          UNIQUE (portfolio_id, ticker)
        );

        CREATE TABLE transactions_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
          shares REAL NOT NULL,
          price REAL NOT NULL,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          shares_dec TEXT,
          price_dec TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE,
          FOREIGN KEY (portfolio_id, ticker) REFERENCES stocks(portfolio_id, ticker) ON DELETE CASCADE
        );
      `);

      db.prepare(
        `INSERT INTO portfolios (user_id, name, color, sort_order, created_at, updated_at)
         SELECT id, 'Carteira principal', '#2962ff', 1, ?, ? FROM users ORDER BY id`
      ).run(now, now);

      // One portfolio per user at this point: everything goes to it.
      db.exec(`
        INSERT INTO tabs_v7 (id, user_id, portfolio_id, name, asset_type, color, sort_order, created_at)
          SELECT t.id, t.user_id, p.id, t.name, t.asset_type, t.color, t.sort_order, t.created_at
          FROM tabs t JOIN portfolios p ON p.user_id = t.user_id;
        INSERT INTO stocks_v7 (id, user_id, portfolio_id, ticker, name, created_at, asset_type, tab_id)
          SELECT s.id, s.user_id, p.id, s.ticker, s.name, s.created_at, s.asset_type, s.tab_id
          FROM stocks s JOIN portfolios p ON p.user_id = s.user_id;
        INSERT INTO transactions_v7
          (id, user_id, portfolio_id, ticker, type, shares, price, date, created_at, sort_order, shares_dec, price_dec)
          SELECT t.id, t.user_id, p.id, t.ticker, t.type, t.shares, t.price, t.date, t.created_at, t.sort_order,
                 t.shares_dec, t.price_dec
          FROM transactions t JOIN portfolios p ON p.user_id = t.user_id;
      `);

      // Every row, every column, before anything old is dropped.
      assertSameRows(
        db,
        "tabs",
        `SELECT id, user_id, name, asset_type, color, sort_order, created_at FROM tabs`,
        `SELECT id, user_id, name, asset_type, color, sort_order, created_at FROM tabs_v7`
      );
      assertSameRows(
        db,
        "stocks",
        `SELECT id, user_id, ticker, name, created_at, asset_type, tab_id FROM stocks`,
        `SELECT id, user_id, ticker, name, created_at, asset_type, tab_id FROM stocks_v7`
      );
      assertSameRows(
        db,
        "transactions",
        `SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order, shares_dec, price_dec FROM transactions`,
        `SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order, shares_dec, price_dec FROM transactions_v7`
      );

      // Keep the id counters, so ids of deleted rows are never reused.
      const seq = { tabs: sequenceOf(db, "tabs"), stocks: sequenceOf(db, "stocks"), transactions: sequenceOf(db, "transactions") };

      db.exec(`
        DROP TABLE transactions;
        DROP TABLE stocks;
        DROP TABLE tabs;
        ALTER TABLE tabs_v7 RENAME TO tabs;
        ALTER TABLE stocks_v7 RENAME TO stocks;
        ALTER TABLE transactions_v7 RENAME TO transactions;
        CREATE INDEX idx_tabs_portfolio ON tabs(portfolio_id, sort_order);
        CREATE INDEX idx_stocks_user ON stocks(user_id);
        CREATE INDEX idx_transactions_portfolio_ticker ON transactions(portfolio_id, ticker);
        CREATE INDEX idx_transactions_user ON transactions(user_id);
      `);

      const keepSeq = db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`);
      for (const [table, value] of Object.entries(seq)) keepSeq.run(value, table);
    },
  },
  {
    // v8 = v0.14.0 classifications and currencies. Only ADDS columns (no rebuild):
    // an older version still reads and writes these tables (new columns get
    // their defaults; trades without PTAX are filled in later).
    // Allowed values are written out here on purpose: a migration never changes,
    // even if shared/classification.ts or shared/currencies.ts grow later.
    version: 8,
    up: (db) => {
      const currencies = `('BRL', 'USD', 'EUR', 'CHF')`;
      db.exec(`
        ALTER TABLE stocks ADD COLUMN liquidity TEXT NOT NULL DEFAULT 'liquid'
          CHECK (liquidity IN ('liquid', 'illiquid'));
        ALTER TABLE stocks ADD COLUMN horizon TEXT
          CHECK (horizon IS NULL OR horizon IN ('ultra_short', 'short', 'medium', 'long', 'ultra_long'));
        ALTER TABLE stocks ADD COLUMN jurisdiction TEXT
          CHECK (jurisdiction IS NULL OR jurisdiction IN ('onshore', 'offshore'));
        ALTER TABLE stocks ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ${currencies});
        -- by ticker too: a very old database may still have crypto marked us_stock here
        -- (opening the database fixes asset_type only after the migrations)
        UPDATE stocks SET jurisdiction = 'offshore' WHERE asset_type = 'us_stock' AND ticker NOT LIKE 'X:%';

        ALTER TABLE transactions ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ${currencies});
        ALTER TABLE transactions ADD COLUMN fx TEXT;

        -- Final PTAX per trade date (never changes once final): saves asking the
        -- Banco Central again. Not user data; may be emptied at any time.
        CREATE TABLE ptax_cache (
          trade_date TEXT PRIMARY KEY,
          snapshot TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const DEFAULT_TAB = { name: "Ações", assetType: "us_stock", color: "#2962ff" } as const;
export const DEFAULT_PORTFOLIO = { name: "Carteira principal", color: "#2962ff" } as const;

/**
 * Every user has at least one portfolio, every portfolio at least one tab, and
 * every asset belongs to a tab of its own portfolio and type (created if
 * missing). Fixes assets without a tab (deleted tab, old backups). Idempotent;
 * runs at every start and after a restore.
 */
export function ensureDefaultTabs(db: DB) {
  if (!tableExists(db, "portfolios") || !tableHasColumn(db, "stocks", "portfolio_id")) return 0;

  // Make the type match the ticker format (rows written by very old versions).
  db.exec(`UPDATE stocks SET asset_type = 'crypto' WHERE ticker LIKE 'X:%' AND asset_type != 'crypto';`);

  const usersWithoutPortfolio = db
    .prepare(`SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM portfolios)`)
    .all() as Array<{ id: number }>;
  // An asset whose tab is missing or belongs to another portfolio is an orphan.
  const orphans = db
    .prepare(
      `SELECT DISTINCT s.user_id, s.portfolio_id, s.asset_type FROM stocks s
       LEFT JOIN tabs t ON t.id = s.tab_id AND t.portfolio_id = s.portfolio_id
       WHERE t.id IS NULL`
    )
    .all() as Array<{ user_id: number; portfolio_id: number; asset_type: string }>;
  const portfoliosWithoutTabs = () =>
    db
      .prepare(`SELECT id, user_id FROM portfolios WHERE id NOT IN (SELECT portfolio_id FROM tabs)`)
      .all() as Array<{ id: number; user_id: number }>;
  if (!usersWithoutPortfolio.length && !orphans.length && !portfoliosWithoutTabs().length) return 0;

  const now = new Date().toISOString();
  const insertPortfolio = db.prepare(
    `INSERT INTO portfolios (user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`
  );
  const findTab = db.prepare(
    `SELECT id FROM tabs WHERE portfolio_id = ? AND asset_type = ? ORDER BY sort_order, id LIMIT 1`
  );
  const nextOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tabs WHERE portfolio_id = ?`);
  const insertTab = db.prepare(
    `INSERT INTO tabs (user_id, portfolio_id, name, asset_type, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const assign = db.prepare(
    `UPDATE stocks SET tab_id = ?
     WHERE portfolio_id = ? AND asset_type = ?
       AND (tab_id IS NULL OR tab_id NOT IN (SELECT id FROM tabs WHERE portfolio_id = ?))`
  );

  const tabFor = (userId: number, portfolioId: number, assetType: string) => {
    const found = findTab.get(portfolioId, assetType) as { id: number } | undefined;
    if (found) return found.id;
    const isCrypto = assetType === "crypto";
    const order = (nextOrder.get(portfolioId) as { n: number }).n;
    return Number(
      insertTab.run(
        userId,
        portfolioId,
        isCrypto ? "Cripto" : DEFAULT_TAB.name,
        assetType,
        isCrypto ? "#f7931a" : DEFAULT_TAB.color,
        order,
        now
      ).lastInsertRowid
    );
  };

  let changed = 0;
  db.transaction(() => {
    for (const u of usersWithoutPortfolio) {
      insertPortfolio.run(u.id, DEFAULT_PORTFOLIO.name, DEFAULT_PORTFOLIO.color, now, now);
      changed++;
    }
    for (const p of portfoliosWithoutTabs()) {
      tabFor(p.user_id, p.id, DEFAULT_TAB.assetType);
      changed++;
    }
    for (const o of orphans) {
      changed += assign.run(tabFor(o.user_id, o.portfolio_id, o.asset_type), o.portfolio_id, o.asset_type, o.portfolio_id).changes;
    }
  })();
  return changed;
}

/**
 * Fills shares_dec/price_dec for rows that do not have them yet: rows migrated
 * from REAL, or rows written by an older version after a rollback. Idempotent.
 */
export function backfillDecimalColumns(db: DB) {
  if (!tableHasColumn(db, "transactions", "shares_dec")) return 0;

  const rows = db
    .prepare(`SELECT id, shares, price FROM transactions WHERE shares_dec IS NULL OR price_dec IS NULL`)
    .all() as Array<{ id: number; shares: number; price: number }>;
  if (rows.length === 0) return 0;

  const update = db.prepare(`UPDATE transactions SET shares_dec = ?, price_dec = ? WHERE id = ?`);
  db.transaction(() => {
    for (const row of rows) {
      update.run(decimalFromLegacyNumber(row.shares), decimalFromLegacyNumber(row.price), row.id);
    }
  })();
  return rows.length;
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** `upTo` stops at an older schema version (tests build old databases with it). */
export function migrate(db: DB, upTo = SCHEMA_VERSION) {
  const current = db.pragma("user_version", { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > upTo) continue;

    // Rebuilding a table with foreign keys ON would cascade-delete its children
    // when the old table is dropped. The pragma only works outside a transaction.
    const foreignKeysWereOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
    if (migration.rebuild) db.pragma("foreign_keys = OFF");
    try {
      const run = db.transaction(() => {
        migration.up(db);
        if (migration.rebuild) {
          const broken = db.pragma("foreign_key_check") as Array<{ table: string; rowid: number; parent: string }>;
          if (broken.length) {
            const sample = broken.slice(0, 5).map((b) => `${b.table}#${b.rowid}->${b.parent}`).join(", ");
            throw new Error(`Migration ${migration.version}: ${broken.length} broken foreign key(s): ${sample}`);
          }
        }
        db.pragma(`user_version = ${migration.version}`);
      });
      run();
    } finally {
      if (migration.rebuild && foreignKeysWereOn) db.pragma("foreign_keys = ON");
    }
  }

  if (upTo < SCHEMA_VERSION) return;
  backfillDecimalColumns(db);
  ensureDefaultTabs(db);
}

/**
 * Opens (or creates) the SQLite database. Pass ":memory:" for tests.
 */
export function openDatabase(file: string): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");

  migrate(db);
  return db;
}
