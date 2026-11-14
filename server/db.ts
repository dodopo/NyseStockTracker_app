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
 * Versioned, non-destructive migrations tracked with PRAGMA user_version.
 * Rule: never DROP a table that holds user data. Only the sessions table
 * (disposable login tokens) may be recreated.
 */
const MIGRATIONS: Array<{ version: number; up: (db: DB) => void }> = [
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
];

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

export function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    run();
  }

  backfillDecimalColumns(db);
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
